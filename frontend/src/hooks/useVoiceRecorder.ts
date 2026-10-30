import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useCompose } from '../composeStore'

interface Player {
  playing: boolean
  start: () => void | Promise<void>
  stop: () => void
}

export interface VoiceRecording {
  /** Идёт запись. */
  active: boolean
  /** Запись остановлена и сохраняется. */
  saving: boolean
  /** Микрофон уже пишет, но монтаж ещё не заиграл: говорить рано — это
   *  начало потом отрежется. */
  waiting: boolean
  /** Сколько секунд уже записано. */
  seconds: number
  /** Начать запись или остановить её. */
  toggle: () => void
}

interface Session {
  recorder: MediaRecorder
  stream: MediaStream
  chunks: Blob[]
  /** С какой секунды монтажа начали. */
  at: number
  /** Когда запись началась и когда заиграл монтаж (`performance.now`). */
  began: number
  played: number | null
  /** Монтаж играет под запись: игла стояла не в самом конце. */
  withPlayback: boolean
}

/**
 * Запись голоса с микрофона — прямо на таймлайн, с места иглы.
 *
 * Пока пишем, монтаж играет с того же места: так голос накладывают на
 * картинку. Просмотр начинается не сразу — первый кусок ещё собирается, —
 * поэтому всё, что записано до того, как монтаж заиграл, отрезается
 * (`trim`): иначе голос лёг бы раньше того, что человек слышал. Игла в
 * конце монтажа — пишем без просмотра, с конца.
 *
 * Готовую запись сервер сохраняет в папку «Записи» рабочей папки, а клип
 * ставит `onSaved`.
 */
export function useVoiceRecorder(
  player: Player,
  onSaved: (path: string, at: number, trim: number) => void,
  onError: (text: string) => void,
): VoiceRecording {
  const [active, setActive] = useState(false)
  const [saving, setSaving] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const session = useRef<Session | null>(null)
  // Обработчики живут дольше одного рендера — берём свежие через ссылки.
  const playerRef = useRef(player)
  playerRef.current = player
  const savedRef = useRef(onSaved)
  savedRef.current = onSaved
  const errorRef = useRef(onError)
  errorRef.current = onError

  // Монтаж заиграл — запоминаем, сколько записи было до этого.
  useEffect(() => {
    const held = session.current
    if (held && held.withPlayback && player.playing && held.played === null) {
      held.played = performance.now()
      setSeconds(0)
      setWaiting(false)
    }
  }, [player.playing])

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      const held = session.current
      // Время — с того мгновения, с которого запись ляжет на таймлайн.
      if (held) setSeconds(Math.max(0, (performance.now() - (held.played ?? held.began)) / 1000))
    }, 200)
    return () => clearInterval(timer)
  }, [active])

  // Ушли с вкладки посреди записи — отпускаем микрофон.
  useEffect(
    () => () => {
      const held = session.current
      session.current = null
      if (!held) return
      held.recorder.onstop = null
      if (held.recorder.state !== 'inactive') held.recorder.stop()
      held.stream.getTracks().forEach((track) => track.stop())
    },
    [],
  )

  const stop = useCallback(() => {
    const held = session.current
    if (!held) return
    session.current = null
    setActive(false)
    setWaiting(false)
    if (held.withPlayback) playerRef.current.stop()
    held.recorder.onstop = async () => {
      held.stream.getTracks().forEach((track) => track.stop())
      const blob = new Blob(held.chunks, { type: held.recorder.mimeType || 'audio/webm' })
      if (!blob.size) {
        errorRef.current('Запись пустая — микрофон ничего не передал')
        return
      }
      setSaving(true)
      try {
        const { path } = await api.composeRecord(blob)
        const trim = held.played !== null ? Math.max(0, (held.played - held.began) / 1000) : 0
        savedRef.current(path, held.at, trim)
      } catch (error) {
        errorRef.current((error as Error).message)
      } finally {
        setSaving(false)
      }
    }
    held.recorder.stop()
  }, [])

  const start = useCallback(async () => {
    if (session.current || saving) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (error) {
      const name = (error as Error).name
      errorRef.current(
        name === 'NotFoundError'
          ? 'Микрофон не найден. Подключите его и попробуйте снова'
          : name === 'NotAllowedError'
            ? 'Нет доступа к микрофону. Разрешите его в параметрах Windows: Конфиденциальность и защита → Микрофон → «Разрешить классическим приложениям доступ к микрофону»'
            : `Не удалось включить микрофон: ${(error as Error).message}`,
      )
      return
    }
    const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
    const recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 160000 } : undefined)
    const state = useCompose.getState()
    const at = state.playhead
    const held: Session = {
      recorder,
      stream,
      chunks: [],
      at,
      began: performance.now(),
      played: null,
      withPlayback: at < state.duration() - 0.05,
    }
    recorder.ondataavailable = (event) => {
      if (event.data.size) held.chunks.push(event.data)
    }
    session.current = held
    recorder.start(1000)
    held.began = performance.now()
    setSeconds(0)
    setActive(true)
    setWaiting(held.withPlayback)
    if (held.withPlayback) {
      if (playerRef.current.playing) playerRef.current.stop()
      void playerRef.current.start()
    }
  }, [saving])

  const toggle = useCallback(() => {
    if (session.current) stop()
    else void start()
  }, [start, stop])

  return { active, saving, waiting, seconds, toggle }
}
