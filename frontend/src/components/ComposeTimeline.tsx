import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  FlagTriangleLeft,
  FlagTriangleRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Headphones,
  Layers,
  Link2,
  Loader2,
  Music2 as MusicTrack,
  Music2,
  Pause,
  Play as PlayIcon,
  Repeat,
  Scissors,
  Trash2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { api } from '../lib/api'
import { timecode } from '../lib/format'
import type { FilmstripInfo } from '../lib/types'
import {
  clipEdges,
  magnets,
  MAX_TRACKS,
  MIN_CLIP_SECONDS,
  snap,
  trackColor,
  trackNumber,
  useCompose,
  type ComposeClip,
  type ComposeTrack,
} from '../composeStore'
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
/** А с этой — и ползунок уровня. */
const LEVEL_FROM = 118
/** Линейка времени над дорожками. */
export const RULER_HEIGHT = 24
/** Панель кнопок над таймлайном. */
export const TOOLBAR_HEIGHT = 36
/** Пустой запас справа, чтобы было куда тащить клипы. */
const TAIL_SECONDS = 8
/** Дальше половины клипа затухание не тянется — оно съело бы весь кусок. */
const MAX_FADE_RATIO = 0.5

type Drag =
  | { kind: 'move'; ids: string[]; grab: number; lastAt: number; row: number }
  | { kind: 'level'; id: string; top: number; height: number }
  | { kind: 'edge'; id: string; side: 'left' | 'right'; clip: ComposeClip }
  | { kind: 'fade'; id: string; side: 'in' | 'out'; clip: ComposeClip }
  | { kind: 'playhead' }
  | { kind: 'marquee'; fromAt: number; fromY: number }
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
  /** Файл притащили из медиатеки: путь, секунда и дорожка, куда его положили. */
  onDropFile: (path: string, at: number, trackId: string) => void
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
  const renderIn = useCompose((state) => state.renderIn)
  const renderOut = useCompose((state) => state.renderOut)
  const setPlayhead = useCompose((state) => state.setPlayhead)
  const setScale = useCompose((state) => state.setScale)
  const select = useCompose((state) => state.select)
  const splitAtPlayhead = useCompose((state) => state.splitAtPlayhead)
  const removeClips = useCompose((state) => state.removeClips)
  const addTrack = useCompose((state) => state.addTrack)
  const removeTrack = useCompose((state) => state.removeTrack)
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
  const [trackMenu, setTrackMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
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
        const share = 1 - (event.clientY - current.top) / current.height
        const value = Math.min(1, Math.max(0, share))
        const clip = state.findClip(current.id)?.clip
        if (clip) {
          state.updateClip(
            current.id,
            clip.kind === 'audio' ? { volume: value } : { opacity: value },
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

      if (current.side === 'right') {
        let end = snap(at, points, nearby)
        // У ролика нельзя взять больше, чем в нём есть.
        if (origin.sourceDuration) {
          end = Math.min(end, origin.start + (origin.sourceDuration - origin.sourceIn))
        }
        state.resizeClip(current.id, origin.start, end - origin.start, origin.sourceIn)
      } else {
        let begin = snap(at, points, nearby)
        begin = Math.min(begin, origin.start + origin.duration - MIN_CLIP_SECONDS)
        const shift = begin - origin.start
        // Тянем за левый край — у ролика вместе с началом уезжает и точка,
        // с которой он играет: иначе кусок «съезжал» бы по содержимому.
        const sourceIn = origin.kind === 'image' ? 0 : Math.max(0, origin.sourceIn + shift)
        const limited = origin.kind === 'image' ? begin : origin.start + (sourceIn - origin.sourceIn)
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
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const key = event.key.toLowerCase()
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
  }, [splitAtPlayhead, removeClips, markIn, markOut, groupClips, ungroupClips, player])

  /**
   * Колесо приближает и отдаляет — как в монтажных программах.
   *
   * Точка под курсором остаётся на месте: иначе на приближении нужный кусок
   * уезжает за край, и его приходится искать прокруткой.
   */
  const onWheel = (event: React.WheelEvent) => {
    event.preventDefault()
    const box = canvas.current?.getBoundingClientRect()
    const state = useCompose.getState()
    const under = box ? (event.clientX - box.left) / state.scale : 0
    const next = Math.min(400, Math.max(4, state.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15)))
    setScale(next)
    if (scroller.current && box) {
      const inside = event.clientX - scroller.current.getBoundingClientRect().left
      scroller.current.scrollLeft = Math.max(0, under * next - inside)
    }
  }

  const from = renderIn ?? 0
  const to = renderOut ?? duration
  // Звук в сборку не попадёт, если звучать нечему: клипы со звуком есть, но
  // все они либо заглушены, либо выкручены в ноль.
  const sounding = tracks.flatMap((track) => track.clips).filter(
    (clip) => clip.kind === 'audio' || (clip.kind === 'video' && clip.hasAudio && !clip.groupId),
  )
  const silent = sounding.length > 0 && sounding.every((clip) => clip.muted || clip.volume <= 0)

  return (
    <div className="flex h-full flex-col">
      {/* Панель инструментов */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line-soft px-3">
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
            здесь, рядом с кнопками просмотра, а не на мастер-шине. */}
        <div className="flex w-[86px] items-center gap-1" title={`Громкость прослушивания ${Math.round(player.volume * 100)}%`}>
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

        <span className="mx-1 h-4 w-px bg-line-soft" />

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

        <span className="mx-1 h-4 w-px bg-line-soft" />

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

        <span className="ml-1 font-mono text-[11px] tabular-nums text-ink-dim">
          {timecode(playhead, true)}
        </span>
        {renderIn !== null || renderOut !== null ? (
          <span className="text-[11px] text-accent-soft">
            соберётся {timecode(from, true)} → {timecode(to, true)}
          </span>
        ) : (
          <span className="text-[11px] text-ink-faint">из {timecode(duration, true)}</span>
        )}
        {selected.length > 1 && (
          <span className="text-[11px] text-accent-soft">выбрано: {selected.length}</span>
        )}
        {/* Ноль громкости у всех клипов означает «звука не будет вовсе» —
            то же правило, что и в медиатеке. Сказать об этом надо заранее, а
            не когда человек откроет готовый файл. */}
        {silent && (
          <span className="flex items-center gap-1.5 text-[11px] text-warn">
            <VolumeX size={12} />
            в файле не будет звука
          </span>
        )}
        {/* Чтение файла занимает мгновение, но без этого окно выглядит
            зависшим: человек бросил файл, а на дорожке пока пусто. */}
        {adding && (
          <span className="flex items-center gap-1.5 text-[11px] text-accent-soft">
            <Loader2 size={12} className="animate-spin" />
            добавляю файл…
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <IconButton
            title="Сжать дорожки, чтобы поместились все (Ё)"
            active={compact}
            onClick={() => setCompact(!compact)}
          >
            {compact ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
          </IconButton>
          <IconButton title="Отдалить (колесо мыши)" onClick={() => setScale(scale / 1.4)}>
            <ZoomOut size={14} />
          </IconButton>
          <IconButton title="Приблизить (колесо мыши)" onClick={() => setScale(scale * 1.4)}>
            <ZoomIn size={14} />
          </IconButton>
        </div>
      </div>

      {/* Слева названия дорожек, справа само полотно. Прокручиваются они
          вместе по высоте, а вбок — только полотно. */}
      <div className="flex min-h-0 flex-1 overflow-y-auto">
        <TrackHeads
          tracks={tracks}
          width={headWidth}
          onWidth={setHeadWidth}
          rowHeight={rowHeight}
          onRename={renameTrack}
          onLevel={setTrackLevel}
          onMenu={(event, id) => {
            event.preventDefault()
            setTrackMenu({ x: event.clientX, y: event.clientY, id })
          }}
        />

      <div
        ref={scroller}
        className="min-h-0 min-w-0 flex-1 overflow-x-auto"
        onWheel={onWheel}
      >
        <div ref={canvas} style={{ width }} className="relative select-none">
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
              className={`relative border-b border-line-soft ${
                track.kind === 'audio' ? 'bg-ok/5' : 'bg-surface-2/40'
              }`}
              style={{ height: rowHeight }}
              onMouseDown={(event) => {
                if (event.button !== 0 || event.target !== event.currentTarget) return
                const box = canvas.current?.getBoundingClientRect()
                if (!box) return
                // Нажатие по любому пустому месту ставит иглу — и над клипом,
                // и под ним, и между ними. Искать для этого узкую полоску
                // линейки не нужно. Рамка выделения осталась на Ctrl.
                if (event.ctrlKey || event.metaKey) {
                  select([])
                  drag.current = {
                    kind: 'marquee',
                    fromAt: secondsAt(event.clientX),
                    fromY: event.clientY - box.top,
                  }
                  return
                }
                select([])
                drag.current = { kind: 'playhead' }
                setPlayhead(
                  snap(
                    secondsAt(event.clientX),
                    clipEdges(tracks),
                    PLAYHEAD_SNAP / scale,
                  ),
                )
              }}
              onContextMenu={(event) => {
                if (event.target !== event.currentTarget) return
                event.preventDefault()
                setTrackMenu({ x: event.clientX, y: event.clientY, id: track.id })
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
                )
              }}
            >
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
                      }
                    } else if (where === 'fadeIn' || where === 'fadeOut') {
                      drag.current = {
                        kind: 'fade',
                        id: clip.id,
                        side: where === 'fadeIn' ? 'in' : 'out',
                        clip,
                      }
                    } else {
                      drag.current = { kind: 'edge', id: clip.id, side: where, clip }
                    }
                  }}
                  onMute={() => updateClip(clip.id, { muted: !clip.muted })}
                  onLevel={(top, height) => {
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
                    height: (track.kind === 'audio' ? AUDIO_HEIGHT : TRACK_HEIGHT) - 12,
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
          trackId={trackMenu.id}
          onClose={() => setTrackMenu(null)}
          onRemove={() => removeTrack(trackMenu.id)}
          onAdd={addTrack}
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
}: {
  tracks: ComposeTrack[]
  width: number
  onWidth: (value: number) => void
  rowHeight: number
  onRename: (id: string, name: string) => void
  onLevel: (id: string, level: number) => void
  onMenu: (event: React.MouseEvent, id: string) => void
}) {
  const grab = useRef<{ from: number; width: number } | null>(null)

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

  const roomy = width >= NAME_FROM
  // В сжатых дорожках ползунок встаёт рядом с названием, поэтому места ему
  // нужно больше: иначе от названия остаётся пара букв.
  const narrow = rowHeight < TRACK_HEIGHT
  const withLevel = width >= (narrow ? LEVEL_FROM + 40 : LEVEL_FROM)

  return (
    <div
      className="relative shrink-0 border-r border-line bg-surface"
      style={{ width }}
    >
      {/* Пустое место под линейкой: дорожки должны встать вровень с полотном. */}
      <div style={{ height: RULER_HEIGHT }} className="border-b border-line-soft" />

      {tracks.map((track) => {
        const colour = trackColor(tracks, track.id)
        const level = Math.round(track.level * 100)
        return (
          <div
            key={track.id}
            className="relative flex items-center gap-1.5 overflow-hidden border-b border-line-soft pr-1.5"
            style={{ height: rowHeight }}
            onContextMenu={(event) => onMenu(event, track.id)}
          >
            {/* Цветная полоса с номером — то, что остаётся при любой ширине. */}
            <span
              className="flex h-full w-[18px] shrink-0 items-center justify-center font-mono text-[10px] font-semibold text-black/70"
              style={{ background: colour }}
              title={track.kind === 'audio' ? 'Звуковая дорожка' : 'Видеодорожка'}
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
                  title="Название дорожки"
                  className={`min-w-0 truncate bg-transparent text-[11.5px] text-ink outline-none placeholder:text-ink-faint/60 ${
                    narrow ? 'flex-1' : 'w-full'
                  }`}
                />
                {withLevel && (
                  <div
                    className={`flex items-center gap-1.5 ${
                      narrow ? 'w-[76px] shrink-0' : ''
                    }`}
                  >
                    <input
                      type="range"
                      min={0}
                      max={200}
                      value={level}
                      onChange={(event) => onLevel(track.id, Number(event.target.value) / 100)}
                      // Двойное нажатие возвращает обычный уровень: задеть
                      // ползунок легко, а вспомнить, каким он был, — нет.
                      onDoubleClick={() => onLevel(track.id, 1)}
                      title={
                        track.kind === 'audio'
                          ? `Громкость дорожки ${level}%`
                          : `Насколько видно эту дорожку: ${level}%`
                      }
                      className="min-w-0 flex-1"
                    />
                    {!narrow && (
                      <span className="w-[30px] shrink-0 text-right font-mono text-[9.5px] tabular-nums text-ink-faint">
                        {level}%
                      </span>
                    )}
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

/** Меню дорожки: добавить соседнюю или убрать эту вместе с содержимым. */
function TrackMenu({
  at,
  trackId,
  tracks,
  onClose,
  onRemove,
  onAdd,
}: {
  at: { x: number; y: number }
  trackId: string
  tracks: ComposeTrack[]
  onClose: () => void
  onRemove: () => void
  onAdd: (kind: 'video' | 'audio') => void
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
  const alone = tracks.filter((item) => item.kind === track.kind).length <= 1

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

      {/* Размер и место в кадре — только у картинки: у звука кадра нет.
          Уменьшенный клип ложится поверх нижней дорожки — так делают
          «картинку в картинке». */}
      {clip.kind !== 'audio' && (
        <>
          <div className="my-1 h-px bg-line-soft" />
          <span className="block px-2.5 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-ink-faint">
            Размер в кадре
          </span>
          <div className="flex gap-1 px-1.5 pb-1">
            {SIZES.map((value) => (
              <button
                key={value}
                type="button"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => {
                  for (const id of pick(state, clipId)) state.updateClip(id, { size: value })
                  onClose()
                }}
                className={`flex-1 rounded-md py-1 text-[11px] transition-colors ${
                  Math.abs(clip.size - value) < 0.01
                    ? 'bg-accent/20 text-accent-soft'
                    : 'text-ink-dim hover:bg-surface-3 hover:text-ink'
                }`}
              >
                {Math.round(value * 100)}%
              </button>
            ))}
          </div>

          <span className="block px-2.5 pb-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
            Где стоит
          </span>
          <div className="grid grid-cols-3 gap-1 px-1.5 pb-1">
            {CORNERS.map((corner) => (
              <button
                key={corner.label}
                type="button"
                disabled={clip.size >= 1}
                title={clip.size >= 1 ? 'Сначала уменьшите клип' : corner.label}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => {
                  for (const id of pick(state, clipId)) {
                    state.updateClip(id, { x: corner.x, y: corner.y })
                  }
                  onClose()
                }}
                className={`h-6 rounded-md text-[10px] transition-colors disabled:opacity-30 ${
                  clip.size < 1 &&
                  Math.abs(clip.x - corner.x) < 0.01 &&
                  Math.abs(clip.y - corner.y) < 0.01
                    ? 'bg-accent/20 text-accent-soft'
                    : 'text-ink-faint enabled:hover:bg-surface-3 enabled:hover:text-ink'
                }`}
              >
                {corner.mark}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Доли кадра, которые есть смысл предлагать готовыми. */
const SIZES = [1, 0.5, 0.33, 0.25]

/** Девять мест в кадре: углы, середины сторон и центр. */
const CORNERS = [
  { label: 'Левый верхний угол', mark: '↖', x: 0, y: 0 },
  { label: 'Сверху посередине', mark: '↑', x: 0.5, y: 0 },
  { label: 'Правый верхний угол', mark: '↗', x: 1, y: 0 },
  { label: 'Слева посередине', mark: '←', x: 0, y: 0.5 },
  { label: 'В середине кадра', mark: '•', x: 0.5, y: 0.5 },
  { label: 'Справа посередине', mark: '→', x: 1, y: 0.5 },
  { label: 'Левый нижний угол', mark: '↙', x: 0, y: 1 },
  { label: 'Снизу посередине', mark: '↓', x: 0.5, y: 1 },
  { label: 'Правый нижний угол', mark: '↘', x: 1, y: 1 },
]

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

function useWave(path: string, enabled: boolean): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(() => waveCache.get(path) ?? null)
  useEffect(() => {
    if (!enabled || waveCache.has(path)) {
      setPeaks(waveCache.get(path) ?? null)
      return
    }
    let alive = true
    api
      .waveform(path)
      .then((data) => {
        waveCache.set(path, data.peaks ?? null)
        if (alive) setPeaks(data.peaks ?? null)
      })
      .catch(() => waveCache.set(path, null))
    return () => {
      alive = false
    }
  }, [path, enabled])
  return peaks
}

/** Кадры ролика внутри клипа, с учётом обрезанных краёв. */
function StripFill({ clip, strip }: { clip: ComposeClip; strip: FilmstripInfo }) {
  const whole = clip.sourceDuration || clip.duration
  // Лента нарисована на весь файл, а клип показывает его кусок: растягиваем
  // ленту во столько раз, во сколько кусок короче файла, и сдвигаем к началу
  // куска.
  const stretch = (whole / clip.duration) * 100
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
  const to = Math.ceil(((clip.sourceIn + clip.duration) / whole) * peaks.length)
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
  // У звука линия показывает громкость, у картинки — насколько она видна.
  const level = sound ? Math.min(1, clip.volume) : clip.opacity
  const box = Math.max(clip.duration * scale, 6)
  // Мелкому клипу лента кадров и волна не нужны — там нечего разглядывать,
  // а запрос стоит времени.
  const detailed = box > 40
  const strip = useStrip(clip.source, detailed && clip.kind === 'video')
  const peaks = useWave(clip.source, detailed && sound)
  const thumb = `/api/library/thumbnail?path=${encodeURIComponent(clip.source)}`

  const fadeInWidth = (clip.fadeIn / clip.duration) * box
  const fadeOutWidth = (clip.fadeOut / clip.duration) * box

  return (
    <div
      className={`group absolute top-1.5 overflow-hidden rounded-lg border ${
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
        if (fromTop <= FADE_CORNER && fromLeft <= FADE_CORNER) return onGrab(event, 'fadeIn')
        if (fromTop <= FADE_CORNER && fromRight <= FADE_CORNER) return onGrab(event, 'fadeOut')
        onGrab(
          event,
          fromLeft <= GRIP_PIXELS ? 'left' : fromRight <= GRIP_PIXELS ? 'right' : 'move',
        )
      }}
    >
      {sound ? (
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
      <div className="absolute inset-0 bg-gradient-to-b from-surface-3/55 to-surface-3/80" />

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
      <div
        className="absolute inset-x-0 z-10 cursor-ns-resize"
        style={{ top: `${(1 - level) * 100}%`, height: 9, marginTop: -4 }}
        title={
          sound
            ? `Громкость ${Math.round(level * 100)}% — тяните вверх или вниз`
            : `Непрозрачность ${Math.round(level * 100)}% — тяните вверх или вниз`
        }
        onMouseDown={(event) => {
          event.stopPropagation()
          const area = event.currentTarget.parentElement!.getBoundingClientRect()
          onLevel(area.top, area.height)
        }}
      >
        <div
          className={`mt-[3px] h-[3px] w-full ${
            sound ? 'bg-ok/90' : 'bg-accent-soft/90'
          } ${level >= 1 ? 'opacity-45' : 'opacity-100'}`}
        />
      </div>

      <div className="relative flex h-full flex-col justify-between p-1.5">
        <span className="flex items-center gap-1 truncate text-[10.5px] font-medium text-ink">
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
          <span className="truncate">{clip.name}</span>
        </span>
        <span className="font-mono text-[9.5px] tabular-nums text-ink-faint">
          {timecode(clip.duration, true)}
        </span>
      </div>

      {/* Уголки затухания — вверху, уголки длины — по бокам. */}
      <div
        className="absolute left-0 top-0 cursor-nwse-resize"
        style={{ width: FADE_CORNER, height: FADE_CORNER }}
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
        style={{ width: FADE_CORNER, height: FADE_CORNER }}
        title="Потяните влево — плавный уход"
        onMouseDown={(event) => {
          event.stopPropagation()
          onGrab(event, 'fadeOut')
        }}
      >
        <div className="ml-auto mr-1 mt-1 h-2 w-2 rounded-sm bg-accent/80 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      {/* Края длины начинаются ниже уголков, иначе они спорят за одни пиксели. */}
      <div
        className="absolute bottom-0 left-0 w-2.5 cursor-ew-resize bg-accent/0 group-hover:bg-accent/25"
        style={{ top: FADE_CORNER }}
      />
      <div
        className="absolute bottom-0 right-0 w-2.5 cursor-ew-resize bg-accent/0 group-hover:bg-accent/25"
        style={{ top: FADE_CORNER }}
      />
    </div>
  )
}
