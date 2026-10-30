import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { loadPrefs } from '../lib/prefs'
import { useCompose } from '../composeStore'

interface Player {
  playing: boolean
  start: () => void | Promise<void>
  stop: () => void
}

/** Идущая запись — то, что рисуется на дорожке, пока человек говорит. */
export interface LiveRecording {
  /** С какой секунды монтажа ляжет запись. */
  at: number
  /** На какую дорожку. */
  trackId: string
  /** Сколько уже записано. */
  seconds: number
  /** Пики, по `PEAKS_PER_SECOND` на секунду, доли полной шкалы. */
  peaks: number[]
}

export interface VoiceRecording {
  /** Идёт запись. */
  active: boolean
  /** Запись остановлена и сохраняется. */
  saving: boolean
  /** Микрофон включён, но монтаж ещё не заиграл: говорить рано. */
  waiting: boolean
  /** Сколько секунд уже записано. */
  seconds: number
  live: LiveRecording | null
  start: () => void
  stop: () => void
}

/** Пиков волны на секунду — как у волны клипов на таймлайне. */
export const PEAKS_PER_SECOND = 40

/** Частота записи — как у звука монтажа. */
const RECORD_RATE = 48000

/** Сколько ждать, пока заиграет монтаж: не заиграл — пишем без него. */
const PLAYBACK_WAIT_MS = 10_000

/**
 * Снимает звук с микрофона отсчётами — без сжатия. Пачками по 2048 отсчётов:
 * по одному сообщению на каждые 128 было бы почти четыреста в секунду.
 */
const CAPTURE_WORKLET = `
class SghCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.parts = []
    this.size = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (input && input.length && input[0].length) {
      this.parts.push(input.map((channel) => channel.slice(0)))
      this.size += input[0].length
      if (this.size >= 2048) {
        this.port.postMessage(this.parts)
        this.parts = []
        this.size = 0
      }
    }
    return true
  }
}
registerProcessor('sgh-capture', SghCapture)
`

interface Session {
  stream: MediaStream
  context: AudioContext
  node: AudioWorkletNode
  rate: number
  pcm: Int16Array[]
  frames: number
  peaks: number[]
  bucket: { peak: number; fill: number }
  at: number
  trackId: string
  /** Пишем ли уже в файл. Под просмотр — только когда монтаж заиграл. */
  collecting: boolean
  withPlayback: boolean
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * Запись голоса с микрофона — прямо на таймлайн, с места иглы.
 *
 * Звук снимается без сжатия и без обработки браузером (подавление шума,
 * эха и автоусиление выключены — они портят голос) и сохраняется WAV:
 * моно, 48 кГц, 16 бит. Пока пишем, монтаж играет с иглы, а в
 * файл идёт только то, что записано после того, как он заиграл: иначе
 * голос лёг бы раньше того, что человек слышал. Игла в конце монтажа —
 * пишем сразу, без просмотра. Идущая запись видна на дорожке и растёт
 * вместе с волной (`live`).
 */
export function useVoiceRecorder(
  player: Player,
  options: {
    /** Папка для записей этого проекта. */
    folder: () => string
    /** Дорожка, на которую ляжет запись с секунды ``at``; заводит новую, если надо. */
    pickTrack: (at: number) => string | null
    onSaved: (path: string, at: number, trackId: string) => void
    onError: (text: string) => void
  },
): VoiceRecording {
  const [active, setActive] = useState(false)
  const [saving, setSaving] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [live, setLive] = useState<LiveRecording | null>(null)
  const session = useRef<Session | null>(null)
  const starting = useRef(false)
  // Обработчики живут дольше одного рендера — берём свежие через ссылки.
  const playerRef = useRef(player)
  playerRef.current = player
  const optionsRef = useRef(options)
  optionsRef.current = options

  const beginCollecting = useCallback(() => {
    const held = session.current
    if (!held || held.collecting) return
    held.collecting = true
    if (held.timer) clearTimeout(held.timer)
    held.timer = null
    setWaiting(false)
  }, [])

  // Монтаж заиграл — с этого мгновения звук идёт в файл.
  useEffect(() => {
    if (player.playing && session.current?.withPlayback) beginCollecting()
  }, [player.playing, beginCollecting])

  // Волна идущей записи — несколько раз в секунду, а не на каждую пачку.
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      const held = session.current
      if (!held) return
      setLive({
        at: held.at,
        trackId: held.trackId,
        seconds: held.frames / held.rate,
        peaks: held.peaks.slice(),
      })
    }, 150)
    return () => clearInterval(timer)
  }, [active])

  const release = useCallback((held: Session) => {
    if (held.timer) clearTimeout(held.timer)
    held.node.port.onmessage = null
    held.node.disconnect()
    held.stream.getTracks().forEach((track) => track.stop())
    void held.context.close().catch(() => undefined)
  }, [])

  // Ушли с вкладки посреди записи — отпускаем микрофон.
  useEffect(
    () => () => {
      const held = session.current
      session.current = null
      if (held) release(held)
    },
    [release],
  )

  const stop = useCallback(() => {
    const held = session.current
    if (!held) return
    session.current = null
    setActive(false)
    setWaiting(false)
    setLive(null)
    if (held.withPlayback) playerRef.current.stop()
    release(held)
    if (!held.frames) {
      optionsRef.current.onError('Запись пустая — микрофон ничего не передал')
      return
    }
    const blob = wavBlob(held.pcm, held.frames, 1, held.rate)
    setSaving(true)
    void (async () => {
      try {
        const { path } = await api.composeRecord(blob, optionsRef.current.folder())
        optionsRef.current.onSaved(path, held.at, held.trackId)
      } catch (error) {
        optionsRef.current.onError((error as Error).message)
      } finally {
        setSaving(false)
      }
    })()
  }, [release])

  const start = useCallback(async () => {
    if (session.current || starting.current || saving) return
    starting.current = true
    try {
      const device = loadPrefs().micDevice
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(device ? { deviceId: { exact: device } } : {}),
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        })
      } catch (error) {
        const name = (error as Error).name
        optionsRef.current.onError(
          name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'Микрофон не найден. Подключите его или выберите другой в настройках программы'
            : name === 'NotAllowedError'
              ? 'Windows не даёт программе микрофон. Откройте «Параметры» → «Конфиденциальность и защита» → «Микрофон» и включите «Разрешить классическим приложениям доступ к микрофону»'
              : `Не удалось включить микрофон: ${(error as Error).message}`,
        )
        return
      }

      // 48 кГц — частота видео и звука монтажа. Без неё браузер берёт
      // частоту звуковой карты, а она бывает и 192 кГц: файл вчетверо
      // тяжелее, а голосу это ничего не даёт.
      const context = new AudioContext({ sampleRate: RECORD_RATE })
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }))
      try {
        await context.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const node = new AudioWorkletNode(context, 'sgh-capture')
      const source = context.createMediaStreamSource(stream)
      // Узел работает, только пока его слушают: ведём его в тишину, а не в
      // колонки — иначе человек слышал бы сам себя с задержкой.
      const mute = context.createGain()
      mute.gain.value = 0
      source.connect(node)
      node.connect(mute)
      mute.connect(context.destination)

      const state = useCompose.getState()
      const at = state.playhead
      const trackId = optionsRef.current.pickTrack(at)
      if (!trackId) {
        stream.getTracks().forEach((track) => track.stop())
        void context.close()
        return
      }
      const withPlayback = at < state.duration() - 0.05
      const held: Session = {
        stream,
        context,
        node,
        rate: context.sampleRate,
        pcm: [],
        frames: 0,
        peaks: [],
        bucket: { peak: 0, fill: 0 },
        at,
        trackId,
        collecting: !withPlayback,
        withPlayback,
        timer: null,
      }
      const perPeak = Math.max(1, Math.round(held.rate / PEAKS_PER_SECOND))
      node.port.onmessage = (event: MessageEvent<Float32Array[][]>) => {
        if (session.current !== held || !held.collecting) return
        for (const part of event.data) {
          if (!part.length) continue
          const frames = part[0].length
          const out = new Int16Array(frames)
          for (let index = 0; index < frames; index++) {
            // Голос — моно: каналы микрофона сводятся в один. У USB-микрофона
            // они обычно одинаковые, и второй только удвоил бы файл.
            let sum = 0
            for (const channel of part) sum += channel[index]
            const sample = Math.max(-1, Math.min(1, sum / part.length))
            out[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
            held.bucket.peak = Math.max(held.bucket.peak, Math.abs(sample))
            if (++held.bucket.fill >= perPeak) {
              held.peaks.push(held.bucket.peak)
              held.bucket = { peak: 0, fill: 0 }
            }
          }
          held.pcm.push(out)
          held.frames += frames
        }
      }
      session.current = held
      setActive(true)
      setWaiting(withPlayback)
      setLive({ at, trackId, seconds: 0, peaks: [] })
      if (withPlayback) {
        // Монтаж так и не заиграл (ошибка сборки куска) — пишем без него,
        // а не висим с «готовлю…».
        held.timer = setTimeout(beginCollecting, PLAYBACK_WAIT_MS)
        if (playerRef.current.playing) playerRef.current.stop()
        void playerRef.current.start()
      }
    } catch (error) {
      optionsRef.current.onError(`Не удалось начать запись: ${(error as Error).message}`)
    } finally {
      starting.current = false
    }
  }, [saving, beginCollecting])

  return {
    active,
    saving,
    waiting,
    seconds: live?.seconds ?? 0,
    live,
    start: () => void start(),
    stop,
  }
}

/** WAV из готовых кусков: заголовок на 44 байта и отсчёты подряд. */
function wavBlob(parts: Int16Array[], frames: number, channels: number, rate: number): Blob {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const bytes = frames * channels * 2
  const text = (at: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(at + index, value.charCodeAt(index))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + bytes, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, bytes, true)
  return new Blob([header, ...parts.map((part) => part.buffer as ArrayBuffer)], { type: 'audio/wav' })
}
