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
 * Звук и картинка идут раздельно. Звук каждого куска программа отдаёт
 * отдельным несжатым файлом ровно нужной длины, и куски ставятся в очередь
 * звуковой карты встык, с точностью до отсчёта: пока звук жил внутри видео,
 * на каждом стыке выходил провал — видео заканчивалось, следующее ещё
 * только запускалось. Теперь звук — это часы просмотра: по ним идёт игла, и
 * под них подстраиваются видео.
 *
 * Видео — два, и играют по очереди: пока одно показывает кусок, во второе
 * уже загружен следующий и стоит на первом кадре. На стыке (по тем же
 * звуковым часам) оно становится видимым и запускается.
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
export type PreviewQuality = 'auto' | 360 | 480 | 720 | 1080
export const PREVIEW_QUALITIES = [360, 480, 720, 1080] as const
const QUALITY_KEY = 'sgh.composeQuality'

interface Chunk {
  url: string
  /** Звук куска, уже разобранный; ``null`` — в куске тишина. */
  sound: AudioBuffer | null
  at: number
  span: number
}

/** Кусок, поставленный играть: когда по звуковым часам и в каком видео. */
interface Slot {
  chunk: Chunk
  index: number
  /** Время звуковых часов, на котором играет секунда ``offset`` куска. */
  begin: number
  offset: number
  source: AudioBufferSourceNode | null
}

/** Расхождение видео со звуком, дальше которого видео перематывается. */
const DRIFT_JUMP = 0.25

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
}

/** Снимает звук куска с очереди звуковой карты. */
function silence(slot: Slot | null) {
  if (!slot?.source) return
  try {
    slot.source.stop()
  } catch {
    // Уже остановлен.
  }
  slot.source.disconnect()
}

/**
 * Высота кадра просмотра. Выше качества проекта не собираем — крупнее он не
 * станет; у «Своего» размера — сколько выбрали.
 */
function previewHeight(asked: number): number {
  const { custom, quality, width, height } = useCompose.getState()
  if (custom) return asked
  // Качество проекта — короткая сторона, а здесь высота кадра.
  return Math.round((Math.min(asked, quality) * height) / Math.min(width, height))
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
    return saved === '360' || saved === '480' || saved === '720' || saved === '1080'
      ? (Number(saved) as PreviewQuality)
      : 'auto'
  })
  const qualityRef = useRef<PreviewQuality>(quality)
  qualityRef.current = quality

  const [loop, setLoop] = useState(false)
  const loopRef = useRef(false)
  loopRef.current = loop

  /** Играющий кусок и следующий, уже поставленный встык. */
  const current = useRef<Slot | null>(null)
  const upcoming = useRef<Slot | null>(null)
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
  /**
   * Отзыв запросов кусков прежнего просмотра. Сервер собирает куски по
   * одному, и брошенные запросы иначе стояли в очереди впереди нового
   * просмотра: остановили, подвинули клип, нажали «играть» — и ждали, пока
   * доделаются куски, которые уже никто не покажет (до 10–20 секунд).
   */
  const aborter = useRef(new AbortController())
  const dropRequests = useCallback(() => {
    aborter.current.abort()
    aborter.current = new AbortController()
  }, [])
  const height = useRef(START_HEIGHT)
  const alive = useRef(true)

  // Звуковой граф: уровень снимаем до громкости прослушивания, чтобы ползунок
  // не влиял на показания шкалы. Звук всех кусков идёт в один граф.
  const audio = useRef<Graph | null>(null)

  const element = useCallback((index: number) => videos[index].current, [videos])

  const graph = useCallback((): Graph => {
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
      audio.current = { ctx, splitter, gain, left, right }
    }
    return audio.current
  }, [])

  const snapshot = useCallback(() => {
    const state = useCompose.getState()
    return {
      width: state.width,
      height: state.height,
      fps: state.fps,
      // Громкость монтажа идёт и в просмотр: иначе на слух он отличался бы
      // от готового файла. Выравнивание громкости всего монтажа — нет: оно
      // подстраивается заново в начале каждого куска, и на стыках громкость
      // прыгала. Оно для готового файла; услышать выравнивание в просмотре —
      // эффекты выравнивания у клипа или дорожки.
      masterVolume: state.masterVolume,
      tracks: state.tracks,
    }
  }, [])

  /**
   * Где кончается круг повтора для просмотра, идущего с секунды ``from``.
   *
   * С повтором и отмеченной областью (метки I и O) круг — сама область: до
   * её конца — и снова к началу. Просмотр, начатый до области, идёт как шёл
   * и попадает в круг, дойдя до её конца. Начатый после области идёт до
   * конца монтажа и начинает сначала — а там уже дойдёт и до области.
   */
  const loopRange = useCallback((from: number): { start: number; end: number } | null => {
    if (!loopRef.current) return null
    const state = useCompose.getState()
    if (state.renderIn === null && state.renderOut === null) return null
    const start = state.renderIn ?? 0
    const end = state.renderOut ?? state.duration()
    if (end - start < 0.1 || from >= end - 0.05) return null
    return { start, end }
  }, [])

  /** Просит у программы кусок монтажа с указанной секунды. */
  const fetchChunk = useCallback(
    async (at: number, mine: number, from = at): Promise<Chunk | null> => {
      const started = performance.now()
      const version = usePreviewReady.getState().version
      try {
        const asked = qualityRef.current
        const data = await api.composeDraft(
          {
          project: snapshot(),
          at,
          // Кусок, на котором кончается круг повтора, — ровно до его конца.
          span: Math.min(CHUNK_SECONDS, (loopRange(from)?.end ?? Infinity) - at),
          height: previewHeight(asked === 'auto' ? height.current : asked),
          },
          aborter.current.signal,
        )
        let sound: AudioBuffer | null = null
        if (data.audio) {
          const bytes = await (await fetch(data.audio)).arrayBuffer()
          // С вкладки ушли, пока кусок собирался, — звуковой граф уже закрыт,
          // и заводить новый незачем.
          if (!alive.current) return null
          sound = await graph().ctx.decodeAudioData(bytes)
        }
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
        return { url: data.url, sound, at: data.at, span: data.span }
      } catch (problem) {
        // Об ошибке говорим, только если её ещё ждут. Отозванный запрос —
        // не ошибка.
        if (mine === run.current && (problem as Error).name !== 'AbortError') {
          setError((problem as Error).message)
        }
        return null
      }
    },
    [snapshot, graph, loopRange],
  )

  /** Ставит звук куска на звуковые часы: секунда ``offset`` — в момент ``when``. */
  const sound = useCallback(
    (chunk: Chunk, when: number, offset: number): AudioBufferSourceNode | null => {
      if (!chunk.sound || !alive.current) return null
      const { ctx, splitter, gain } = graph()
      const source = ctx.createBufferSource()
      source.buffer = chunk.sound
      source.connect(splitter)
      source.connect(gain)
      // Опоздали к нужному моменту — догоняем с того места, где звук был бы.
      const late = Math.max(0, ctx.currentTime - when)
      source.start(when + late, offset + late)
      return source
    },
    [graph],
  )

  /** Загружает кусок в видео и ставит на нужное место, не запуская. */
  const load = useCallback(
    (index: number, chunk: Chunk, offset: number) => {
      const target = element(index)
      if (!target) return
      if (target.dataset.chunk !== chunk.url) {
        target.dataset.chunk = chunk.url
        target.preload = 'auto'
        target.src = chunk.url
      }
      if (Math.abs(target.currentTime - offset) > 0.01) target.currentTime = offset
    },
    [element],
  )

  /** Следующий кусок готов — загружаем его во второе видео заранее. */
  const preload = useCallback(() => {
    const next = queue.current[0]
    if (next && !upcoming.current) load(1 - shownRef.current, next, 0)
  }, [load])

  /** С какой секунды нужен следующий кусок после последнего собранного. */
  const nextStart = useCallback((): number | null => {
    const last =
      queue.current[queue.current.length - 1] ?? upcoming.current?.chunk ?? current.current?.chunk
    if (!last) return null
    const at = last.at + last.span
    // Дошли до конца круга повтора — следующий кусок с его начала.
    const range = loopRange(last.at)
    if (range && at >= range.end - 0.05) return range.start
    const finish = useCompose.getState().duration()
    if (at < finish - 0.05) return at
    // Дошли до конца: с повтором следующий кусок — снова с начала.
    return loopRef.current && last.at > 0 ? 0 : null
  }, [loopRange])

  /**
   * Ставит следующий кусок встык за играющим: звук — сразу на звуковые часы,
   * видео — во второе видео на первый кадр. Включит его `swap`.
   */
  const schedule = useCallback(() => {
    const playing = current.current
    if (!playing || upcoming.current) return
    const next = queue.current.shift()
    if (!next) return
    const index = 1 - playing.index
    load(index, next, 0)
    const { ctx } = graph()
    // Кусок не успел к стыку — начнём его чуть позже, чем сейчас.
    const begin = Math.max(
      playing.begin + playing.chunk.span - playing.offset,
      ctx.currentTime + 0.05,
    )
    upcoming.current = { chunk: next, index, begin, offset: 0, source: sound(next, begin, 0) }
  }, [graph, load, sound])

  /** Собирает куски впрок, один за другим, пока не наберётся запас. */
  const fill = useCallback(async () => {
    if (filling.current) return
    filling.current = true
    const mine = run.current
    try {
      while (alive.current && mine === run.current) {
        if (!current.current) break
        const ahead = queue.current.reduce((sum, item) => sum + item.span, 0)
        if (ahead >= AHEAD_SECONDS) break
        const at = nextStart()
        if (at === null) break
        const version = usePreviewReady.getState().version
        const next = await fetchChunk(at, mine)
        if (!next || mine !== run.current || !alive.current) break
        // Пока кусок собирался, монтаж поправили — он показывает уже не то.
        if (version !== usePreviewReady.getState().version) continue
        queue.current.push(next)
        schedule()
        preload()
      }
    } finally {
      filling.current = false
    }
  }, [fetchChunk, nextStart, schedule, preload])

  const fillRef = useRef(fill)
  fillRef.current = fill

  const stop = useCallback(() => {
    run.current += 1
    dropRequests()
    setPlaying(false)
    setPreparing(false)
    setError(null)
    for (const index of [0, 1]) element(index)?.pause()
    silence(current.current)
    silence(upcoming.current)
    current.current = null
    upcoming.current = null
    queue.current = []
    setLevels({ left: -60, right: -60 })
    useCompose.getState().setPlayback(false)
  }, [element])

  /** Видимым становится видео ``index``, второе прячется. */
  const reveal = useCallback(
    (index: number) => {
      // Прямо в разметке, не дожидаясь отрисовки: иначе на стыке мелькал бы
      // кадр-другой не того видео. Прячем прозрачностью, а не `visibility`:
      // спрятанное так видео браузер не рисует вовсе, и в первый миг после
      // показа на месте кадра был чёрный.
      element(index)?.classList.remove('opacity-0')
      element(1 - index)?.classList.add('opacity-0')
      shownRef.current = index
      setShown(index)
    },
    [element],
  )

  /** Стык: включаем следующий кусок, уже стоящий во втором видео. */
  const swap = useCallback(() => {
    const next = upcoming.current
    if (!next) return
    const before = current.current
    current.current = next
    upcoming.current = null
    const target = element(next.index)
    void target?.play().catch(() => undefined)
    // Следующий кусок ещё не вывел ни кадра — пусть до того стоит последний
    // кадр прежнего: открой мы пустое видео сразу, на стыке мигал бы чёрный.
    // Следующий за ним кусок грузится в прежнее видео — тоже только после
    // этого, иначе оно погасло бы, ещё будучи на экране.
    const outgoing = element(1 - next.index)
    // Звук прежнего куска уже кончился сам; на всякий случай снимаем его.
    silence(before)
    setPreparing(false)
    let done = false
    const show = () => {
      if (done || current.current !== next) return
      done = true
      reveal(next.index)
      outgoing?.pause()
      schedule()
      preload()
      void fill()
    }
    if (!target || target.readyState >= 2) show()
    else {
      target.addEventListener('loadeddata', show, { once: true })
      // Не ждать вечно, если событие не придёт.
      setTimeout(show, 400)
    }
  }, [element, reveal, schedule, preload, fill])

  const start = useCallback(async () => {
    const mine = ++run.current
    dropRequests()
    setError(null)
    setPreparing(true)
    silence(current.current)
    silence(upcoming.current)
    current.current = null
    upcoming.current = null
    queue.current = []
    const state = useCompose.getState()
    // Играет то, что под иглой. Метки I и O сюда не вмешиваются: они только
    // для готового файла.
    const finish = state.duration()
    let at = state.playhead
    // Игла осталась в самом конце — начинаем сначала, как любой плеер.
    if (at >= finish - 0.05) at = 0
    // Первый кусок — прямо с иглы. Прежде он начинался с ровной отметки
    // до иглы (чтобы годиться для запаса), и до начала просмотра собиралось
    // то, что человек смотреть не собирался, — иногда десяток секунд пустоты.
    // Короткий первый кусок тоже пробовали: следующий не успевал собраться
    // за время его показа, и просмотр тут же вставал снова.
    const first = await fetchChunk(at, mine, at)
    if (!first || !alive.current || mine !== run.current) {
      if (mine === run.current) setPreparing(false)
      return
    }
    const { ctx } = graph()
    await ctx.resume()
    const index = shownRef.current
    const offset = Math.max(0, at - first.at)
    load(index, first, offset)
    const target = element(index)
    try {
      try {
        await target?.play()
      } catch (problem) {
        // Плеер не открыл кусок («no supported sources»): файл куска мог
        // пропасть или прийти битым. Один раз пробуем открыть его заново,
        // и только потом говорим об ошибке.
        if ((problem as Error).name !== 'NotSupportedError' || !target) throw problem
        delete target.dataset.chunk
        target.removeAttribute('src')
        target.load()
        load(index, first, offset)
        await target.play()
      }
    } catch (problem) {
      if (mine === run.current) {
        setPreparing(false)
        setError(
          (problem as Error).name === 'NotSupportedError'
            ? 'Не удалось открыть кусок просмотра. Нажмите «Смотреть» ещё раз — он соберётся заново'
            : (problem as Error).message,
        )
      }
      return
    }
    if (mine !== run.current) {
      target?.pause()
      return
    }
    setPreparing(false)
    // Звук — с того же мгновения, что и видео; дальше видео подстраивается
    // под звук.
    const begin = ctx.currentTime + 0.02
    current.current = { chunk: first, index, begin, offset, source: sound(first, begin, offset) }
    reveal(index)
    state.moveHead(at)
    // Белая игла встаёт на место, откуда начали.
    useCompose.getState().setPlayback(true)
    setPlaying(true)
    void fill()
  }, [fetchChunk, graph, load, element, sound, reveal, fill])

  /** Пока играет — двигаем иглу, держим видео вровень со звуком, снимаем уровень. */
  useEffect(() => {
    if (!playing) return
    const { ctx, gain } = graph()
    void ctx.resume()
    // Громкость слушателя живёт на узле графа: так шкала уровня показывает
    // сам монтаж, а не то, насколько тихо человек сделал себе в наушниках.
    gain.gain.value = volume

    const buffer = new Float32Array(1024)
    const read = (node: AnalyserNode): number => {
      node.getFloatTimeDomainData(buffer)
      let sum = 0
      for (const value of buffer) sum += value * value
      const rms = Math.sqrt(sum / buffer.length)
      return rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60
    }

    let swapTimer: ReturnType<typeof setTimeout> | null = null
    const tick = () => {
      const now = ctx.currentTime
      const next = upcoming.current
      // Видео разгоняется около десятой доли секунды: запускаем следующее
      // заранее, пока оно ещё спрятано, — иначе на стыке картинка замирала.
      const spare = next && element(next.index)
      if (next && spare?.paused && next.begin - now < 0.12) {
        void spare.play().catch(() => undefined)
      }
      // Стык близко — ловим его отдельным таймером, точнее общего шага.
      if (next && !swapTimer && next.begin - now < 0.08) {
        swapTimer = setTimeout(() => {
          swapTimer = null
          swap()
        }, Math.max(0, (next.begin - ctx.currentTime) * 1000))
      }
      const slot = current.current
      if (!slot) return
      const into = slot.offset + (now - slot.begin)
      const ended = into >= slot.chunk.span
      if (ended && !upcoming.current) {
        // Следующего куска нет: либо конец монтажа, либо он ещё собирается.
        if (nextStart() === null && !filling.current && !queue.current.length) {
          useCompose.getState().moveHead(slot.chunk.at + slot.chunk.span)
          stop()
          return
        }
        setPreparing(true)
        void fill()
      }
      const t = Math.min(Math.max(into, 0), slot.chunk.span)
      useCompose.getState().moveHead(slot.chunk.at + t)
      // Видео подстраивается под звук: мелкое расхождение — чуть быстрее или
      // медленнее, крупное — перемоткой.
      const target = element(slot.index)
      if (target && !ended && !target.seeking) {
        const drift = target.currentTime - t
        if (Math.abs(drift) > DRIFT_JUMP) {
          target.currentTime = t
          target.playbackRate = 1
        } else {
          target.playbackRate = Math.min(1.1, Math.max(0.9, 1 - drift))
        }
        if (target.paused) void target.play().catch(() => undefined)
      }
      setLevels({ left: read(audio.current!.left), right: read(audio.current!.right) })
    }
    // Обычный таймер, а не кадры отрисовки: в свёрнутом окне кадры не
    // приходят вовсе, и игла замирала бы вместе с показаниями.
    const timer = setInterval(tick, 40)
    return () => {
      clearInterval(timer)
      if (swapTimer) clearTimeout(swapTimer)
    }
  }, [playing, volume, element, graph, swap, nextStart, stop, fill])

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
          state.masterVolume !== prev.masterVolume
        ) {
          usePreviewReady.getState().clear()
          // Собранное впрок показывает уже не то — следующие куски заново,
          // и тот, что уже стоял встык, тоже.
          queue.current = []
          silence(upcoming.current)
          upcoming.current = null
          const spare = element(1 - shownRef.current)
          if (spare) delete spare.dataset.chunk
          if (current.current) void fillRef.current()
        }
      }),
    [element],
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = useCompose.subscribe((state, prev) => {
      if (state.masterVolume === prev.masterVolume) return
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
    localStorage.setItem('sgh.composeVolume', String(volume))
  }, [volume])

  useEffect(() => {
    alive.current = true
    return () => {
      // Ушли с вкладки — просмотр останавливается целиком. Прежде гас только
      // звук, а сборка кусков впрок шла дальше: дособранный кусок ставился в
      // очередь, заводил звук заново, и он вдруг начинал играть на другой
      // вкладке.
      alive.current = false
      run.current += 1
      aborter.current.abort()
      silence(current.current)
      silence(upcoming.current)
      current.current = null
      upcoming.current = null
      queue.current = []
      void audio.current?.ctx.close()
      audio.current = null
    }
  }, [])

  return {
    playing, preparing, error, levels, volume, setVolume, loop, setLoop,
    quality, setQuality, start, stop, shown,
  }
}
