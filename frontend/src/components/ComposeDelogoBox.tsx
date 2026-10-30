import { useEffect, useRef } from 'react'
import { clipRect, useCompose, type ClipEffect, type ComposeClip } from '../composeStore'
import { useHandles } from '../lib/handles'
import { magnetOn } from '../lib/magnet'
import { BoxOutline } from './BoxOutline'

/**
 * Область эффекта «Убрать водяной знак» прямо в окне просмотра.
 *
 * Видна у выбранного клипа, пока у эффекта стоит «Показать область рамкой».
 * Тянешь край или уголок — меняется размер, тянешь за середину — область
 * едет по картинке. Числа в карточке эффекта меняются вместе с ней: место
 * задаётся долями картинки клипа (после поворота и отражения — как и у
 * сборки), поэтому рамка лежит на картинке, а не на кадре.
 */

type Side = 'l' | 't' | 'r' | 'b'

/** Меньше этой доли картинки область не делаем — её не ухватить. */
const MIN_SIZE = 0.01
/** Край прилипает к краю картинки и к её середине, если подвести близко. */
const STICK = 0.015

const HANDLES: { id: string; x: number; y: number; sides: Side[]; cursor: string }[] = [
  { id: 'nw', x: 0, y: 0, sides: ['l', 't'], cursor: 'nwse-resize' },
  { id: 'n', x: 0.5, y: 0, sides: ['t'], cursor: 'ns-resize' },
  { id: 'ne', x: 1, y: 0, sides: ['r', 't'], cursor: 'nesw-resize' },
  { id: 'e', x: 1, y: 0.5, sides: ['r'], cursor: 'ew-resize' },
  { id: 'se', x: 1, y: 1, sides: ['r', 'b'], cursor: 'nwse-resize' },
  { id: 's', x: 0.5, y: 1, sides: ['b'], cursor: 'ns-resize' },
  { id: 'sw', x: 0, y: 1, sides: ['l', 'b'], cursor: 'nesw-resize' },
  { id: 'w', x: 0, y: 0.5, sides: ['l'], cursor: 'ew-resize' },
]

function stickTo(value: number): number {
  if (!magnetOn()) return value
  for (const guide of [0, 0.5, 1]) if (Math.abs(value - guide) < STICK) return guide
  return value
}

/** Место области в долях картинки — из настроек эффекта (там проценты). */
function areaOf(effect: ClipEffect) {
  const number = (key: string, fallback: number) => {
    const value = Number(effect.params?.[key])
    return Number.isFinite(value) ? value / 100 : fallback
  }
  return { l: number('left', 0.75), t: number('top', 0.05), w: number('width', 0.2), h: number('height', 0.12) }
}

/** Эффекты водяного знака, чью область видно в кадре. */
export function shownDelogos(clip: ComposeClip): ClipEffect[] {
  return (clip.effects ?? []).filter(
    (effect) => effect.type === 'delogo' && effect.on && Number(effect.params?.show ?? 1) >= 0.5,
  )
}

export function ComposeDelogoBox({ clip, effect }: { clip: ComposeClip; effect: ClipEffect }) {
  const frameW = useCompose((state) => state.width)
  const frameH = useCompose((state) => state.height)
  const box = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const fit = useHandles(area)
  const { w: wide, h: tall } = clipRect(clip, frameW, frameH)
  const { l, t, w, h } = areaOf(effect)

  const drag = useRef<
    | { kind: 'sides'; sides: Side[] }
    | { kind: 'move'; fromX: number; fromY: number; l: number; t: number }
    | null
  >(null)

  useEffect(() => {
    const put = (next: { l: number; t: number; w: number; h: number }) => {
      // Проценты — как в карточке эффекта, с шагом в сотую долю процента.
      const percent = (value: number) => Math.round(value * 10000) / 100
      useCompose.getState().updateEffect(clip.id, effect.id, {
        params: { left: percent(next.l), top: percent(next.t), width: percent(next.w), height: percent(next.h) },
      })
    }
    const move = (event: MouseEvent) => {
      const current = drag.current
      const rect = box.current?.getBoundingClientRect()
      if (!current || !rect) return
      const found = useCompose.getState().findClip(clip.id)?.clip
      const now = found?.effects?.find((item) => item.id === effect.id)
      if (!now) return
      const was = areaOf(now)
      if (current.kind === 'move') {
        const dx = (event.clientX - current.fromX) / rect.width
        const dy = (event.clientY - current.fromY) / rect.height
        put({
          l: Math.min(1 - was.w, Math.max(0, stickTo(current.l + dx))),
          t: Math.min(1 - was.h, Math.max(0, stickTo(current.t + dy))),
          w: was.w,
          h: was.h,
        })
        return
      }
      // Курсор в долях картинки клипа.
      const atX = stickTo(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)))
      const atY = stickTo(Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)))
      let left = was.l
      let top = was.t
      let right = was.l + was.w
      let bottom = was.t + was.h
      for (const side of current.sides) {
        if (side === 'l') left = Math.min(right - MIN_SIZE, atX)
        if (side === 'r') right = Math.max(left + MIN_SIZE, atX)
        if (side === 't') top = Math.min(bottom - MIN_SIZE, atY)
        if (side === 'b') bottom = Math.max(top + MIN_SIZE, atY)
      }
      put({ l: left, t: top, w: right - left, h: bottom - top })
    }
    const drop = () => {
      drag.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', drop)
    }
  }, [clip.id, effect.id])

  const start = (event: React.MouseEvent) => {
    if (event.button !== 0) return false
    event.preventDefault()
    // Иначе нажатие досталось бы рамке клипа под областью и клип поехал бы.
    event.stopPropagation()
    useCompose.getState().mark()
    return true
  }

  const along = (share: number) => fit.along(share, true)

  return (
    <div
      ref={box}
      className="pointer-events-none absolute"
      style={{
        left: `${(clip.x - wide / 2) * 100}%`,
        top: `${(clip.y - tall / 2) * 100}%`,
        width: `${wide * 100}%`,
        height: `${tall * 100}%`,
      }}
    >
      <div
        ref={area}
        className="pointer-events-auto absolute cursor-move"
        style={{ left: `${l * 100}%`, top: `${t * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
        title="Область водяного знака: тяните за край или уголок, чтобы изменить, за середину — чтобы передвинуть"
        onMouseDown={(event) => {
          if (!start(event)) return
          drag.current = { kind: 'move', fromX: event.clientX, fromY: event.clientY, l, t }
        }}
      >
        <BoxOutline color="var(--color-warn)" width={2} unit={fit.unit} />
        {HANDLES.filter((handle) => (handle.x === 0.5 ? fit.midX : handle.y === 0.5 ? fit.midY : true)).map((handle) => (
          <div
            key={handle.id}
            className="absolute bg-warn"
            style={{
              ...fit.size,
              left: along(handle.x).pos,
              top: along(handle.y).pos,
              transform: `translate(${along(handle.x).shift}, ${along(handle.y).shift})`,
              cursor: handle.cursor,
            }}
            onMouseDown={(event) => {
              if (!start(event)) return
              drag.current = { kind: 'sides', sides: handle.sides }
            }}
          />
        ))}
        <span
          style={fit.label}
          className="pointer-events-none absolute left-0 whitespace-nowrap rounded bg-black/60 px-1.5 font-mono text-[9.5px] leading-[15px] tabular-nums text-white/85"
        >
          водяной знак · {Math.round(wide * w * frameW)} × {Math.round(tall * h * frameH)}
        </span>
      </div>
    </div>
  )
}
