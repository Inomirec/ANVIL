import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  FlagTriangleLeft,
  FlagTriangleRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Headphones,
  Layers,
  Link2,
  Loader2,
  Music2 as MusicTrack,
  PaintBucket,
  Type,
  Music2,
  Pause,
  Play as PlayIcon,
  Repeat,
  Scissors,
  SkipBack,
  Trash2,
  Undo2,
  VolumeX,
  X,
  Scan,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { api } from '../lib/api'
import { plural, timecode } from '../lib/format'
import type { FilmstripInfo } from '../lib/types'
import {
  clipEdges,
  magnets,
  dbToGain,
  gainToDb,
  MAX_DB,
  MAX_TRACKS,
  MIN_CLIP_SECONDS,
  MIN_DB,
  shareToVolume,
  snap,
  trackColor,
  trackNumber,
  volumeLabel,
  volumeShare,
  useCompose,
  MAX_SPEED,
  MIN_SPEED,
  isCropped,
  newMask,
  speedOf,
  type ComposeClip,
  type ComposeTrack,
} from '../composeStore'
import { useStore } from '../store'
import { EFFECTS, effectParams, targetOf } from '../composeEffects'
import { IconButton } from './ui'

/** Радиус прилипания и ширина уголка для растягивания, в пикселях. */
const SNAP_PIXELS = 8
const GRIP_PIXELS = 10
/**
 * Уголок затухания. Заметно крупнее края растягивания и живёт только в
 * верхней части клипа: попадать в него мышью с точностью до пикселя не
 * придётся, а тянуть длину можно всей остальной высотой.
 */
const FADE_CORNER = 18
/** Игла липнет к краям клипов, но слабее, чем клипы друг к другу. */
const PLAYHEAD_SNAP = 6
/** Сдвиг, после которого нажатие считается протяжкой, а не щелчком. */
const DRAG_START = 4
/** Высота дорожек. Одинаковая: при монтаже звук не менее важен картинки. */
export const TRACK_HEIGHT = 74
export const AUDIO_HEIGHT = 74
/** Сжатые дорожки: когда их много, а места мало. Клавиша «Ё». */
export const COMPACT_HEIGHT = 26
/** Ширина колонки с названиями дорожек по умолчанию и её пределы. */
export const HEAD_DEFAULT = 150
const HEAD_MIN = 24
const HEAD_MAX = 320
/** С этой ширины в колонке помещается название. */
const NAME_FROM = 58
/** А с этой — и ползунок уровня. Прятался он раньше, при 118 пикселях: места
 *  под ним оставалось ещё на треть колонки. */
const LEVEL_FROM = 80
/** В сжатых дорожках ползунок стоит в ряд с названием — ему нужно больше. */
const LEVEL_NARROW_FROM = 150
/** Линейка времени над дорожками. */
export const RULER_HEIGHT = 24
/** Панель кнопок над таймлайном. */
export const TOOLBAR_HEIGHT = 36
/** Пустой запас справа, чтобы было куда тащить клипы. */
const TAIL_SECONDS = 8
/** Дальше половины клипа затухание не тянется — оно съело бы весь кусок. */
const MAX_FADE_RATIO = 0.5

type Drag =
  | {
      kind: 'move'
      ids: string[]
      grab: number
      lastAt: number
      row: number
      /** Где нажали — чтобы отличить нажатие от перетаскивания. */
      fromX: number
      fromY: number
      clickAt: number
      started: boolean
    }
  | { kind: 'level'; id: string; top: number; height: number }
  | {
      kind: 'edge'
      id: string
      side: 'left' | 'right'
      clip: ComposeClip
      /** С Ctrl край меняет скорость, а не обрезает. */
      stretch?: boolean
    }
  | { kind: 'fade'; id: string; side: 'in' | 'out'; clip: ComposeClip }
  | { kind: 'playhead' }
  | { kind: 'marquee'; fromAt: number; fromY: number }
  /**
   * Нажали по пустому месту и ещё не понятно, чего хотят: короткое нажатие
   * ставит иглу, нажатие с протяжкой обводит клипы рамкой. Решаем по тому,
   * сдвинулась мышь или нет.
   */
  | { kind: 'pending'; fromAt: number; fromX: number; fromY: number }
  | null

/**
 * Таймлайн монтажа: дорожки с клипами, игла, метки отрезка, зум.
 *
 * Привычки из монтажных программ: прилипание к соседям и к игле, зум колесом,
 * выделение рамкой, затухания за уголок клипа, клавиши S (разрезать), I и O
 * (метки отрезка). Клипы не лежат друг на друге: когда один переносят на
 * занятое место, соседи расступаются.
 */
export function ComposeTimeline({
  onDropFile,
  adding,
  player,
}: {
  /** Файл притащили из медиатеки: путь, секунда, дорожка и место броска. */
  onDropFile: (
    path: string,
    at: number,
    trackId: string,
    from: { x: number; y: number },
  ) => void
  /** Файл сейчас читается — показываем, что программа занята, а не висит. */
  adding: boolean
  /** Управление просмотром: кнопки стоят здесь, рядом с остальными. */
  player: {
    playing: boolean
    preparing: boolean
    loop: boolean
    setLoop: (value: boolean) => void
    volume: number
    setVolume: (value: number) => void
    start: () => void
    stop: () => void
  }
}) {
  const tracks = useCompose((state) => state.tracks)
  const playhead = useCompose((state) => state.playhead)
  const selected = useCompose((state) => state.selected)
  const scale = useCompose((state) => state.scale)
  const toast = useStore((state) => state.toast)
  const renderIn = useCompose((state) => state.renderIn)
  const renderOut = useCompose((state) => state.renderOut)
  const setPlayhead = useCompose((state) => state.setPlayhead)
  const setScale = useCompose((state) => state.setScale)
  const select = useCompose((state) => state.select)
  const splitAtPlayhead = useCompose((state) => state.splitAtPlayhead)
  const removeClips = useCompose((state) => state.removeClips)
  const addColor = useCompose((state) => state.addColor)
  const addText = useCompose((state) => state.addText)
  const addTrack = useCompose((state) => state.addTrack)
  const removeTrack = useCompose((state) => state.removeTrack)
  const moveTrack = useCompose((state) => state.moveTrack)
  const renameTrack = useCompose((state) => state.renameTrack)
  const setTrackLevel = useCompose((state) => state.setTrackLevel)
  const updateClip = useCompose((state) => state.updateClip)
  const markIn = useCompose((state) => state.markIn)
  const markOut = useCompose((state) => state.markOut)
  const clearMarks = useCompose((state) => state.clearMarks)
  const groupClips = useCompose((state) => state.groupClips)
  const ungroupClips = useCompose((state) => state.ungroupClips)

  // Сжатые дорожки и ширина колонки с названиями — про то, как человеку
  // удобно смотреть, а не про сам монтаж: в файл проекта это не идёт, но
  // между запусками помнится.
  const compact = useCompose((state) => state.compact)
  const setCompact = useCompose((state) => state.setCompact)
  const headWidth = useCompose((state) => state.headWidth)
  const setHeadWidth = useCompose((state) => state.setHeadWidth)
  const rowHeight = compact ? COMPACT_HEIGHT : TRACK_HEIGHT

  const [dropAt, setDropAt] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  // Меню дорожки: правая кнопка по пустому месту. Отдельной кнопки у дорожки
  // нет — она заняла бы место у самого начала таймлайна, где лежат клипы.
  // Меню дорожки бывает двух видов: по полотну — что положить в это место,
  // по колонке с названием — что сделать с самой дорожкой.
  const [trackMenu, setTrackMenu] = useState<{
    x: number
    y: number
    id: string
    where: 'lane' | 'head'
    at: number
  } | null>(null)
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  /** Куда поставить прокрутку, когда масштаб сменится: игла и её место на экране. */
  const pendingScroll = useRef<{ playhead: number; keep: number } | null>(null)
  const vscroll = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag>(null)

  const duration = tracks.reduce(
    (longest, track) =>
      track.clips.reduce((value, clip) => Math.max(value, clip.start + clip.duration), longest),
    0,
  )
  const span = Math.max(duration + TAIL_SECONDS, 20)
  const width = span * scale

  /** Секунда под курсором.
   *
   * Прокрутку отдельно прибавлять не нужно: у прокрученного полотна левый
   * край и так уезжает влево, и разница до курсора уже посчитана правильно.
   */
  const secondsAt = useCallback(
    (clientX: number) => {
      const box = canvas.current?.getBoundingClientRect()
      if (!box) return 0
      return Math.max(0, (clientX - box.left) / scale)
    },
    [scale],
  )

  /** Номер дорожки под курсором. Строки одной высоты, поэтому просто делим. */
  const rowAt = useCallback(
    (clientY: number) => {
      const box = canvas.current?.getBoundingClientRect()
      if (!box) return 0
      const inside = clientY - box.top - RULER_HEIGHT
      return Math.floor(inside / rowHeight)
    },
    [rowHeight],
  )

  /**
   * Файл, перетащенный из проводника прямо на таймлайн.
   *
   * Путь к нему знает только окно программы, поэтому он приходит отдельным
   * событием, а не вместе с броском. Точка броска у события своя — по ней и
   * находим дорожку со временем; если бросили мимо дорожек, кладём на первую
   * подходящую в конец монтажа, чтобы файл не пропал без следа.
   */
  useEffect(() => {
    const onExternal = (event: Event) => {
      const detail = (event as CustomEvent<{ paths: string[]; at: { x: number; y: number } }>)
        .detail
      const path = detail?.paths?.[0]
      if (!path) return
      const state = useCompose.getState()
      const row = rowAt(detail.at.y)
      const track = state.tracks[row] ?? state.tracks.find((item) => item.kind === 'video')
      if (!track) return
      const inside = row >= 0 && row < state.tracks.length
      const at = inside
        ? snap(
            secondsAt(detail.at.x),
            magnets(state.tracks, [], state.playhead),
            (SNAP_PIXELS * 2) / state.scale,
          )
        : state.tracks
            .flatMap((item) => item.clips)
            .reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0)
      onDropFile(path, Math.max(0, at), track.id, detail.at)
      if (detail.paths.length > 1) {
        toast(`Положен первый файл из ${detail.paths.length} — остальные перетащите по одному`, 'info')
      }
    }
    window.addEventListener('sgh:drop-compose', onExternal)
    return () => window.removeEventListener('sgh:drop-compose', onExternal)
  }, [onDropFile, rowAt, secondsAt, toast])

  // Обработчики висят на окне, поэтому берут всё нужное из хранилища сами:
  // иначе они запомнили бы снимок из прошлого рендера, и клип прыгал бы к
  // старым координатам. На этих граблях программа стояла уже дважды.
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const current = drag.current
      if (!current) return
      const state = useCompose.getState()
      const at = secondsAt(event.clientX)

      if (current.kind === 'playhead') {
        // Лёгкое прилипание к краям клипов: метки I и O чаще всего ставят
        // ровно по границе куска, а попасть в неё на глаз невозможно.
        state.setPlayhead(snap(at, clipEdges(state.tracks), PLAYHEAD_SNAP / state.scale))
        return
      }

      if (current.kind === 'pending') {
        const away =
          Math.abs(event.clientX - current.fromX) + Math.abs(event.clientY - current.fromY)
        if (away < DRAG_START) return
        const box = canvas.current?.getBoundingClientRect()
        drag.current = {
          kind: 'marquee',
          fromAt: current.fromAt,
          fromY: current.fromY - (box?.top ?? 0),
        }
        state.select([])
        return
      }

      if (current.kind === 'marquee') {
        const box = canvas.current?.getBoundingClientRect()
        if (!box) return
        setMarquee({
          x1: current.fromAt * state.scale,
          y1: current.fromY,
          x2: at * state.scale,
          y2: event.clientY - box.top,
        })
        return
      }

      if (current.kind === 'level') {
        // Линия уровня: у звука это громкость, у картинки — прозрачность.
        // У звука шкала в децибелах, поэтому высота переводится не напрямую:
        // наверху шкалы есть запас на усиление.
        const share = Math.min(1, Math.max(0, 1 - (event.clientY - current.top) / current.height))
        const clip = state.findClip(current.id)?.clip
        if (clip) {
          state.updateClip(
            current.id,
            clip.kind === 'audio' ? { volume: shareToVolume(share) } : { opacity: share },
          )
        }
        return
      }

      if (current.kind === 'fade') {
        const clip = current.clip
        const limit = clip.duration * MAX_FADE_RATIO
        const value =
          current.side === 'in' ? at - clip.start : clip.start + clip.duration - at
        state.updateClip(clip.id, {
          [current.side === 'in' ? 'fadeIn' : 'fadeOut']: Math.min(Math.max(value, 0), limit),
        })
        return
      }

      if (current.kind === 'move') {
        // Пока мышь не отошла на несколько пикселей, это ещё нажатие, а не
        // перетаскивание: дрогнувшая рука не должна сдвигать клип на кадр.
        if (!current.started) {
          const away =
            Math.abs(event.clientX - current.fromX) + Math.abs(event.clientY - current.fromY)
          if (away < DRAG_START) return
          current.started = true
        }
        // Курсор ушёл на другую дорожку — переносим туда же и клипы. Дорожку
        // запоминаем не по клипу, а отдельно: если переехать не удалось
        // (внизу звук, а тащим картинку), клип должен остаться на месте, и
        // повторять попытку на каждое движение мыши незачем.
        const row = rowAt(event.clientY)
        if (row !== current.row) {
          state.shiftTracks(current.ids, row - current.row)
          const after = useCompose.getState()
          const moved = after.tracks.findIndex((track) =>
            track.clips.some((clip) => clip.id === current.ids[0]),
          )
          if (moved >= 0) current.row = moved
        }

        // Один клип липнет к соседям и к игле, у пачки прилипание только
        // мешало бы: у каждого клипа свои края, и к чему липнуть — непонятно.
        if (current.ids.length === 1) {
          const found = state.findClip(current.ids[0])
          if (!found) return
          const points = magnets(state.tracks, current.ids, state.playhead)
          const wanted = snap(at - current.grab, points, SNAP_PIXELS / state.scale)
          const delta = wanted - found.clip.start
          if (Math.abs(delta) > 1e-6) state.moveClips(current.ids, delta)
        } else {
          const delta = at - current.lastAt
          if (Math.abs(delta) > 1e-6) {
            state.moveClips(current.ids, delta)
            current.lastAt = at
          }
        }
        return
      }

      const origin = current.clip
      const found = state.findClip(current.id)
      if (!found) return
      const points = magnets(state.tracks, [current.id], state.playhead)
      const nearby = SNAP_PIXELS / state.scale

      // Секунда таймлайна у ускоренного клипа — это несколько секунд файла:
      // всё, что про файл, умножаем на скорость, всё, что про таймлайн, — делим.
      const speed = speedOf(origin)

      if (current.stretch) {
        // Ctrl + край: отрезок файла тот же, меняется только, за сколько он
        // проиграется. Тянешь длиннее — медленнее, короче — быстрее. Второй
        // край стоит на месте.
        const span = origin.duration * speed
        const end0 = origin.start + origin.duration
        const wanted =
          current.side === 'right'
            ? snap(at, points, nearby) - origin.start
            : end0 - snap(at, points, nearby)
        const next = Math.min(MAX_SPEED, Math.max(MIN_SPEED, span / Math.max(wanted, 0.05)))
        // Круглую скорость ставим точно: ×1, ×2, ×0.5 ловятся на глаз.
        const nice = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].find(
          (value) => Math.abs(value - next) / value < 0.03,
        )
        const chosen = Math.round((nice ?? next) * 1000) / 1000
        const length = span / chosen
        state.resizeClip(
          current.id,
          current.side === 'right' ? origin.start : Math.max(0, end0 - length),
          length,
          origin.sourceIn,
          chosen,
        )
        return
      }

      if (origin.reverse && origin.kind !== 'image') {
        // Задом наперёд края меняются ролями: левый край клипа — это конец
        // отрезка файла, правый — его начало. Поэтому правый край двигает
        // точку, с которой читаем файл, а левый — нет.
        const tail =
          ((origin.sourceDuration || Infinity) - (origin.sourceIn + origin.duration * speed)) / speed
        if (current.side === 'right') {
          let end = snap(at, points, nearby)
          end = Math.max(end, origin.start + MIN_CLIP_SECONDS)
          end = Math.min(end, origin.start + origin.duration + origin.sourceIn / speed)
          const length = end - origin.start
          state.resizeClip(
            current.id,
            origin.start,
            length,
            origin.sourceIn + (origin.duration - length) * speed,
          )
        } else {
          let begin = snap(at, points, nearby)
          begin = Math.min(begin, origin.start + origin.duration - MIN_CLIP_SECONDS)
          begin = Math.max(begin, origin.start - tail, 0)
          state.resizeClip(current.id, begin, origin.duration - (begin - origin.start), origin.sourceIn)
        }
        return
      }

      if (current.side === 'right') {
        let end = snap(at, points, nearby)
        // У ролика нельзя взять больше, чем в нём есть.
        if (origin.sourceDuration) {
          end = Math.min(end, origin.start + (origin.sourceDuration - origin.sourceIn) / speed)
        }
        state.resizeClip(current.id, origin.start, end - origin.start, origin.sourceIn)
      } else {
        let begin = snap(at, points, nearby)
        begin = Math.min(begin, origin.start + origin.duration - MIN_CLIP_SECONDS)
        const shift = begin - origin.start
        // Тянем за левый край — у ролика вместе с началом уезжает и точка,
        // с которой он играет: иначе кусок «съезжал» бы по содержимому.
        const sourceIn = origin.kind === 'image' ? 0 : Math.max(0, origin.sourceIn + shift * speed)
        const limited =
          origin.kind === 'image' ? begin : origin.start + (sourceIn - origin.sourceIn) / speed
        state.resizeClip(
          current.id,
          Math.max(0, limited),
          origin.duration - (limited - origin.start),
          sourceIn,
        )
      }
    }

    const onUp = () => {
      const current = drag.current
      // Перетащили клип — смотрим, не сошлись ли где-то трое. Проверяем
      // только здесь: во время перетаскивания клип должен свободно проходить
      // и через чужие переходы.
      if (current?.kind === 'move') {
        const state = useCompose.getState()
        if (current.started) {
          state.settleOverlaps(current.ids)
        } else {
          // Нажали по клипу, не сдвинув, — игла встаёт туда, где нажали, как
          // и на пустом месте дорожки. Выделение клипа при этом остаётся.
          state.setPlayhead(
            snap(current.clickAt, clipEdges(state.tracks), PLAYHEAD_SNAP / state.scale),
          )
        }
      }
      if (current?.kind === 'edge') {
        useCompose.getState().trimOverlaps(current.id)
      }
      if (current?.kind === 'pending') {
        // Мышь не сдвинулась — это было обычное нажатие: ставим иглу.
        const state = useCompose.getState()
        state.select([])
        state.setPlayhead(
          snap(current.fromAt, clipEdges(state.tracks), PLAYHEAD_SNAP / state.scale),
        )
      }
      if (current?.kind === 'marquee') {
        const area = marquee
        if (area) {
          const state = useCompose.getState()
          const from = Math.min(area.x1, area.x2) / state.scale
          const to = Math.max(area.x1, area.x2) / state.scale
          const top = Math.min(area.y1, area.y2)
          const bottom = Math.max(area.y1, area.y2)
          state.select(clipsInside(state.tracks, from, to, top, bottom))
        }
      }
      setMarquee(null)
      drag.current = null
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [secondsAt, marquee, rowAt])

  // Клавиши как в монтажных программах.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName
      // Надпись в кадре правят прямо там, в редактируемом поле: пока в нём
      // печатают, пробел, Delete и буквы — это текст, а не команды таймлайна.
      const editable = (event.target as HTMLElement | null)?.isContentEditable
      if (tag === 'INPUT' || tag === 'TEXTAREA' || editable) return
      const key = event.key.toLowerCase()

      // Ctrl+Z и Ctrl+A — то же, что и везде. Без своей обработки Ctrl+A
      // выделял всю страницу, а отменять правку было нечем.
      if (event.ctrlKey || event.metaKey) {
        if (key === 'z' || key === 'я') {
          event.preventDefault()
          useCompose.getState().undo()
        } else if (key === 'a' || key === 'ф') {
          event.preventDefault()
          useCompose.getState().selectAll()
        } else if (key === 'c' || key === 'с') {
          // Выделен текст (например, ошибка в окне просмотра) — это обычное
          // копирование текста, клипы тут ни при чём. Прежде Ctrl+C
          // перехватывался всегда, и выделенную ошибку скопировать было нельзя.
          if (window.getSelection()?.toString()) return
          // Копируем сами клипы со всеми их настройками. Системный буфер
          // сюда не годится: в нём был бы текст, а не кусок монтажа.
          event.preventDefault()
          const state = useCompose.getState()
          const taken = state.copyClips(state.selected)
          if (taken) toast(`Скопировано: ${taken} ${plural(taken, ['клип', 'клипа', 'клипов'])}`, 'info')
        } else if (key === 'v' || key === 'м') {
          event.preventDefault()
          useCompose.getState().pasteClips()
        }
        return
      }
      if (event.altKey) return
      if (key === 's' || key === 'ы') {
        event.preventDefault()
        splitAtPlayhead()
      } else if (key === 'i' || key === 'ш') {
        event.preventDefault()
        markIn()
      } else if (key === 'o' || key === 'щ') {
        event.preventDefault()
        markOut()
      } else if (key === 'g' || key === 'п') {
        event.preventDefault()
        groupClips(useCompose.getState().selected)
      } else if (key === 'u' || key === 'г') {
        event.preventDefault()
        ungroupClips(useCompose.getState().selected)
      } else if (event.code === 'Backquote') {
        // «Ё» сжимает дорожки: когда их много, важнее видеть все разом, чем
        // разглядывать кадры на каждой.
        event.preventDefault()
        setCompact(!useCompose.getState().compact)
      } else if (event.key === ' ') {
        event.preventDefault()
        if (player.playing) player.stop()
        else player.start()
      } else if (event.key === 'Delete') {
        const ids = useCompose.getState().selected
        if (ids.length) removeClips(ids)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [splitAtPlayhead, removeClips, markIn, markOut, groupClips, ungroupClips, player, toast])

  /**
   * Колесо приближает и отдаляет — как в монтажных программах.
   *
   * Точка под курсором остаётся на месте: иначе на приближении нужный кусок
   * уезжает за край, и его приходится искать прокруткой.
   */
  /**
   * Держит иглу на месте при смене масштаба.
   *
   * Приближали к точке под курсором, и на сильном увеличении игла легко
   * уезжала за край: человек крутит колесо, чтобы разглядеть место у иглы, а
   * оно-то и пропадает. Теперь при любом приближении игла остаётся там же,
   * где была на экране, — а если её не видно, встаёт посередине.
   */
  /**
   * Насколько далеко можно отодвинуться.
   *
   * Предел был один на все монтажи — четыре пикселя в секунду, — и в окно
   * влезало около двух с половиной минут. Дальше отодвинуться было нельзя, и
   * длинный монтаж целиком не показывался вовсе. Теперь предел считается по
   * самому монтажу: отодвинуть можно ровно настолько, чтобы он поместился в
   * окно целиком, с небольшим запасом справа.
   */
  const minScale = useCallback(() => {
    const view = scroller.current
    const full = useCompose.getState().duration()
    if (!view || full <= 0) return 4
    const fit = (view.clientWidth - 24) / full
    return Math.max(0.05, Math.min(4, fit))
  }, [])

  const keepPlayhead = (next: number) => {
    const view = scroller.current
    if (!view) return
    const state = useCompose.getState()
    const wasAt = state.playhead * state.scale - view.scrollLeft
    const inside = wasAt >= 0 && wasAt <= view.clientWidth
    const keep = inside ? wasAt : view.clientWidth / 2
    // Масштаб упёрся в предел — перерисовки не будет, и поправка ждала бы
    // следующего щелчка с устаревшими числами.
    if (next === state.scale) return
    pendingScroll.current = { playhead: state.playhead, keep }
    setScale(next)
  }

  // Прокрутку под новый масштаб правим до того, как окно нарисует кадр.
  // Прежде её правили таймером уже после отрисовки, и каждый щелчок колеса
  // давал два кадра подряд — дорожка в новом масштабе на старом месте, потом
  // на новом, — что читалось как двоение всего, что лежит на таймлайне. Кадры
  // отрисовки тут не нужны, поэтому и в свёрнутом окне это работает.
  useLayoutEffect(() => {
    const target = pendingScroll.current
    const view = scroller.current
    if (!target || !view) return
    pendingScroll.current = null
    view.scrollLeft = Math.max(0, target.playhead * scale - target.keep)
  }, [scale])

  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    // С Ctrl колесо листает дорожки — и только: масштаб при этом не трогаем.
    if (event.ctrlKey || event.metaKey) {
      if (vscroll.current) vscroll.current.scrollTop += event.deltaY
      return
    }
    const state = useCompose.getState()
    keepPlayhead(
      Math.min(400, Math.max(minScale(), state.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15))),
    )
  }
  const wheelRef = useRef(onWheel)
  wheelRef.current = onWheel

  // Колесо слушаем напрямую, а не через React: там обработчик колеса только
  // «смотрит», и отменить обычную прокрутку из него нельзя. Так и было —
  // колесо приближало таймлайн и заодно листало дорожки вверх-вниз.
  useEffect(() => {
    const element = vscroll.current
    if (!element) return
    const listener = (event: WheelEvent) => wheelRef.current(event)
    element.addEventListener('wheel', listener, { passive: false })
    return () => element.removeEventListener('wheel', listener)
  }, [])

  return (
    <div className="flex h-full flex-col">
      {/* Панель инструментов */}
      {/* Панель поделена на три части: слева — что делают с клипами,
          посередине — просмотр, справа — что делают со всем монтажом и с
          самим таймлайном. Середина держится по центру окна и не ездит,
          когда слева появляются надписи вроде «добавляю файл…». */}
      <div className="grid h-9 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-line-soft px-3">
        {/* Слева: что делают с клипами и дорожками */}
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <IconButton
            title="Отменить последнее действие (Ctrl+Z)"
            onClick={() => useCompose.getState().undo()}
          >
            <Undo2 size={14} />
          </IconButton>

          <span className="mx-0.5 h-4 w-px bg-line-soft" />

          <IconButton title="Разрезать клип под иглой (S)" onClick={() => splitAtPlayhead()}>
            <Scissors size={14} />
          </IconButton>
          <IconButton
            title="Удалить выбранное (Delete)"
            onClick={() => selected.length && removeClips(selected)}
            disabled={!selected.length}
          >
            <Trash2 size={14} />
          </IconButton>

          <span className="mx-0.5 h-4 w-px bg-line-soft" />

          <IconButton
            title="Добавить видеодорожку — она ляжет верхним слоем"
            onClick={() => addTrack('video')}
            disabled={tracks.length >= MAX_TRACKS}
          >
            <Layers size={14} />
          </IconButton>
          <IconButton
            title="Добавить звуковую дорожку"
            onClick={() => addTrack('audio')}
            disabled={tracks.length >= MAX_TRACKS}
          >
            <MusicTrack size={14} />
          </IconButton>
          <IconButton
            title="Положить заливку под иглу: сплошной цвет под картинки с полями, под заставку или полосой поверх кадра"
            onClick={() => addColor('#101018')}
          >
            <PaintBucket size={14} />
          </IconButton>
          <IconButton
            title="Положить надпись под иглу: субтитр, заголовок или подпись поверх кадра"
            onClick={() => addText()}
          >
            <Type size={14} />
          </IconButton>

          {selected.length > 1 && (
            <span className="ml-1 shrink-0 text-[11px] text-accent-soft">
              выбрано: {selected.length}
            </span>
          )}
          {/* Чтение файла занимает мгновение, но без этого окно выглядит
              зависшим: человек бросил файл, а на дорожке пока пусто. */}
          {adding && (
            <span className="ml-1 flex shrink-0 items-center gap-1.5 text-[11px] text-accent-soft">
              <Loader2 size={12} className="animate-spin" />
              добавляю файл…
            </span>
          )}
        </div>

        {/* Посередине: просмотр */}
        <div className="flex items-center gap-1.5">
          <IconButton
            title="В начало монтажа"
            onClick={() => {
              player.stop()
              setPlayhead(0)
            }}
          >
            <SkipBack size={14} />
          </IconButton>
          <IconButton
            title={player.playing ? 'Пауза' : 'Смотреть с иглы (пробел)'}
            onClick={() => (player.playing ? player.stop() : player.start())}
            active={player.playing}
          >
            {player.preparing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : player.playing ? (
              <Pause size={14} />
            ) : (
              <PlayIcon size={14} />
            )}
          </IconButton>
          <IconButton
            title="Повторять по кругу"
            onClick={() => player.setLoop(!player.loop)}
            active={player.loop}
          >
            <Repeat size={14} />
          </IconButton>
          {/* Громкость прослушивания: на готовый файл не влияет, поэтому стоит
              здесь, рядом с кнопками просмотра, а не на шине громкости. */}
          <div
            className="flex w-[86px] items-center gap-1"
            title={`Громкость прослушивания ${Math.round(player.volume * 100)}%`}
          >
            <Headphones size={13} className="shrink-0 text-ink-faint" />
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(player.volume * 100)}
              onChange={(event) => player.setVolume(Number(event.target.value) / 100)}
              className="w-full"
            />
          </div>
        </div>

        {/* Справа: как выглядит сам таймлайн. Где стоит игла и что уйдёт в
            файл, видно на самом таймлайне — метками и её чертой, поэтому
            словами это здесь не повторяем: место на панели дороже. */}
        <div className="flex min-w-0 items-center justify-end gap-1.5 overflow-hidden">

          <IconButton title="Начало отрезка сборки (I)" onClick={markIn} active={renderIn !== null}>
            <FlagTriangleRight size={14} />
          </IconButton>
          <IconButton title="Конец отрезка сборки (O)" onClick={markOut} active={renderOut !== null}>
            <FlagTriangleLeft size={14} />
          </IconButton>
          {(renderIn !== null || renderOut !== null) && (
            <IconButton title="Собрать всё целиком" onClick={clearMarks}>
              <X size={14} />
            </IconButton>
          )}

          <span className="mx-0.5 h-4 w-px bg-line-soft" />

          <IconButton
            title="Сжать дорожки, чтобы поместились все (Ё)"
            active={compact}
            onClick={() => setCompact(!compact)}
          >
            {compact ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
          </IconButton>
          <IconButton
            title="Отдалить (колесо мыши)"
            onClick={() => keepPlayhead(Math.max(minScale(), scale / 1.4))}
          >
            <ZoomOut size={14} />
          </IconButton>
          <IconButton
            title="Показать монтаж целиком"
            onClick={() => {
              // До этого же места доходит и колесо, только за полтора десятка
              // щелчков. Длинный монтаж хочется увидеть разом, а не искать
              // его край.
              const fit = minScale()
              if (fit === useCompose.getState().scale) {
                if (scroller.current) scroller.current.scrollLeft = 0
                return
              }
              pendingScroll.current = { playhead: 0, keep: 0 }
              setScale(fit)
            }}
          >
            <Scan size={14} />
          </IconButton>
          <IconButton
            title="Приблизить (колесо мыши)"
            onClick={() => keepPlayhead(Math.min(400, scale * 1.4))}
          >
            <ZoomIn size={14} />
          </IconButton>
          {/* Где стоит игла — у самого края панели. Текст можно выделить и
              скопировать: остальное окно выделять запрещено, чтобы не мешать
              перетаскиванию, и время вместе с ним не копировалось. */}
          <span
            className="shrink-0 cursor-text select-text font-mono text-[11px] tabular-nums text-ink-dim"
            title="Где стоит игла: минуты, секунды и десятые"
          >
            {timecode(playhead, true)}
          </span>
        </div>
      </div>

      {/* Слева названия дорожек, справа само полотно. Прокручиваются они
          вместе по высоте, а вбок — только полотно. `items-start` обязателен:
          иначе полотно растягивается лишь на видимую высоту, прокручивается
          по высоте само (вбок-прокрутка тянет за собой и вертикальную), и
          когда дорожки перестают влезать, названия и дорожки разъезжаются. */}
      <div ref={vscroll} className="flex min-h-0 flex-1 items-start overflow-y-auto">
        <TrackHeads
          tracks={tracks}
          width={headWidth}
          onWidth={setHeadWidth}
          onMoveTrack={moveTrack}
          rowHeight={rowHeight}
          onRename={renameTrack}
          onLevel={setTrackLevel}
          onMenu={(event, id) => {
            event.preventDefault()
            setTrackMenu({ x: event.clientX, y: event.clientY, id, where: 'head', at: 0 })
          }}
        />

      <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-x-auto">
        {/* Полотно не уже видимой части: иначе справа остаётся пустое место,
            куда файл бросить нельзя, а выглядит оно так же, как дорожка. */}
        <div
          ref={canvas}
          style={{ width, minWidth: '100%' }}
          className="relative select-none"
        >
          <Ruler
            span={span}
            scale={scale}
            renderIn={renderIn}
            renderOut={renderOut}
            duration={duration}
            onSeek={(at) => {
              drag.current = { kind: 'playhead' }
              setPlayhead(at)
            }}
          />

          {tracks.map((track) => (
            <div
              key={track.id}
              className="relative border-b border-line-soft"
              style={{ height: rowHeight }}
              onMouseDown={(event) => {
                if (event.button !== 0 || event.target !== event.currentTarget) return
                const box = canvas.current?.getBoundingClientRect()
                if (!box) return
                // Нажатие по любому пустому месту ставит иглу — и над клипом,
                // и под ним, и между ними: искать для этого узкую полоску
                // линейки не нужно. А если нажать и потянуть, получится рамка
                // выделения. Что человек хотел, видно по тому, сдвинулась ли
                // мышь, поэтому решаем не сразу.
                drag.current = {
                  kind: 'pending',
                  fromAt: secondsAt(event.clientX),
                  fromX: event.clientX,
                  fromY: event.clientY,
                }
              }}
              onContextMenu={(event) => {
                if (event.target !== event.currentTarget) return
                event.preventDefault()
                setTrackMenu({
                  x: event.clientX,
                  y: event.clientY,
                  id: track.id,
                  where: 'lane',
                  at: Math.max(0, secondsAt(event.clientX)),
                })
              }}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
                setDropAt(secondsAt(event.clientX))
              }}
              onDragLeave={() => setDropAt(null)}
              onDrop={(event) => {
                event.preventDefault()
                const path = event.dataTransfer.getData('application/x-sgh-path')
                setDropAt(null)
                if (!path) return
                // Брошенный файл липнет к началу и к краям соседей: попасть
                // мышью ровно встык невозможно, а щель в полсекунды на
                // готовом видео выглядит как чёрная вспышка.
                const at = secondsAt(event.clientX)
                onDropFile(
                  path,
                  snap(at, magnets(tracks, [], playhead), (SNAP_PIXELS * 2) / scale),
                  track.id,
                  { x: event.clientX, y: event.clientY },
                )
              }}
            >
              {/* Полотно покрашено целиком: это место, куда можно положить
                  файл, и обрывать краску там, где кончился монтаж, нельзя —
                  дальше дорожка выглядела бы чужой и мёртвой. Где кончается
                  монтаж, показывает отдельная черта. */}
              <div
                className="pointer-events-none absolute inset-0"
                style={{ background: `${trackColor(tracks, track.id)}1c` }}
              />
              {duration > 0 && (
                <div
                  className="pointer-events-none absolute inset-y-0 w-px bg-line"
                  style={{ left: duration * scale }}
                  title="Здесь кончается монтаж"
                />
              )}

              {[...track.clips]
                .sort((a, b) => a.start - b.start)
                .map((clip) => (
                <ClipBox
                  key={clip.id}
                  clip={clip}
                  scale={scale}
                  height={rowHeight}
                  active={selected.includes(clip.id)}
                  onGrab={(event, where) => {
                    const state = useCompose.getState()
                    // Запоминаем монтаж до правки: одно Ctrl+Z вернёт всё
                    // перетаскивание целиком, а не по пикселю.
                    state.mark()
                    const many = event.ctrlKey || event.shiftKey
                    const ids = many
                      ? [...new Set([...state.selected, clip.id])]
                      : state.selected.includes(clip.id) && state.selected.length > 1
                        ? state.selected
                        : [clip.id]
                    select(ids)
                    const at = secondsAt(event.clientX)
                    if (where === 'move') {
                      drag.current = {
                        kind: 'move',
                        ids,
                        grab: at - clip.start,
                        lastAt: at,
                        row: rowAt(event.clientY),
                        fromX: event.clientX,
                        fromY: event.clientY,
                        clickAt: at,
                        started: false,
                      }
                    } else if (where === 'fadeIn' || where === 'fadeOut') {
                      drag.current = {
                        kind: 'fade',
                        id: clip.id,
                        side: where === 'fadeIn' ? 'in' : 'out',
                        clip,
                      }
                    } else {
                      drag.current = {
                        kind: 'edge',
                        id: clip.id,
                        side: where,
                        clip,
                        // Ctrl + край — скорость, как в монтажных программах.
                        stretch:
                          (event.ctrlKey || event.metaKey) &&
                          (clip.kind === 'video' || clip.kind === 'audio'),
                      }
                    }
                  }}
                  onMute={() => updateClip(clip.id, { muted: !clip.muted })}
                  onLevel={(top, height) => {
                    useCompose.getState().mark()
                    select([clip.id])
                    drag.current = { kind: 'level', id: clip.id, top, height }
                  }}
                  onMenu={(event) => {
                    event.preventDefault()
                    const state = useCompose.getState()
                    if (!state.selected.includes(clip.id)) select([clip.id])
                    setMenu({ x: event.clientX, y: event.clientY, id: clip.id })
                  }}
                />
              ))}

              {/* Перекрестье в зоне наложения — знак перехода, как в
                  монтажных программах: видно, что клипы не просто налезли
                  друг на друга, а перетекают один в другой. */}
              {crossfades(track).map((zone) => (
                <div
                  key={`${zone.from}-${zone.to}`}
                  className="pointer-events-none absolute top-1.5 overflow-hidden rounded bg-accent/10 ring-1 ring-inset ring-accent/40"
                  style={{
                    left: zone.from * scale,
                    width: Math.max((zone.to - zone.from) * scale, 2),
                    height: rowHeight - 12,
                  }}
                >
                  <svg className="h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <line x1="0" y1="100" x2="100" y2="0" className="stroke-accent-soft" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                    <line x1="0" y1="0" x2="100" y2="100" className="stroke-accent-soft" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                  </svg>
                </div>
              ))}

              {dropAt !== null && (
                <div
                  className="pointer-events-none absolute top-0 h-full w-0.5 bg-accent"
                  style={{ left: dropAt * scale }}
                />
              )}
            </div>
          ))}

          {/* Рамка выделения */}
          {marquee && (
            <div
              className="pointer-events-none absolute z-10 rounded border border-accent bg-accent/15"
              style={{
                left: Math.min(marquee.x1, marquee.x2),
                top: Math.min(marquee.y1, marquee.y2),
                width: Math.abs(marquee.x2 - marquee.x1),
                height: Math.abs(marquee.y2 - marquee.y1),
              }}
            />
          )}

          {/* Игла поверх всего */}
          <div
            className="pointer-events-none absolute top-0 z-20 h-full w-px bg-danger"
            style={{ left: playhead * scale }}
          >
            <div className="-ml-[5px] h-2.5 w-2.5 rounded-b-sm bg-danger" />
          </div>
        </div>
      </div>
      </div>

      {menu && (
        <ClipMenu
          at={menu}
          clipId={menu.id}
          onClose={() => setMenu(null)}
        />
      )}

      {trackMenu && (
        <TrackMenu
          at={trackMenu}
          where={trackMenu.where}
          trackId={trackMenu.id}
          onClose={() => setTrackMenu(null)}
          onRemove={() => removeTrack(trackMenu.id)}
          onAdd={addTrack}
          onFill={() => addColor('#101018', trackMenu.id, trackMenu.at)}
          onText={() => addText(trackMenu.id, trackMenu.at)}
          tracks={tracks}
        />
      )}
    </div>
  )
}

/**
 * Колонка с названиями дорожек — слева от полотна.
 *
 * У каждой дорожки свой цвет и номер: когда дорожек много, только по ним и
 * понятно, где что. Название человек задаёт сам, по умолчанию его нет —
 * пустая дорожка не должна кричать о себе. Ползунок задаёт уровень всей
 * дорожки разом: у звука это громкость, у видео — насколько видно то, что на
 * ней лежит.
 *
 * Колонку тянут за правую границу. Чем она уже, тем меньше в ней остаётся:
 * сначала уходит ползунок, потом название, и остаются цвет с номером.
 */
function TrackHeads({
  tracks,
  width,
  onWidth,
  rowHeight,
  onRename,
  onLevel,
  onMenu,
  onMoveTrack,
}: {
  tracks: ComposeTrack[]
  width: number
  onWidth: (value: number) => void
  rowHeight: number
  onRename: (id: string, name: string) => void
  onLevel: (id: string, level: number) => void
  onMenu: (event: React.MouseEvent, id: string) => void
  onMoveTrack: (id: string, to: number) => void
}) {
  const grab = useRef<{ from: number; width: number } | null>(null)
  // Дорожку переставляют, потянув её за колонку с названием. Строки одной
  // высоты, поэтому место под курсором считается делением.
  const carry = useRef<{ id: string; kind: 'video' | 'audio'; top: number } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropRow, setDropRow] = useState<number | null>(null)

  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!grab.current) return
      const next = grab.current.width + (event.clientX - grab.current.from)
      onWidth(Math.round(Math.min(HEAD_MAX, Math.max(HEAD_MIN, next))))
    }
    const drop = () => {
      grab.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', drop)
    }
  }, [onWidth])

  // Нажали на колонку дорожки — это может быть и правка названия, и
  // перетаскивание. Решаем по ходу мыши: сдвинулась по вертикали — тащим.
  const pending = useRef<{ id: string; kind: 'video' | 'audio'; top: number; y: number } | null>(null)
  useEffect(() => {
    const move = (event: MouseEvent) => {
      const held = pending.current
      if (!held || Math.abs(event.clientY - held.y) < DRAG_START) return
      pending.current = null
      // Если нажимали в поле названия, оно успело получить фокус и начать
      // выделение текста — снимаем и то, и другое.
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      window.getSelection()?.removeAllRanges()
      carry.current = { id: held.id, kind: held.kind, top: held.top }
      setDragging(held.id)
      setDropRow(tracks.findIndex((track) => track.id === held.id))
    }
    const up = () => {
      pending.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [tracks])

  // Перетаскивание самой дорожки — отдельно от растягивания колонки.
  useEffect(() => {
    if (!dragging) return
    const move = (event: MouseEvent) => {
      const held = carry.current
      if (!held) return
      const row = Math.floor((event.clientY - held.top) / rowHeight)
      setDropRow(Math.min(tracks.length - 1, Math.max(0, row)))
    }
    const drop = () => {
      const held = carry.current
      if (held && dropRow !== null) onMoveTrack(held.id, dropRow)
      carry.current = null
      setDragging(null)
      setDropRow(null)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', drop)
    }
  }, [dragging, dropRow, rowHeight, tracks.length, onMoveTrack])

  const roomy = width >= NAME_FROM
  // В сжатых дорожках ползунок встаёт рядом с названием, поэтому места ему
  // нужно больше: иначе от названия остаётся пара букв.
  const narrow = rowHeight < TRACK_HEIGHT
  const withLevel = width >= (narrow ? LEVEL_NARROW_FROM : LEVEL_FROM)

  return (
    <div
      className="relative shrink-0 border-r border-line bg-surface"
      style={{ width }}
    >
      {/* Пустое место под линейкой: дорожки должны встать вровень с полотном. */}
      <div style={{ height: RULER_HEIGHT }} className="border-b border-line-soft" />

      {tracks.map((track) => {
        const colour = trackColor(tracks, track.id)
        const sound = track.kind === 'audio'
        return (
          <div
            key={track.id}
            className={`relative flex cursor-grab items-center gap-1.5 overflow-hidden border-b border-line-soft pr-1.5 active:cursor-grabbing ${
              dragging === track.id ? 'opacity-50' : ''
            } ${
              dropRow === tracks.indexOf(track) && dragging && dragging !== track.id
                ? 'ring-1 ring-inset ring-accent'
                : ''
            }`}
            style={{ height: rowHeight }}
            onContextMenu={(event) => onMenu(event, track.id)}
            // Переставляют дорожку, потянув за любое место колонки: за номер,
            // за название, за пустоту рядом. Ползунок уровня — не в счёт.
            title="Потяните вверх или вниз, чтобы переставить дорожку"
            onMouseDown={(event) => {
              if (event.button !== 0) return
              const target = event.target as HTMLElement
              if (target instanceof HTMLInputElement && target.type === 'range') return
              if (!(target instanceof HTMLInputElement)) event.preventDefault()
              const box = event.currentTarget.parentElement?.getBoundingClientRect()
              pending.current = {
                id: track.id,
                kind: track.kind,
                top: (box?.top ?? 0) + RULER_HEIGHT,
                y: event.clientY,
              }
            }}
          >
            {/* Цветная полоса с номером — то, что остаётся при любой ширине.
                За неё же дорожку и переставляют: потянул вверх или вниз —
                она встала на новое место. Видео и звук не смешиваются: слои
                считаются сверху вниз, и звук между картинками сбил бы
                порядок. */}
            <span
              className="flex h-full w-[18px] shrink-0 items-center justify-center font-mono text-[10px] font-semibold text-black/70"
              style={{ background: colour }}
            >
              {trackNumber(tracks, track.id)}
            </span>

            {roomy && (
              /* В обычной высоте название и ползунок стоят друг под другом, а
                 в сжатой — в один ряд: на двадцать шесть пикселей два ряда не
                 помещаются. */
              <div
                className={`flex min-w-0 flex-1 gap-1.5 ${
                  narrow ? 'items-center' : 'flex-col justify-center py-1'
                }`}
              >
                <input
                  value={track.name ?? ''}
                  onChange={(event) => onRename(track.id, event.target.value)}
                  placeholder={track.kind === 'audio' ? 'Звук' : 'Видео'}
                  title="Название дорожки — нажмите, чтобы переименовать; потяните, чтобы переставить"
                  className={`min-w-0 cursor-grab truncate bg-transparent text-[11.5px] text-ink outline-none placeholder:text-ink-faint/60 focus:cursor-text ${
                    narrow ? 'flex-1' : 'w-full'
                  }`}
                />
                {withLevel && sound && (
                  // Число стоит под ползунком, а не рядом: в узкой колонке
                  // подпись съедала половину его длины, и попасть в нужное
                  // значение было нечем.
                  <div
                    className={`flex gap-1.5 ${
                      narrow ? 'w-[92px] shrink-0 items-center' : 'flex-col'
                    }`}
                  >
                    <input
                      type="range"
                      min={sound ? MIN_DB : 0}
                      max={sound ? MAX_DB : 100}
                      step={sound ? 0.5 : 1}
                      value={sound ? gainToDb(track.level) : Math.round(track.level * 100)}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        onLevel(track.id, sound ? dbToGain(value) : value / 100)
                      }}
                      // Двойное нажатие возвращает обычный уровень: задеть
                      // ползунок легко, а вспомнить, каким он был, — нет.
                      // Перехватываем до прыжка ползунка под курсор.
                      onMouseDown={(event) => {
                        if (event.detail < 2) return
                        event.preventDefault()
                        onLevel(track.id, 1)
                      }}
                      onDoubleClick={() => onLevel(track.id, 1)}
                      title={
                        sound
                          ? `Громкость дорожки ${volumeLabel(track.level)}`
                          : `Насколько видно эту дорожку: ${Math.round(track.level * 100)}%`
                      }
                      className="min-w-0 flex-1"
                    />
                    <span
                      className={`shrink-0 font-mono text-[9.5px] leading-none tabular-nums text-ink-faint ${
                        narrow ? 'w-[46px] text-right' : 'w-full text-center'
                      }`}
                    >
                      {volumeLabel(track.level)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* Граница, за которую колонку тянут. */}
      <div
        className="absolute inset-y-0 right-0 z-10 w-[5px] cursor-col-resize hover:bg-accent/30"
        title="Потяните, чтобы сделать колонку шире или уже"
        onMouseDown={(event) => {
          event.preventDefault()
          grab.current = { from: event.clientX, width }
        }}
        onDoubleClick={() => onWidth(width > HEAD_MIN ? HEAD_MIN : HEAD_DEFAULT)}
      />
    </div>
  )
}

/**
 * Держит меню в пределах окна.
 *
 * Меню открывается под курсором, а у нижней дорожки курсор стоит у самого
 * низа окна — половина пунктов оказывалась за краем экрана. Поэтому после
 * появления меню сдвигается вверх или влево ровно настолько, чтобы влезть.
 */
function useMenuPlace(at: { x: number; y: number }) {
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: at.x, top: at.y })

  useLayoutEffect(() => {
    const size = box.current?.getBoundingClientRect()
    if (!size) return
    const gap = 8
    setPlace({
      left: Math.max(gap, Math.min(at.x, window.innerWidth - size.width - gap)),
      top: Math.max(gap, Math.min(at.y, window.innerHeight - size.height - gap)),
    })
  }, [at.x, at.y])

  return { box, place }
}

/**
 * Меню дорожки.
 *
 * По полотну — что положить туда, где нажали: надпись и заливку. По колонке
 * с названием — что сделать с самой дорожкой: добавить соседнюю или убрать
 * эту. Прежде всё было одним меню, и «Удалить дорожку и всё на ней» лежало в
 * одном щелчке от «Добавить надпись» — промахнуться было легко.
 */
function TrackMenu({
  at,
  where,
  trackId,
  tracks,
  onClose,
  onRemove,
  onAdd,
  onFill,
  onText,
}: {
  at: { x: number; y: number }
  where: 'lane' | 'head'
  trackId: string
  tracks: ComposeTrack[]
  onClose: () => void
  onRemove: () => void
  onAdd: (kind: 'video' | 'audio') => void
  onFill: () => void
  onText: () => void
}) {
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [onClose])

  const { box, place } = useMenuPlace(at)

  const track = tracks.find((item) => item.id === trackId)
  if (!track) return null
  // Последнюю дорожку своего вида убрать нельзя: класть файлы стало бы некуда.
  // Не даём снять самую последнюю дорожку: на пустом таймлайне некуда было бы
  // положить файл. Последнюю звуковую или последнюю видео — можно: бывает
  // монтаж из одного только видео или одного только звука.
  const alone = tracks.length <= 1

  const item = (label: string, action: () => void, disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => {
        action()
        onClose()
      }}
      className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink-dim transition-colors enabled:hover:bg-surface-3 enabled:hover:text-ink disabled:opacity-35"
    >
      {label}
    </button>
  )

  return (
    <div
      ref={box}
      className="fixed z-50 min-w-[210px] rounded-xl border border-line bg-surface-2 p-1 shadow-xl"
      style={place}
      onContextMenu={(event) => event.preventDefault()}
    >
      {where === 'lane' ? (
        <>
          {/* На звуковой дорожке надписи и заливке не место — они лягут на
              видеодорожку, в то же время. */}
          {item('Добавить надпись сюда', onText)}
          {item('Добавить заливку сюда', onFill)}
        </>
      ) : (
        <>
          {item('Добавить видеодорожку', () => onAdd('video'), tracks.length >= MAX_TRACKS)}
          {item('Добавить звуковую дорожку', () => onAdd('audio'), tracks.length >= MAX_TRACKS)}
          <div className="my-1 h-px bg-line-soft" />
          {item(
            track.clips.length
              ? `Удалить дорожку и всё на ней (${track.clips.length})`
              : 'Удалить дорожку',
            onRemove,
            alone,
          )}
        </>
      )}
    </div>
  )
}

/**
 * Меню по правой кнопке: всё, что можно сделать с клипом, в одном месте.
 *
 * Клавиши помнить необязательно — они подписаны рядом с пунктами.
 */
function ClipMenu({
  at,
  clipId,
  onClose,
}: {
  at: { x: number; y: number }
  clipId: string
  onClose: () => void
}) {
  const state = useCompose()
  const { box, place } = useMenuPlace(at)
  const clip = state.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId)
  const many = state.selected.length > 1

  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [onClose])

  if (!clip) return null

  const item = (label: string, hint: string, action: () => void, disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => {
        action()
        onClose()
      }}
      className="flex w-full items-center justify-between gap-6 rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink-dim transition-colors enabled:hover:bg-surface-3 enabled:hover:text-ink disabled:opacity-35"
    >
      {label}
      <span className="font-mono text-[10px] text-ink-faint">{hint}</span>
    </button>
  )

  return (
    <div
      ref={box}
      className="fixed z-50 min-w-[210px] rounded-xl border border-line bg-surface-2 p-1 shadow-xl"
      style={place}
      onContextMenu={(event) => event.preventDefault()}
    >
      {item('Разрезать под иглой', 'S', () => state.splitAtPlayhead())}
      {item(
        many ? `Удалить выбранное (${state.selected.length})` : 'Удалить клип',
        'Del',
        () => state.removeClips(state.selected.length ? state.selected : [clipId]),
      )}
      <div className="my-1 h-px bg-line-soft" />
      {item('Копировать', 'Ctrl+C', () => state.copyClips(state.selected.length ? state.selected : [clipId]))}
      {item('Вставить от иглы', 'Ctrl+V', () => state.pasteClips(), !state.hasCopy())}
      {item('Сгруппировать', 'G', () => state.groupClips(state.selected), !many)}
      {item('Убрать из группы', 'U', () => state.ungroupClips(state.selected), !clip.groupId)}
      <div className="my-1 h-px bg-line-soft" />
      {clip.kind === 'audio'
        ? item(clip.muted ? 'Вернуть звук' : 'Заглушить', '', () =>
            state.updateClip(clipId, { muted: !clip.muted }),
          )
        : item('Вернуть приближение', '', () => state.updateClip(clipId, { zoom: 1 }), clip.zoom === 1)}
      {item(
        'Убрать затухания',
        '',
        () => state.updateClip(clipId, { fadeIn: 0, fadeOut: 0 }),
        !clip.fadeIn && !clip.fadeOut,
      )}
      {item(
        clip.kind === 'audio' ? 'Вернуть громкость' : 'Вернуть непрозрачность',
        '',
        () =>
          state.updateClip(clipId, clip.kind === 'audio' ? { volume: 1 } : { opacity: 1 }),
        clip.kind === 'audio' ? clip.volume === 1 : clip.opacity === 1,
      )}


      {(clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'audio') && (
        <>
          <div className="my-1 h-px bg-line-soft" />
          <EffectsSubmenu clipId={clipId} onClose={onClose} />
          {clip.kind !== 'audio' && (
            <>
              {item('Отразить по горизонтали', '', () => state.flipClips(pick(state, clipId), 'h'))}
              {item('Отразить по вертикали', '', () => state.flipClips(pick(state, clipId), 'v'))}
              {item('Повернуть на 90°', '', () => state.rotateClips(pick(state, clipId)))}
              {item('Обрезать…', '', () => {
                state.select([clipId])
                state.setCropping(clipId)
              })}
              {item('Маска…', '', () => {
                state.select([clipId])
                if (!clip.mask) {
                  state.mark()
                  state.updateClip(clipId, { mask: newMask(clip) })
                }
                state.setMasking(clipId)
              })}
            </>
          )}
          {clip.kind !== 'image' &&
            item(
              clip.reverse ? 'Играть как обычно' : 'Задом наперёд',
              '',
              () => state.reverseClips(pick(state, clipId)),
            )}
        </>
      )}

      {/* Размер и место в кадре задаются рамкой прямо в окне просмотра —
          выбранный клип можно взять и перетащить. Здесь остаётся только
          быстрый возврат: наигравшись, человек хочет вернуть как было. */}
      {clip.kind !== 'audio' && (
        <>
          <div className="my-1 h-px bg-line-soft" />
          {item(
            'Вернуть в кадр целиком',
            '',
            () => {
              for (const id of pick(state, clipId)) {
                state.updateClip(id, { size: 1, x: 0.5, y: 0.5 })
              }
            },
            clip.size === 1 && clip.x === 0.5 && clip.y === 0.5,
          )}
          {item(
            'Поставить посередине',
            '',
            () => {
              for (const id of pick(state, clipId)) state.updateClip(id, { x: 0.5, y: 0.5 })
            },
            clip.x === 0.5 && clip.y === 0.5,
          )}
        </>
      )}
    </div>
  )
}

/**
 * Пункт «Эффекты» с подменю сбоку.
 *
 * Все эффекты сразу в основном меню были бы перегрузом — поэтому они
 * раскрываются при наведении, как в обычных программах. У ролика со звуком
 * в подменю и эффекты картинки, и эффекты звука: каждый ляжет на свою
 * половину. Добавленный эффект сразу видно справа — клип выделяется.
 */
function EffectsSubmenu({ clipId, onClose }: { clipId: string; onClose: () => void }) {
  const state = useCompose()
  const [open, setOpen] = useState(false)
  const [left, setLeft] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (closing.current) clearTimeout(closing.current)
  }, [])
  const clip = state.findClip(clipId)?.clip
  if (!clip) return null
  const partner = state.partnerOf(clipId)
  const parts = [clip, partner].filter(Boolean) as ComposeClip[]

  const groups = (['video', 'audio'] as const)
    .map((target) => ({
      target,
      clip: parts.find((item) => targetOf(item.kind) === target),
    }))
    .filter((group) => group.clip)

  return (
    <div
      ref={row}
      className="relative"
      onMouseEnter={() => {
        if (closing.current) clearTimeout(closing.current)
        // У правого края окна подменю раскрывается влево, иначе уйдёт за экран.
        const box = row.current?.getBoundingClientRect()
        setLeft(Boolean(box && box.right + 240 > window.innerWidth))
        setOpen(true)
      }}
      // Закрываем не сразу: курсор, уходящий к подменю наискосок, успевает
      // задеть соседний пункт — и подменю пропадало, не дав себя выбрать.
      onMouseLeave={() => {
        closing.current = setTimeout(() => setOpen(false), 350)
      }}
    >
      <div
        className={`flex w-full items-center justify-between gap-6 rounded-md px-2.5 py-2 text-left text-[12px] ${
          open ? 'bg-surface-3 text-ink' : 'text-ink-dim'
        }`}
      >
        Эффекты
        <ChevronRight size={12} className="text-ink-faint" />
      </div>
      {open && (
        // Подменю стоит вплотную, а зазор между ним и строкой — прозрачный
        // отступ самого подменю: курсор по пути не выходит «в пустоту», и
        // подменю не закрывается.
        <div
          className={`absolute top-[-8px] z-10 ${left ? 'right-full pr-1' : 'left-full pl-1'}`}
        >
        <div className="min-w-[220px] rounded-xl border border-line bg-surface-2 p-1 shadow-xl">
          {groups.map((group, index) => {
            const taken = new Set((group.clip!.effects ?? []).map((effect) => effect.type))
            return (
              <div key={group.target}>
                {groups.length > 1 && (
                  <div
                    className={`px-2.5 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint ${
                      index ? 'mt-1 border-t border-line-soft pt-1.5' : 'pt-1'
                    }`}
                  >
                    {group.target === 'video' ? 'Картинка' : 'Звук'}
                  </div>
                )}
                {EFFECTS.filter((effect) => effect.target === group.target).map((effect) => (
                  <button
                    key={effect.type}
                    type="button"
                    disabled={taken.has(effect.type)}
                    title={taken.has(effect.type) ? 'Уже добавлен' : effect.hint}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => {
                      state.addEffect(group.clip!.id, effect.type, effectParams(effect.type))
                      // Выделяем клип: его эффекты откроются справа, где их и
                      // настраивают.
                      state.select([clipId])
                      onClose()
                    }}
                    className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink-dim transition-colors enabled:hover:bg-surface-3 enabled:hover:text-ink disabled:opacity-35"
                  >
                    {effect.name}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
        </div>
      )}
    </div>
  )
}

/**
 * К каким клипам относится правка из меню.
 *
 * Если выбрано несколько, правим все — человек обвёл их рамкой именно
 * затем. Если выбран другой клип, правим тот, по которому щёлкнули.
 */
function pick(state: { selected: string[] }, clipId: string): string[] {
  return state.selected.includes(clipId) ? state.selected : [clipId]
}

/**
 * Зоны, где соседние клипы наложились друг на друга.
 *
 * Каждая такая зона — переход: верхний клип в ней проявляется, нижний уходит.
 * Считается ровно так же, как на сервере при сборке, поэтому нарисованное
 * совпадает с тем, что окажется в файле.
 */
function crossfades(track: ComposeTrack): { from: number; to: number }[] {
  const clips = [...track.clips].sort((a, b) => a.start - b.start)
  const zones: { from: number; to: number }[] = []
  for (let index = 0; index < clips.length - 1; index++) {
    const lower = clips[index]
    const upper = clips[index + 1]
    const end = lower.start + lower.duration
    if (end > upper.start) zones.push({ from: upper.start, to: Math.min(end, upper.start + upper.duration) })
  }
  return zones
}

/** Какие клипы попали в рамку выделения. */
function clipsInside(
  tracks: ComposeTrack[],
  from: number,
  to: number,
  top: number,
  bottom: number,
): string[] {
  const caught: string[] = []
  // Линейка занимает верхние 24 пикселя, дорожки идут под ней.
  let offset = 24
  for (const track of tracks) {
    const height = track.kind === 'audio' ? AUDIO_HEIGHT : TRACK_HEIGHT
    const crossed = offset < bottom && offset + height > top
    if (crossed) {
      for (const clip of track.clips) {
        if (clip.start < to && clip.start + clip.duration > from) caught.push(clip.id)
      }
    }
    offset += height
  }
  return caught
}

/** Линейка с делениями и метками отрезка сборки. */
function Ruler({
  span,
  scale,
  renderIn,
  renderOut,
  duration,
  onSeek,
}: {
  span: number
  scale: number
  renderIn: number | null
  renderOut: number | null
  duration: number
  onSeek: (at: number) => void
}) {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const step = steps.find((value) => value * scale >= 70) ?? 900
  const marks: number[] = []
  for (let at = 0; at <= span; at += step) marks.push(at)

  const from = renderIn ?? 0
  const to = renderOut ?? duration
  const marked = renderIn !== null || renderOut !== null

  return (
    <div
      className="relative h-6 cursor-pointer border-b border-line-soft bg-surface"
      onMouseDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        onSeek(Math.max(0, (event.clientX - box.left) / scale))
      }}
    >
      {marked && (
        <div
          className="pointer-events-none absolute top-0 h-full bg-accent/20 ring-1 ring-inset ring-accent/50"
          style={{ left: from * scale, width: Math.max((to - from) * scale, 2) }}
        />
      )}
      {marks.map((at) => (
        <div key={at} className="absolute top-0 h-full" style={{ left: at * scale }}>
          <div className="h-2 w-px bg-line" />
          <span className="ml-1 font-mono text-[9.5px] tabular-nums text-ink-faint">
            {timecode(at)}
          </span>
        </div>
      ))}
    </div>
  )
}

// --- содержимое клипов ----------------------------------------------------
//
// Ленты кадров и звуковые волны берём у тех же адресов, что и медиатека, и
// держим в памяти: один файл на таймлайне встречается несколько раз (разрезали
// ролик — стало три клипа), и запрашивать одно и то же по разу на клип незачем.

const stripCache = new Map<string, FilmstripInfo | null>()
const waveCache = new Map<string, number[] | null>()

function useStrip(path: string, enabled: boolean): FilmstripInfo | null {
  const [strip, setStrip] = useState<FilmstripInfo | null>(() => stripCache.get(path) ?? null)
  useEffect(() => {
    if (!enabled || stripCache.has(path)) {
      setStrip(stripCache.get(path) ?? null)
      return
    }
    let alive = true
    api
      .filmstrip(path)
      .then((data) => {
        stripCache.set(path, data)
        if (alive) setStrip(data)
      })
      .catch(() => stripCache.set(path, null))
    return () => {
      alive = false
    }
  }, [path, enabled])
  return strip
}

/**
 * Точек волны просим по длине файла, а не поровну на все.
 *
 * Одно и то же число точек на тридцатисекундный ролик и на десятиминутную
 * запись даёт совсем разную подробность: у длинного файла волна вырождается в
 * несколько ступенек. Считаем примерно по сорок точек на секунду.
 */
function wavePoints(seconds: number): number {
  return Math.min(12000, Math.max(900, Math.round((seconds || 30) * 40)))
}

function useWave(path: string, enabled: boolean, seconds: number): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(() => waveCache.get(path) ?? null)
  useEffect(() => {
    if (!enabled || waveCache.has(path)) {
      setPeaks(waveCache.get(path) ?? null)
      return
    }
    let alive = true
    api
      .waveform(path, wavePoints(seconds))
      .then((data) => {
        waveCache.set(path, data.peaks ?? null)
        if (alive) setPeaks(data.peaks ?? null)
      })
      .catch(() => waveCache.set(path, null))
    return () => {
      alive = false
    }
  }, [path, enabled, seconds])
  return peaks
}

/** Кадры ролика внутри клипа, с учётом обрезанных краёв. */
function StripFill({ clip, strip }: { clip: ComposeClip; strip: FilmstripInfo }) {
  const whole = clip.sourceDuration || clip.duration
  // Лента нарисована на весь файл, а клип показывает его кусок: растягиваем
  // ленту во столько раз, во сколько кусок короче файла, и сдвигаем к началу
  // куска.
  const stretch = (whole / (clip.duration * speedOf(clip))) * 100
  const shift = (clip.sourceIn / whole) * 100
  return (
    <div className="absolute inset-0 overflow-hidden opacity-55">
      <div
        className="h-full origin-left"
        style={{
          width: `${stretch}%`,
          transform: `translateX(-${shift}%)`,
          backgroundImage: `url(${strip.url})`,
          backgroundSize: 'auto 100%',
          backgroundRepeat: 'repeat-x',
        }}
      />
    </div>
  )
}

/** Звуковая волна внутри клипа. */
function WaveFill({ clip, peaks }: { clip: ComposeClip; peaks: number[] }) {
  const whole = clip.sourceDuration || clip.duration
  const from = Math.floor((clip.sourceIn / whole) * peaks.length)
  const to = Math.ceil(((clip.sourceIn + clip.duration * speedOf(clip)) / whole) * peaks.length)
  const slice = peaks.slice(Math.max(0, from), Math.max(from + 1, to))
  if (!slice.length) return null

  const step = 100 / slice.length
  const top = slice.map((value, index) => `${index * step},${50 - value * 46}`).join(' ')
  const bottom = slice
    .map((value, index) => `${(slice.length - 1 - index) * step},${50 + slice[slice.length - 1 - index] * 46}`)
    .join(' ')

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <polygon points={`${top} ${bottom}`} className="fill-ok/70" />
    </svg>
  )
}

/** Прямоугольник клипа: кадры или волна, название, уголки. */
function ClipBox({
  clip,
  scale,
  height,
  active,
  onGrab,
  onMute,
  onLevel,
  onMenu,
}: {
  clip: ComposeClip
  scale: number
  height: number
  active: boolean
  onGrab: (event: React.MouseEvent, where: 'move' | 'left' | 'right' | 'fadeIn' | 'fadeOut') => void
  onMute: () => void
  onLevel: (top: number, height: number) => void
  onMenu: (event: React.MouseEvent) => void
}) {
  const sound = clip.kind === 'audio'
  const solid = clip.kind === 'color'
  // Файла на месте нет: клип остаётся, но помечен — чтобы было видно, что
  // именно не соберётся, и можно было удалить его или указать новое место.
  const lost = useCompose((state) => state.missing.includes(clip.source))
  // Сжатая дорожка: подписи и уголки в неё не помещаются.
  const short = height < TRACK_HEIGHT
  // У звука линия показывает громкость, у картинки — насколько она видна.
  const level = sound ? volumeShare(clip.volume) : clip.opacity
  // На сжатой дорожке клип высотой с полтора десятка пикселей, и всё, за
  // что его можно потянуть, лежит друг на друге: целясь в середину, попадаешь
  // то в затухание, то в громкость. Поэтому у сжатого клипа остаётся только
  // самое нужное — подвинуть и растянуть. Само затухание никуда не девается,
  // его по-прежнему видно треугольником: разверните дорожки, чтобы поправить.
  const box = Math.max(clip.duration * scale, 6)
  // Мелкому клипу лента кадров и волна не нужны — там нечего разглядывать,
  // а запрос стоит времени.
  const detailed = box > 40
  const strip = useStrip(clip.source, detailed && clip.kind === 'video')
  const peaks = useWave(clip.source, detailed && sound, clip.sourceDuration || clip.duration)
  const thumb = `/api/library/thumbnail?path=${encodeURIComponent(clip.source)}`

  const fadeInWidth = (clip.fadeIn / clip.duration) * box
  const fadeOutWidth = (clip.fadeOut / clip.duration) * box
  const corner = short ? 0 : FADE_CORNER

  return (
    <div
      // Углы у клипа прямые: скруглённые съедают края, и при плотной
      // раскладке — особенно на сжатых дорожках — непонятно, где кончается
      // один клип и начинается соседний.
      className={`group absolute top-1.5 overflow-hidden border ${
        active ? 'border-accent ring-1 ring-accent/50' : 'border-line-soft'
      }`}
      style={{ left: clip.start * scale, width: box, height: height - 12 }}
      onContextMenu={onMenu}
      onMouseDown={(event) => {
        if (event.button !== 0) return
        const area = event.currentTarget.getBoundingClientRect()
        const fromLeft = event.clientX - area.left
        const fromRight = area.right - event.clientX
        const fromTop = event.clientY - area.top
        // Верхние углы отданы затуханию, бока ниже них — длине клипа.
        if (corner > 0 && fromTop <= corner && fromLeft <= corner) return onGrab(event, 'fadeIn')
        if (corner > 0 && fromTop <= corner && fromRight <= corner) return onGrab(event, 'fadeOut')
        onGrab(
          event,
          fromLeft <= GRIP_PIXELS ? 'left' : fromRight <= GRIP_PIXELS ? 'right' : 'move',
        )
      }}
    >
      {solid ? (
        // У заливки нет ни кадров, ни файла — показываем её собственный цвет,
        // без затемнения сверху: по цвету её и находят среди других.
        <div className="absolute inset-0" style={{ background: clip.color }} />
      ) : clip.kind === 'text' ? (
        // Надпись — свой цвет, которого нет ни у дорожек, ни у заливки: иначе
        // тёмная надпись и тёмная заливка сливались, и было не понять, где что.
        <div className="absolute inset-0 bg-[#6b3fd1]/70" />
      ) : sound ? (
        <>
          <div className="absolute inset-0 bg-ok/12" />
          {peaks && <WaveFill clip={clip} peaks={peaks} />}
        </>
      ) : strip ? (
        <StripFill clip={clip} strip={strip} />
      ) : (
        <div
          className="absolute inset-0 bg-cover bg-center opacity-45"
          style={{ backgroundImage: `url(${thumb})` }}
        />
      )}
      {!solid && clip.kind !== 'text' && (
        <div className="absolute inset-0 bg-gradient-to-b from-surface-3/55 to-surface-3/80" />
      )}
      {lost && (
        <div
          className="absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(239,68,68,0.35)_0_6px,transparent_6px_12px)]"
          title={`Файл не найден: ${clip.source}`}
        />
      )}

      {/* Затухания: затемнённые треугольники по краям, как в монтажках. */}
      {clip.fadeIn > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-black/55"
          style={{ width: fadeInWidth, clipPath: 'polygon(0 0, 100% 0, 0 100%)' }}
        />
      )}
      {clip.fadeOut > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-black/55"
          style={{ width: fadeOutWidth, clipPath: 'polygon(100% 0, 100% 100%, 0 0)' }}
        />
      )}

      {/* Линия уровня, как на дорожке в медиатеке: у звука это громкость,
          у картинки — прозрачность. Тянется вверх-вниз. */}
      {/* Шторка приглушена, пока её не трогали: пока громкость обычная, она
          ничего не сообщает, а внимание забирает. Стоит увести её вниз — она
          проступает вместе с подписью. */}
      {short ? (
        // На сжатой дорожке шторку не тянут, но уровень всё равно показываем:
        // иначе приглушённый клип ничем не отличается от обычного.
        level < 1 && (
          <div
            className={`pointer-events-none absolute inset-x-0 h-[2px] ${
              sound ? 'bg-ok/70' : 'bg-accent-soft/70'
            }`}
            style={{ top: `${(1 - level) * 100}%` }}
          />
        )
      ) : (
      <div
        className="group/level absolute inset-x-0 z-10 cursor-ns-resize"
        style={{ top: `${(1 - level) * 100}%`, height: 9, marginTop: -4 }}
        title={
          sound
            ? `Громкость ${volumeLabel(clip.volume)} — тяните вверх или вниз`
            : `Непрозрачность ${Math.round(level * 100)}% — тяните вверх или вниз`
        }
        onMouseDown={(event) => {
          event.stopPropagation()
          const area = event.currentTarget.parentElement!.getBoundingClientRect()
          onLevel(area.top, area.height)
        }}
      >
        <div
          className={`mt-[3px] h-[3px] w-full transition-opacity ${
            sound ? 'bg-ok/90' : 'bg-accent-soft/90'
          } ${
            level >= 1
              ? 'opacity-20 group-hover/level:opacity-90 group-hover:opacity-60'
              : 'opacity-100'
          }`}
        />
        {/* Насколько убавлено — прямо на линии: иначе «на сколько тише» можно
            только гадать по её высоте. У нетронутой шторки писать нечего. */}
        {!short && box > 54 && level < 1 && (
          <span
            className="pointer-events-none absolute right-1 -top-[1px] rounded bg-black/55 px-1 font-mono text-[9px] leading-[11px] tabular-nums text-white/80"
          >
            {sound ? volumeLabel(clip.volume) : `${Math.round(level * 100)}%`}
          </span>
        )}
      </div>
      )}

      <div
        className={`relative flex h-full flex-col justify-between ${
          short ? 'px-1.5 py-0.5' : 'p-1.5'
        }`}
      >
        {/* Подпись с тенью: заливка бывает любого цвета, в том числе светлого,
            и без тени белые буквы на ней пропадали. */}
        <span className="flex items-center gap-1 truncate text-[10.5px] font-medium text-ink [text-shadow:0_1px_2px_rgba(0,0,0,0.75)]">
          {clip.kind === 'text' && (
            // Знак надписи: по нему её отличают от заливки и картинок.
            <Type size={11} className="shrink-0 text-white" />
          )}
          {sound && (
            <button
              type="button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onMute()
              }}
              title={clip.muted ? 'Включить звук клипа' : 'Заглушить клип'}
              className="shrink-0 text-ok hover:text-ink"
            >
              {clip.muted || clip.volume <= 0 ? <VolumeX size={11} /> : <Music2 size={11} />}
            </button>
          )}
          {clip.groupId && (
            // Знак группы: клип ходит не один. Без него группы работали, но
            // глазами их было не отличить от обычных клипов.
            <Link2 size={11} className="shrink-0 text-accent" />
          )}
          {/* Метка «fx»: у клипа есть включённые эффекты, отражение, поворот
              или он играет задом наперёд — иначе по таймлайну этого не видно. */}
          {((clip.effects ?? []).some((effect) => effect.on) ||
            clip.flipH ||
            clip.flipV ||
            Boolean(clip.rotate) ||
            isCropped(clip) ||
            Boolean(clip.mask?.on) ||
            clip.reverse) && (
            <span className="shrink-0 rounded bg-accent/30 px-1 font-mono text-[9px] leading-[13px] text-white">
              fx
            </span>
          )}
          {Math.abs(speedOf(clip) - 1) > 1e-3 && (
            // Скорость видно прямо на клипе: растянутый Ctrl клип иначе ничем
            // не отличается от обрезанного.
            <span className="shrink-0 rounded bg-warn/40 px-1 font-mono text-[9px] leading-[13px] text-white">
              ×{Math.round(speedOf(clip) * 100) / 100}
            </span>
          )}
          <span className="truncate">{clip.name}</span>
        </span>
        {!short && (
          <span className="font-mono text-[9.5px] tabular-nums text-ink-faint">
            {timecode(clip.duration, true)}
          </span>
        )}
      </div>

      {/* Уголки затухания — вверху, уголки длины — по бокам. На сжатой
          дорожке уголков нет вовсе: клип в полтора десятка пикселей они
          закрывали целиком, и взяться за него было нечем. */}
      {!short && (
        <>
          <div
            className="absolute left-0 top-0 cursor-nwse-resize"
            style={{ width: corner, height: corner }}
            title="Потяните вправо — плавное появление"
            onMouseDown={(event) => {
              event.stopPropagation()
              onGrab(event, 'fadeIn')
            }}
          >
            <div className="m-1 h-2 w-2 rounded-sm bg-accent/80 opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          <div
            className="absolute right-0 top-0 cursor-nesw-resize"
            style={{ width: corner, height: corner }}
            title="Потяните влево — плавный уход"
            onMouseDown={(event) => {
              event.stopPropagation()
              onGrab(event, 'fadeOut')
            }}
          >
            <div className="ml-auto mr-1 mt-1 h-2 w-2 rounded-sm bg-accent/80 opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
        </>
      )}
      {/* Края длины начинаются ниже уголков, иначе они спорят за одни пиксели. */}
      <div
        className="absolute bottom-0 left-0 w-2.5 cursor-ew-resize bg-accent/0 group-hover:bg-accent/25"
        style={{ top: corner }}
      />
      <div
        className="absolute bottom-0 right-0 w-2.5 cursor-ew-resize bg-accent/0 group-hover:bg-accent/25"
        style={{ top: corner }}
      />
    </div>
  )
}
