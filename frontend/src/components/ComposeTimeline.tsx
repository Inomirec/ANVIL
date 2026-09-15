import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FlagTriangleLeft,
  FlagTriangleRight,
  Music2,
  Scissors,
  Trash2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { timecode } from '../lib/format'
import {
  magnets,
  MIN_CLIP_SECONDS,
  snap,
  useCompose,
  type ComposeClip,
  type ComposeTrack,
} from '../composeStore'
import { IconButton } from './ui'

/** Радиус прилипания и ширина уголка для растягивания, в пикселях. */
const SNAP_PIXELS = 8
const GRIP_PIXELS = 10
/** Высота дорожек: у звука она меньше — там нечего показывать, кроме имени. */
const TRACK_HEIGHT = 74
const AUDIO_HEIGHT = 52
/** Пустой запас справа, чтобы было куда тащить клипы. */
const TAIL_SECONDS = 8

type Drag =
  | { kind: 'move'; ids: string[]; grab: number; lastAt: number }
  | { kind: 'edge'; id: string; side: 'left' | 'right'; clip: ComposeClip }
  | { kind: 'playhead' }
  | { kind: 'marquee'; fromAt: number; fromY: number }
  | null

/**
 * Таймлайн монтажа: дорожки с клипами, игла, метки отрезка, зум.
 *
 * Привычки из монтажных программ: прилипание к соседям и к игле, зум колесом
 * с Ctrl, выделение рамкой, клавиши S (разрезать), I и O (метки отрезка).
 * Клипы не лежат друг на друге: когда один переносят на занятое место,
 * соседи расступаются, а не упираются в него.
 */
export function ComposeTimeline({
  onDropFile,
}: {
  /** Файл притащили из медиатеки: путь, секунда и дорожка, куда его положили. */
  onDropFile: (path: string, at: number, trackId: string) => void
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
  const markIn = useCompose((state) => state.markIn)
  const markOut = useCompose((state) => state.markOut)
  const clearMarks = useCompose((state) => state.clearMarks)

  const [dropAt, setDropAt] = useState<number | null>(null)
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const canvas = useRef<HTMLDivElement>(null)
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
        state.setPlayhead(at)
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

      if (current.kind === 'move') {
        // Один клип липнет к соседям и к игле, у пачки прилипание только
        // мешало бы: у каждого клипа свои края, и к чему липнуть — непонятно.
        if (current.ids.length === 1) {
          const found = state.findClip(current.ids[0])
          if (!found) return
          const points = magnets(found.track, current.ids, state.playhead)
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
      const points = magnets(found.track, [current.id], state.playhead)
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
        const box = canvas.current?.getBoundingClientRect()
        const area = marquee
        if (area && box) {
          const from = Math.min(area.x1, area.x2) / useCompose.getState().scale
          const to = Math.max(area.x1, area.x2) / useCompose.getState().scale
          const top = Math.min(area.y1, area.y2)
          const bottom = Math.max(area.y1, area.y2)
          const caught = clipsInside(useCompose.getState().tracks, from, to, top, bottom)
          useCompose.getState().select(caught)
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
  }, [secondsAt, marquee])

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
      } else if (event.key === 'Delete') {
        const ids = useCompose.getState().selected
        if (ids.length) removeClips(ids)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [splitAtPlayhead, removeClips, markIn, markOut])

  const onWheel = (event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.shiftKey) return
    event.preventDefault()
    setScale(scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2))
  }

  const from = renderIn ?? 0
  const to = renderOut ?? duration

  return (
    <div className="flex h-full flex-col">
      {/* Панель инструментов */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line-soft px-3">
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

        <div className="ml-auto flex items-center gap-1">
          <IconButton title="Отдалить" onClick={() => setScale(scale / 1.4)}>
            <ZoomOut size={14} />
          </IconButton>
          <IconButton title="Приблизить" onClick={() => setScale(scale * 1.4)}>
            <ZoomIn size={14} />
          </IconButton>
        </div>
      </div>

      {/* Полотно */}
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden" onWheel={onWheel}>
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
              style={{ height: track.kind === 'audio' ? AUDIO_HEIGHT : TRACK_HEIGHT }}
              onMouseDown={(event) => {
                // Нажали по пустому месту дорожки — тянем рамку выделения.
                if (event.button !== 0 || event.target !== event.currentTarget) return
                const box = canvas.current?.getBoundingClientRect()
                if (!box) return
                select([])
                drag.current = {
                  kind: 'marquee',
                  fromAt: secondsAt(event.clientX),
                  fromY: event.clientY - box.top,
                }
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
                  snap(at, magnets(track, [], playhead), (SNAP_PIXELS * 2) / scale),
                  track.id,
                )
              }}
            >
              {track.clips.map((clip) => (
                <ClipBox
                  key={clip.id}
                  clip={clip}
                  scale={scale}
                  height={track.kind === 'audio' ? AUDIO_HEIGHT : TRACK_HEIGHT}
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
                    drag.current =
                      where === 'move'
                        ? { kind: 'move', ids, grab: at - clip.start, lastAt: at }
                        : { kind: 'edge', id: clip.id, side: where, clip }
                  }}
                />
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
  )
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
      {/* Отрезок, который уйдёт в сборку */}
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

/** Прямоугольник клипа: миниатюра, название, уголки для растягивания. */
function ClipBox({
  clip,
  scale,
  height,
  active,
  onGrab,
}: {
  clip: ComposeClip
  scale: number
  height: number
  active: boolean
  onGrab: (event: React.MouseEvent, where: 'move' | 'left' | 'right') => void
}) {
  const sound = clip.kind === 'audio'
  const thumb = `/api/library/thumbnail?path=${encodeURIComponent(clip.source)}`
  return (
    <div
      className={`group absolute top-1.5 overflow-hidden rounded-lg border ${
        active ? 'border-accent ring-1 ring-accent/50' : 'border-line-soft'
      }`}
      style={{
        left: clip.start * scale,
        width: Math.max(clip.duration * scale, 6),
        height: height - 12,
      }}
      onMouseDown={(event) => {
        if (event.button !== 0) return
        const box = event.currentTarget.getBoundingClientRect()
        const fromLeft = event.clientX - box.left
        const fromRight = box.right - event.clientX
        onGrab(
          event,
          fromLeft <= GRIP_PIXELS ? 'left' : fromRight <= GRIP_PIXELS ? 'right' : 'move',
        )
      }}
    >
      {sound ? (
        <div className="absolute inset-0 bg-ok/15" />
      ) : (
        <>
          <div
            className="absolute inset-0 bg-cover bg-center opacity-45"
            style={{ backgroundImage: `url(${thumb})` }}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-surface-3/70 to-surface-3/90" />
        </>
      )}
      <div className="relative flex h-full flex-col justify-between p-1.5">
        <span className="flex items-center gap-1 truncate text-[10.5px] font-medium text-ink">
          {sound && <Music2 size={10} className="shrink-0 text-ok" />}
          {(clip.muted || clip.volume === 0) && sound && (
            <VolumeX size={10} className="shrink-0 text-ink-faint" />
          )}
          <span className="truncate">{clip.name}</span>
        </span>
        <span className="font-mono text-[9.5px] tabular-nums text-ink-faint">
          {timecode(clip.duration, true)}
        </span>
      </div>
      {/* Уголки: курсор меняется, чтобы было понятно, что край можно тянуть. */}
      <div className="absolute inset-y-0 left-0 w-2.5 cursor-ew-resize bg-accent/0 group-hover:bg-accent/30" />
      <div className="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize bg-accent/0 group-hover:bg-accent/30" />
    </div>
  )
}
