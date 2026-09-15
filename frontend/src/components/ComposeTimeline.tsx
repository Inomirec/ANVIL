import { useCallback, useEffect, useRef, useState } from 'react'
import { Scissors, Trash2, ZoomIn, ZoomOut } from 'lucide-react'
import { timecode } from '../lib/format'
import {
  limitStart,
  magnets,
  MIN_CLIP_SECONDS,
  snap,
  useCompose,
  type ComposeClip,
} from '../composeStore'
import { IconButton } from './ui'

/** Радиус прилипания и ширина уголка для растягивания, в пикселях. */
const SNAP_PIXELS = 8
const GRIP_PIXELS = 10
/** Высота дорожки. */
const TRACK_HEIGHT = 74
/** Пустой запас справа, чтобы было куда тащить клипы. */
const TAIL_SECONDS = 8

type Drag =
  | { kind: 'move'; id: string; grabbedAt: number; origin: number }
  | { kind: 'edge'; id: string; side: 'left' | 'right'; startX: number; clip: ComposeClip }
  | { kind: 'playhead' }
  | null

/**
 * Таймлайн монтажа: дорожка с клипами, игла, зум.
 *
 * От таймлайна одного файла отличается тем, что здесь живут отдельные куски,
 * которые можно двигать, тянуть за края и резать. Общее у них — привычки из
 * монтажных программ: прилипание к соседям и к игле, зум колесом.
 */
export function ComposeTimeline({
  onDropFile,
}: {
  /** Файл притащили из медиатеки: путь и секунда, куда его положили. */
  onDropFile: (path: string, at: number) => void
}) {
  const tracks = useCompose((state) => state.tracks)
  const playhead = useCompose((state) => state.playhead)
  const selected = useCompose((state) => state.selected)
  const scale = useCompose((state) => state.scale)
  const setPlayhead = useCompose((state) => state.setPlayhead)
  const setScale = useCompose((state) => state.setScale)
  const select = useCompose((state) => state.select)
  const moveClip = useCompose((state) => state.moveClip)
  const resizeClip = useCompose((state) => state.resizeClip)
  const splitAtPlayhead = useCompose((state) => state.splitAtPlayhead)
  const removeClip = useCompose((state) => state.removeClip)

  const [dropAt, setDropAt] = useState<number | null>(null)
  const lane = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag>(null)

  const duration = tracks.reduce(
    (longest, track) =>
      track.clips.reduce((value, clip) => Math.max(value, clip.start + clip.duration), longest),
    0,
  )
  const span = Math.max(duration + TAIL_SECONDS, 20)
  const width = span * scale

  /** Секунда под курсором. Считается от левого края дорожки с учётом прокрутки. */
  const secondsAt = useCallback(
    (clientX: number) => {
      const box = lane.current?.getBoundingClientRect()
      if (!box) return 0
      const scroll = lane.current?.parentElement?.scrollLeft ?? 0
      return Math.max(0, (clientX - box.left + scroll) / scale)
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

      const found = state.findClip(current.id)
      if (!found) return
      const { clip, track } = found
      const points = magnets(track, clip.id, state.playhead)
      const nearby = SNAP_PIXELS / state.scale

      if (current.kind === 'move') {
        const wanted = snap(at - current.grabbedAt, points, nearby)
        state.moveClip(clip.id, limitStart(track, clip, wanted))
        return
      }

      const origin = current.clip
      if (current.side === 'right') {
        let end = snap(at, points, nearby)
        // У ролика нельзя взять больше, чем в нём есть.
        if (origin.sourceDuration) {
          end = Math.min(end, origin.start + (origin.sourceDuration - origin.sourceIn))
        }
        state.resizeClip(clip.id, 'right', origin.start, end - origin.start, origin.sourceIn)
      } else {
        let begin = snap(at, points, nearby)
        begin = Math.min(begin, origin.start + origin.duration - MIN_CLIP_SECONDS)
        const shift = begin - origin.start
        // Тянем за левый край — у ролика вместе с началом уезжает и точка,
        // с которой он играет: иначе кусок «съезжал» бы по содержимому.
        const sourceIn = origin.kind === 'image' ? 0 : Math.max(0, origin.sourceIn + shift)
        const limited = origin.kind === 'image' ? begin : origin.start + (sourceIn - origin.sourceIn)
        state.resizeClip(
          clip.id,
          'left',
          Math.max(0, limited),
          origin.duration - (limited - origin.start),
          sourceIn,
        )
      }
    }

    const onUp = () => {
      drag.current = null
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [secondsAt])

  // Клавиши как в монтажных программах: разрезать и удалить.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (event.key === 's' || event.key === 'ы') {
        event.preventDefault()
        splitAtPlayhead()
      }
      if (event.key === 'Delete') {
        const id = useCompose.getState().selected
        if (id) removeClip(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [splitAtPlayhead, removeClip])

  const onWheel = (event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.shiftKey) return
    event.preventDefault()
    setScale(scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2))
  }

  return (
    <div className="flex h-full flex-col">
      {/* Панель инструментов */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-soft px-3">
        <IconButton
          title="Разрезать клип под иглой (S)"
          onClick={() => splitAtPlayhead()}
        >
          <Scissors size={14} />
        </IconButton>
        <IconButton
          title="Удалить выбранный клип (Delete)"
          onClick={() => selected && removeClip(selected)}
          disabled={!selected}
        >
          <Trash2 size={14} />
        </IconButton>
        <span className="ml-1 font-mono text-[11px] tabular-nums text-ink-dim">
          {timecode(playhead, true)}
        </span>
        <span className="text-[11px] text-ink-faint">из {timecode(duration, true)}</span>

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
        <div style={{ width }} className="relative select-none">
          {/* Линейка времени */}
          <Ruler
            span={span}
            scale={scale}
            onSeek={(at) => {
              drag.current = { kind: 'playhead' }
              setPlayhead(at)
            }}
          />

          {tracks.map((track) => (
            <div
              key={track.id}
              ref={lane}
              className="relative border-b border-line-soft bg-surface-2/40"
              style={{ height: TRACK_HEIGHT }}
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
                  snap(at, magnets(track, '', playhead), SNAP_PIXELS * 2 / scale),
                )
              }}
            >
              {track.clips.map((clip) => (
                <ClipBox
                  key={clip.id}
                  clip={clip}
                  scale={scale}
                  active={clip.id === selected}
                  onGrab={(event, where) => {
                    select(clip.id)
                    drag.current =
                      where === 'move'
                        ? {
                            kind: 'move',
                            id: clip.id,
                            grabbedAt: secondsAt(event.clientX) - clip.start,
                            origin: clip.start,
                          }
                        : { kind: 'edge', id: clip.id, side: where, startX: event.clientX, clip }
                  }}
                />
              ))}

              {/* Куда ляжет файл, который сейчас тащат */}
              {dropAt !== null && (
                <div
                  className="pointer-events-none absolute top-0 h-full w-0.5 bg-accent"
                  style={{ left: dropAt * scale }}
                />
              )}
            </div>
          ))}

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

/** Линейка с делениями. Шаг подбирается так, чтобы подписи не сливались. */
function Ruler({
  span,
  scale,
  onSeek,
}: {
  span: number
  scale: number
  onSeek: (at: number) => void
}) {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const step = steps.find((value) => value * scale >= 70) ?? 900
  const marks: number[] = []
  for (let at = 0; at <= span; at += step) marks.push(at)

  return (
    <div
      className="relative h-6 cursor-pointer border-b border-line-soft bg-surface"
      onMouseDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        const scroll = event.currentTarget.parentElement?.parentElement?.scrollLeft ?? 0
        onSeek(Math.max(0, (event.clientX - box.left + scroll) / scale))
      }}
    >
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
  active,
  onGrab,
}: {
  clip: ComposeClip
  scale: number
  active: boolean
  onGrab: (event: React.MouseEvent, where: 'move' | 'left' | 'right') => void
}) {
  const thumb = `/api/library/thumbnail?path=${encodeURIComponent(clip.source)}`
  return (
    <div
      className={`group absolute top-1.5 overflow-hidden rounded-lg border ${
        active ? 'border-accent ring-1 ring-accent/50' : 'border-line-soft'
      }`}
      style={{
        left: clip.start * scale,
        width: Math.max(clip.duration * scale, 6),
        height: TRACK_HEIGHT - 12,
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
      <div
        className="absolute inset-0 bg-cover bg-center opacity-45"
        style={{ backgroundImage: `url(${thumb})` }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-surface-3/70 to-surface-3/90" />
      <div className="relative flex h-full flex-col justify-between p-1.5">
        <span className="truncate text-[10.5px] font-medium text-ink">{clip.name}</span>
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
