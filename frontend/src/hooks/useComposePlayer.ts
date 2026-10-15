import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { api } from '../lib/api'
import { useCompose } from '../composeStore'
import type { MeterLevels } from '../components/MasterMeter'

/**
 * Воспроизведение монтажа.
 *
 * Снаружи это обычный плеер: нажали «играть» — пошло со звуком. Внутри
 * программа собирает кусок монтажа настоящим кодировщиком и играет его
 * обычным видео, а пока он идёт — готовит следующий. Иначе браузеру пришлось
 * бы крутить несколько видео разом и складывать их на лету, чего он не умеет.
 *
 * Длина куска — компромисс: короткий готовится быстрее, но чаще требует
 * подготовки следующего; на длинном дольше ждёшь первого кадра.
 */
const CHUNK_SECONDS = 12
/** С какого качества начинаем. На слабой машине программа понизит сама. */
const START_HEIGHT = 540
const MIN_HEIGHT = 288
/** Дольше этого ждать первый кадр нельзя — берём качество помельче. */
const SLOW_SECONDS = 2.5

/**
 * Качество просмотра. «Авто» начинает с середины и понижает само, если
 * машина не успевает; остальные значения программа не трогает — человек
 * выбрал и получил.
 */
export type PreviewQuality = 'auto' | 360 | 480 | 720
const QUALITY_KEY = 'sgh.composeQuality'

interface Chunk {
  url: string
  at: number
  span: number
}

/**
 * Какие куски монтажа уже собраны для просмотра — тонкая полоска на линейке.
 * Собранный кусок программа отдаёт из запаса мгновенно, поэтому по полоске
 * видно, что этот отрезок будет играть без ожидания. Любая правка монтажа
 * полоску сбрасывает: прежние куски показывают уже не то.
 */
export const usePreviewReady = create<{
  ranges: { at: number; span: number }[]
  version: number
  add: (at: number, span: number, version: number) => void
  clear: () => void
}>((set, get) => ({
  ranges: [],
  version: 0,
  add(at, span, version) {
    if (version !== get().version) return
    if (get().ranges.some((range) => Math.abs(range.at - at) < 0.01)) return
    set({ ranges: [...get().ranges, { at, span }] })
  },
  clear() {
    set({ ranges: [], version: get().version + 1 })
  },
}))

export function useComposePlayer(video: React.RefObject<HTMLVideoElement | null>) {
  const [playing, setPlaying] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [levels, setLevels] = useState<MeterLevels>({ left: -60, right: -60 })
  const [volume, setVolume] = useState(() => {
    const saved = Number(localStorage.getItem('sgh.composeVolume'))
    return Number.isFinite(saved) && saved > 0 ? Math.min(1, saved) : 0.8
  })

  const [quality, setQuality] = useState<PreviewQuality>(() => {
    const saved = localStorage.getItem(QUALITY_KEY)
    return saved === '360' || saved === '480' || saved === '720'
      ? (Number(saved) as PreviewQuality)
      : 'auto'
  })
  const qualityRef = useRef<PreviewQuality>(quality)
  qualityRef.current = quality

  const [loop, setLoop] = useState(false)
  const loopRef = useRef(false)
  loopRef.current = loop

  const chunk = useRef<Chunk | null>(null)
  const ahead = useRef<Chunk | null>(null)
  /**
   * Номер текущего просмотра. Растёт на каждом «играть» и на каждом «стоп»,
   * и по нему видно, что человек уже передумал: кусок монтажа готовится
   * секунду-другую, и всё это время ответ может оказаться никому не нужным.
   * Запоздавший ответ тогда не начинает играть и не жалуется на ошибку —
   * раньше отменённый просмотр отвечал «Failed to load because no supported
   * source was found».
   */
  const run = useRef(0)
  const height = useRef(START_HEIGHT)
  const alive = useRef(true)

  // Звуковой граф: уровень снимаем до громкости прослушивания, чтобы ползунок
  // не влиял на показания шкалы.
  const audio = useRef<{
    ctx: AudioContext
    gain: GainNode
    left: AnalyserNode
    right: AnalyserNode
  } | null>(null)

  const snapshot = useCallback(() => {
    const state = useCompose.getState()
    return {
      width: state.width,
      height: state.height,
      fps: state.fps,
      // Громкость монтажа и выравнивание идут и в просмотр: иначе на слух
      // он отличался бы от готового файла.
      masterVolume: state.masterVolume,
      loudnorm: state.loudnorm,
      tracks: state.tracks,
    }
  }, [])

  /** Просит у программы кусок монтажа с указанной секунды. */
  const fetchChunk = useCallback(
    async (at: number, mine: number): Promise<Chunk | null> => {
      const started = performance.now()
      const version = usePreviewReady.getState().version
      try {
        const asked = qualityRef.current
        const data = await api.composeDraft({
          project: snapshot(),
          at,
          span: CHUNK_SECONDS,
          height: asked === 'auto' ? height.current : asked,
        })
        // Собиралось долго — дальше берём кадр помельче. Человек этого не
        // видит, зато просмотр перестаёт спотыкаться на слабой машине. Если
        // качество выбрано руками, ничего не подбираем: выбор есть выбор.
        const spent = (performance.now() - started) / 1000
        if (asked === 'auto' && spent > SLOW_SECONDS && height.current > MIN_HEIGHT) {
          height.current = Math.max(MIN_HEIGHT, Math.round(height.current / 1.5))
          // Следующие куски будут мельче — собранные крупные уже не пригодятся.
          usePreviewReady.getState().clear()
        } else {
          usePreviewReady.getState().add(data.at, data.span, version)
        }
        if (data.missing?.length) useCompose.getState().reportMissing(data.missing)
        return { url: data.url, at: data.at, span: data.span }
      } catch (problem) {
        // Об ошибке говорим, только если её ещё ждут.
        if (mine === run.current) setError((problem as Error).message)
        return null
      }
    },
    [snapshot],
  )

  /** Готовит следующий кусок, пока играет текущий. */
  const prefetch = useCallback(
    async (at: number) => {
      const duration = useCompose.getState().duration()
      if (at >= duration - 0.05) {
        ahead.current = null
        return
      }
      const next = await fetchChunk(at, run.current)
      if (alive.current) ahead.current = next
    },
    [fetchChunk],
  )

  const stop = useCallback(() => {
    run.current += 1
    setPlaying(false)
    setPreparing(false)
    setError(null)
    const element = video.current
    if (element) element.pause()
    setLevels({ left: -60, right: -60 })
  }, [video])

  const start = useCallback(async () => {
    const element = video.current
    if (!element) return
    const mine = ++run.current
    setError(null)
    setPreparing(true)
    const state = useCompose.getState()
    // Играет то, что под иглой. Метки I и O сюда не вмешиваются: они только
    // для готового файла. Прежде просмотр начинался с метки начала, и метка,
    // оставшаяся за концом монтажа, не давала смотреть вовсе.
    const finish = state.duration()
    let at = state.playhead
    // Игла осталась в самом конце — начинаем сначала, как любой плеер.
    // Иначе нажатие на «играть» не делало ничего: показывать уже нечего.
    if (at >= finish - 0.05) at = 0
    // Кусок — с ровной отметки, а играть — с иглы внутри него: так кусок,
    // однажды собранный, годится для просмотра с любого места в нём.
    const base = Math.floor(at / CHUNK_SECONDS) * CHUNK_SECONDS
    const first = await fetchChunk(base, mine)
    setPreparing(false)
    // Пока кусок готовился, человек мог нажать «стоп» — тогда молча уходим.
    if (!first || !alive.current || mine !== run.current) return

    chunk.current = first
    ahead.current = null
    element.src = first.url
    element.currentTime = Math.max(0, at - first.at)
    try {
      await element.play()
      if (mine !== run.current) return
      setPlaying(true)
      void prefetch(first.at + first.span)
    } catch (problem) {
      if (mine === run.current) setError((problem as Error).message)
    }
  }, [fetchChunk, prefetch, video])

  /** Кусок доиграл — подставляем следующий, если он готов. */
  const onEnded = useCallback(async () => {
    const element = video.current
    if (!element) return
    const mine = run.current
    const state = useCompose.getState()
    const current = chunk.current
    let nextAt = current ? current.at + current.span : 0

    // Дошли до конца монтажа — с повтором начинаем сначала, без повтора
    // просто останавливаемся.
    const finish = state.duration()
    if (nextAt >= finish - 0.05) {
      if (!loopRef.current) {
        stop()
        return
      }
      nextAt = 0
      ahead.current = null
    }

    let next = ahead.current
    if (!next) {
      setPreparing(true)
      next = await fetchChunk(nextAt, mine)
      setPreparing(false)
    }
    if (mine !== run.current) return
    if (!next || !alive.current) {
      stop()
      return
    }
    chunk.current = next
    ahead.current = null
    element.src = next.url
    element.currentTime = 0
    await element.play().catch(() => stop())
    void prefetch(next.at + next.span)
  }, [fetchChunk, prefetch, stop, video])

  /** Пока играет — двигаем иглу и снимаем уровень. */
  useEffect(() => {
    if (!playing) return
    const element = video.current
    if (!element) return

    // Граф собираем один раз на элемент: повторный вызов браузер запрещает.
    if (!audio.current) {
      try {
        const ctx = new AudioContext()
        const source = ctx.createMediaElementSource(element)
        const splitter = ctx.createChannelSplitter(2)
        const left = ctx.createAnalyser()
        const right = ctx.createAnalyser()
        left.fftSize = 1024
        right.fftSize = 1024
        const gain = ctx.createGain()
        source.connect(splitter)
        splitter.connect(left, 0)
        splitter.connect(right, 1)
        source.connect(gain)
        gain.connect(ctx.destination)
        audio.current = { ctx, gain, left, right }
      } catch {
        // Без звукового графа просмотр всё равно работает — не будет только
        // шкалы уровня.
      }
    }
    void audio.current?.ctx.resume()
    // Громкость слушателя живёт на узле графа: так шкала уровня показывает
    // сам монтаж, а не то, насколько тихо человек сделал себе в наушниках.
    // Если графа нет (браузер не дал), ставим её прямо элементу — иначе
    // ползунок не делал бы ничего вовсе.
    if (audio.current) {
      audio.current.gain.gain.value = volume
      element.volume = 1
    } else {
      element.volume = volume
    }

    const buffer = new Float32Array(1024)
    const read = (node: AnalyserNode): number => {
      node.getFloatTimeDomainData(buffer)
      let sum = 0
      for (const value of buffer) sum += value * value
      const rms = Math.sqrt(sum / buffer.length)
      return rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60
    }

    // Обычный таймер, а не кадры отрисовки: в свёрнутом окне кадры не
    // приходят вовсе, и игла замирала бы вместе с показаниями.
    const timer = setInterval(() => {
      const current = chunk.current
      if (current) useCompose.getState().setPlayhead(current.at + element.currentTime)
      if (audio.current) {
        setLevels({ left: read(audio.current.left), right: read(audio.current.right) })
      }
    }, 60)
    return () => clearInterval(timer)
  }, [playing, volume, video])

  /**
   * Громкость монтажа и выравнивание слышны сразу.
   *
   * Обе настройки живут в куске, который собирает программа, поэтому уже
   * играющий кусок про них не знает: человек ставит галочку «выровнять звук»,
   * а шкала показывает прежнее — и решает, что галочка не работает. Поэтому на
   * такую правку просмотр пересобирается с того же места. Небольшая задержка
   * есть, но она честнее, чем неверные показания.
   *
   * Ждём немного: у фейдера на одно движение приходится десяток изменений, и
   * пересобирать кусок на каждое незачем.
   */
  const playingRef = useRef(false)
  playingRef.current = playing
  const startRef = useRef(start)
  startRef.current = start

  useEffect(
    () =>
      useCompose.subscribe((state, prev) => {
        if (
          state.tracks !== prev.tracks ||
          state.width !== prev.width ||
          state.height !== prev.height ||
          state.fps !== prev.fps ||
          state.masterVolume !== prev.masterVolume ||
          state.loudnorm !== prev.loudnorm
        ) {
          usePreviewReady.getState().clear()
        }
      }),
    [],
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = useCompose.subscribe((state, prev) => {
      if (state.masterVolume === prev.masterVolume && state.loudnorm === prev.loudnorm) return
      if (!playingRef.current) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (playingRef.current) void startRef.current()
      }, 400)
    })
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [])

  // Выбранное качество запоминается; «авто» начинает подбор заново.
  useEffect(() => {
    localStorage.setItem(QUALITY_KEY, String(quality))
    height.current = quality === 'auto' ? START_HEIGHT : quality
    usePreviewReady.getState().clear()
  }, [quality])

  // Громкость прослушивания меняется на ходу и запоминается.
  useEffect(() => {
    if (audio.current) audio.current.gain.gain.value = volume
    else if (video.current) video.current.volume = volume
    localStorage.setItem('sgh.composeVolume', String(volume))
  }, [volume, video])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      void audio.current?.ctx.close()
      audio.current = null
    }
  }, [])

  return {
    playing, preparing, error, levels, volume, setVolume, loop, setLoop,
    quality, setQuality, start, stop, onEnded,
  }
}
