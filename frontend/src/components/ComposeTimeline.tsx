import { useCallback, useEffect, useRef, useState } from 'react'
import {
  FlagTriangleLeft,
  FlagTriangleRight,
  Loader2,
  Music2,
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
/**
 * Уголок затухания. Заметно крупнее края растягивания и живёт только в
 * верхней части клипа: попадать в него мышью с точностью до пикселя не
 * придётся, а тянуть длину можно всей остальной высотой.
 */
const FADE_CORNER = 18
/** Игла липнет к краям клипов, но слабее, чем клипы друг к другу. */
const PLAYHEAD_SNAP = 6
/** Высота дорожек. Одинаковая: при монтаже звук не менее важен картинки. */
const TRACK_HEIGHT = 74
const AUDIO_HEIGHT = 74
/** Пустой запас справа, чтобы было куда тащить клипы. */
const TAIL_SECONDS = 8
/** Дальше половины клипа затухание не тянется — оно съело бы весь кусок. */
const MAX_FADE_RATIO = 0.5

type Drag =
  | { kind: 'move'; ids: string[]; grab: number; lastAt: number }
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
}: {
  /** Файл притащили из медиатеки: путь, секунда и дорожка, куда его положили. */
  onDropFile: (path: string, at: number, trackId: string) => void
  /** Файл сейчас читается — показываем, что программа занята, а не висит. */
  adding: boolean
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
  const updateClip = useCompose((state) => state.updateClip)
  const markIn = useCompose((state) => state.markIn)
  const markOut = useCompose((state) => state.markOut)
  const clearMarks = useCompose((state) => state.clearMarks)
  const groupClips = useCompose((state) => state.groupClips)
  const ungroupClips = useCompose((state) => state.ungroupClips)

  const [dropAt, setDropAt] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
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
      } else if (key === 'g' || key === 'п') {
        event.preventDefault()
        groupClips(useCompose.getState().selected)
      } else if (key === 'u' || key === 'г') {
        event.preventDefault()
        ungroupClips(useCompose.getState().selected)
      } else if (event.key === 'Delete') {
        const ids = useCompose.getState().selected
        if (ids.length) removeClips(ids)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [splitAtPlayhead, removeClips, markIn, markOut, groupClips, ungroupClips])

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
          <IconButton title="Отдалить (колесо мыши)" onClick={() => setScale(scale / 1.4)}>
            <ZoomOut size={14} />
          </IconButton>
          <IconButton title="Приблизить (колесо мыши)" onClick={() => setScale(scale * 1.4)}>
            <ZoomIn size={14} />
          </IconButton>
        </div>
      </div>

      {/* Полотно */}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
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
                    if (where === 'move') {
                      drag.current = { kind: 'move', ids, grab: at - clip.start, lastAt: at }
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

      {menu && (
        <ClipMenu
          at={menu}
          clipId={menu.id}
          onClose={() => setMenu(null)}
        />
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
      className="fixed z-50 min-w-[210px] rounded-xl border border-line bg-surface-2 p-1 shadow-xl"
      style={{ left: at.x, top: at.y }}
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
