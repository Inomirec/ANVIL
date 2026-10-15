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
 * обычным видео. Браузеру пришлось бы иначе крутить несколько видео разом и
 * складывать их на лету, чего он не умеет.
 *
 * Видео — два, и играют они по очереди: пока одно показывает кусок, во второе
 * уже загружен следующий, и на стыке оно просто включается. С одним видео на
 * каждом стыке меняли источник, и между кусками мигал пустой кадр.
 *
 * Куски собираются впрок, один за другим, на `AHEAD_SECONDS` вперёд от
 * играющего: на слабой машине одного куска про запас не хватало — следующий
 * не успевал собраться, пока играет текущий.
 */
const CHUNK_SECONDS = 12
/** На сколько секунд вперёд держим собранные куски. */
const AHEAD_SECONDS = 60
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

type VideoRef = React.RefObject<HTMLVideoElement | null>

interface Graph {
  ctx: AudioContext
  splitter: ChannelSplitterNode
  gain: GainNode
  left: AnalyserNode
  right: AnalyserNode
  hooked: Set<HTMLVideoElement>
}

export function useComposePlayer(videos: [VideoRef, VideoRef]) {
  const [playing, setPlaying] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [levels, setLevels] = useState<MeterLevels>({ left: -60, right: -60 })
  /** Какое из двух видео сейчас на экране. */
  const [shown, setShown] = useState(0)
  const shownRef = useRef(0)
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

  /** Играющий кусок. */
  const chunk = useRef<Chunk | null>(null)
  /** Собранные впрок куски, по порядку. */
  const queue = useRef<Chunk[]>([])
  /** Собирается ли сейчас очередь — второй сборщик не нужен. */
  const filling = useRef(false)
  /**
   * Номер текущего просмотра. Растёт на каждом «играть» и на каждом «стоп»,
   * и по нему видно, что человек уже передумал: кусок монтажа готовится
   * секунду-другую, и всё это время ответ может оказаться никому не нужным.
   * Запоздавший ответ тогда не начинает играть и не жалуется на ошибку.
   */
  const run = useRef(0)
  const height = useRef(START_HEIGHT)
  const alive = useRef(true)

  // Звуковой граф: уровень снимаем до громкости прослушивания, чтобы ползунок
  // не влиял на показания шкалы. Оба видео идут в один граф.
  const audio = useRef<Graph | null>(null)

  const element = useCallback((index: number) => videos[index].current, [videos])

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

  /** Следующий кусок готов — загружаем его во второе видео заранее. */
  const preload = useCallback(() => {
    const next = queue.current[0]
    const spare = element(1 - shownRef.current)
    if (!next || !spare || spare.dataset.chunk === next.url) return
    spare.dataset.chunk = next.url
    spare.preload = 'auto'
    spare.src = next.url
    spare.load()
  }, [element])

  /** С какой секунды нужен следующий кусок после последнего собранного. */
  const nextStart = useCallback((): number | null => {
    const last = queue.current[queue.current.length - 1] ?? chunk.current
    if (!last) return null
    const at = last.at + last.span
    const finish = useCompose.getState().duration()
    if (at < finish - 0.05) return at
    // Дошли до конца: с повтором следующий кусок — снова с начала.
    return loopRef.current && last.at > 0 ? 0 : null
  }, [])

  /** Собирает куски впрок, один за другим, пока не наберётся запас. */
  const fill = useCallback(async () => {
    if (filling.current) return
    filling.current = true
    const mine = run.current
    try {
      while (alive.current && mine === run.current) {
        if (!chunk.current) break
        const ahead = queue.current.reduce((sum, item) => sum + item.span, 0)
        if (ahead >= AHEAD_SECONDS) break
        const at = nextStart()
        if (at === null) break
        const version = usePreviewReady.getState().version
        const next = await fetchChunk(at, mine)
        if (!next || mine !== run.current) break
        // Пока кусок собирался, монтаж поправили — он показывает уже не то.
        if (version !== usePreviewReady.getState().version) continue
        queue.current.push(next)
        preload()
      }
    } finally {
      filling.current = false
    }
  }, [fetchChunk, nextStart, preload])

  const hookAudio = useCallback((target: HTMLVideoElement) => {
    // Граф собираем один раз, а каждое видео подключаем к нему один раз:
    // повторное подключение браузер запрещает.
    try {
      if (!audio.current) {
        const ctx = new AudioContext()
        const splitter = ctx.createChannelSplitter(2)
        const left = ctx.createAnalyser()
        const right = ctx.createAnalyser()
        left.fftSize = 1024
        right.fftSize = 1024
        const gain = ctx.createGain()
        splitter.connect(left, 0)
        splitter.connect(right, 1)
        gain.connect(ctx.destination)
        audio.current = { ctx, splitter, gain, left, right, hooked: new Set() }
      }
      const graph = audio.current
      if (!graph.hooked.has(target)) {
        const source = graph.ctx.createMediaElementSource(target)
        source.connect(graph.splitter)
        source.connect(graph.gain)
        graph.hooked.add(target)
      }
    } catch {
      // Без звукового графа просмотр всё равно работает — не будет только
      // шкалы уровня.
    }
  }, [])

  const stop = useCallback(() => {
    run.current += 1
    setPlaying(false)
    setPreparing(false)
    setError(null)
    for (const index of [0, 1]) element(index)?.pause()
    queue.current = []
    setLevels({ left: -60, right: -60 })
    useCompose.getState().setPlayback(false)
  }, [element])

  /** Показывает кусок в видео ``index`` и запускает его с ``offset``. */
  const show = useCallback(
    async (next: Chunk, index: number, offset: number, mine: number): Promise<boolean> => {
      const target = element(index)
      if (!target) return false
      if (target.dataset.chunk !== next.url) {
        target.dataset.chunk = next.url
        target.src = next.url
      }
      target.currentTime = offset
      hookAudio(target)
      try {
        await target.play()
      } catch (problem) {
        if (mine === run.current) setError((problem as Error).message)
        return false
      }
      if (mine !== run.current) {
        target.pause()
        return false
      }
      chunk.current = next
      // Сначала второе видео ставим на паузу, потом меняем видимое: так на
      // стыке нет ни кадра без картинки, ни двух звуков разом.
      element(1 - index)?.pause()
      shownRef.current = index
      setShown(index)
      return true
    },
    [element, hookAudio],
  )

  const start = useCallback(async () => {
    const mine = ++run.current
    setError(null)
    setPreparing(true)
    queue.current = []
    const state = useCompose.getState()
    // Играет то, что под иглой. Метки I и O сюда не вмешиваются: они только
    // для готового файла.
    const finish = state.duration()
    let at = state.playhead
    // Игла осталась в самом конце — начинаем сначала, как любой плеер.
    if (at >= finish - 0.05) at = 0
    // Кусок — с ровной отметки, а играть — с иглы внутри него: так кусок,
    // однажды собранный, годится для просмотра с любого места в нём.
    const base = Math.floor(at / CHUNK_SECONDS) * CHUNK_SECONDS
    const first = await fetchChunk(base, mine)
    setPreparing(false)
    if (!first || !alive.current || mine !== run.current) return
    state.moveHead(at)
    if (!(await show(first, shownRef.current, Math.max(0, at - first.at), mine))) return
    // Белая игла встаёт на место, откуда начали.
    useCompose.getState().setPlayback(true)
    setPlaying(true)
    void fill()
  }, [fetchChunk, show, fill])

  /** Кусок доиграл — включаем следующий, он уже загружен во второе видео. */
  const onEnded = useCallback(
    async (index: number) => {
      if (index !== shownRef.current) return
      const mine = run.current
      let next = queue.current.shift() ?? null
      if (!next) {
        const at = nextStart()
        if (at === null) {
          stop()
          return
        }
        setPreparing(true)
        next = await fetchChunk(at, mine)
        setPreparing(false)
        if (mine !== run.current) return
        if (!next || !alive.current) {
          stop()
          return
        }
      }
      if (!(await show(next, 1 - index, 0, mine))) {
        if (mine === run.current) stop()
        return
      }
      preload()
      void fill()
    },
    [fetchChunk, nextStart, show, preload, fill, stop],
  )

  /** Пока играет — двигаем иглу и снимаем уровень. */
  useEffect(() => {
    if (!playing) return
    void audio.current?.ctx.resume()
    // Громкость слушателя живёт на узле графа: так шкала уровня показывает
    // сам монтаж, а не то, насколько тихо человек сделал себе в наушниках.
    // Если графа нет (браузер не дал), ставим её прямо видео.
    for (const index of [0, 1]) {
      const target = element(index)
      if (target) target.volume = audio.current ? 1 : volume
    }
    if (audio.current) audio.current.gain.gain.value = volume

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
      const target = element(shownRef.current)
      if (current && target) useCompose.getState().moveHead(current.at + target.currentTime)
      if (audio.current) {
        setLevels({ left: read(audio.current.left), right: read(audio.current.right) })
      }
    }, 60)
    return () => clearInterval(timer)
  }, [playing, volume, element])

  /**
   * Громкость монтажа и выравнивание слышны сразу.
   *
   * Обе настройки живут в куске, который собирает программа, поэтому уже
   * играющий кусок про них не знает: человек ставит галочку «выровнять звук»,
   * а шкала показывает прежнее — и решает, что галочка не работает. Поэтому на
   * такую правку просмотр пересобирается с того же места.
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
          // Собранное впрок показывает уже не то — следующие куски заново.
          queue.current = []
          const spare = element(1 - shownRef.current)
          if (spare) delete spare.dataset.chunk
        }
      }),
    [element],
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
    queue.current = []
  }, [quality])

  // Громкость прослушивания меняется на ходу и запоминается.
  useEffect(() => {
    if (audio.current) audio.current.gain.gain.value = volume
    else
      for (const index of [0, 1]) {
        const target = element(index)
        if (target) target.volume = volume
      }
    localStorage.setItem('sgh.composeVolume', String(volume))
  }, [volume, element])

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
    quality, setQuality, start, stop, onEnded, shown,
  }
}
