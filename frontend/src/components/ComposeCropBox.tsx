import { useEffect, useRef } from 'react'
import { clipRect, shownAt, useCompose, type ComposeClip } from '../composeStore'
import { useHandles } from '../lib/handles'
import { BoxOutline } from './BoxOutline'

/**
 * Обрезка клипа прямо в окне просмотра.
 *
 * Пока клип обрезают, кадр под иглой собирается без его обрезки (см.
 * `ComposeTab`), а отрезаемое здесь затемнено: видно и то, что остаётся, и то,
 * что уходит. Тянешь край или уголок — отрезается край картинки; тянешь за
 * середину — окно обрезки едет по картинке, не меняя размера. Место и размер
 * клипа в кадре при этом не меняются: отрезанное просто станет прозрачным.
 *
 * Выйти — Enter, Esc или кнопка «Готово» справа. Двойное нажатие внутри
 * рамки убирает обрезку совсем.
 */

type Side = 'l' | 't' | 'r' | 'b'

/** Меньше этой доли картинки не оставляем — иначе рамку не ухватить. */
const MIN_KEEP = 0.05
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
  for (const guide of [0, 0.5, 1]) if (Math.abs(value - guide) < STICK) return guide
  return value
}

export function ComposeCropBox({ clip }: { clip: ComposeClip }) {
  const frameW = useCompose((state) => state.width)
  const frameH = useCompose((state) => state.height)
  const setCropping = useCompose((state) => state.setCropping)
  const box = useRef<HTMLDivElement>(null)
  // Окно обрезки: по нему меряются ручки — экранного размера, у мелкого
  // окна снаружи.
  const window_ = useRef<HTMLDivElement>(null)
  const fit = useHandles(window_)
  const { w: wide, h: tall } = clipRect(clip, frameW, frameH)

  const left = clip.cropLeft ?? 0
  const top = clip.cropTop ?? 0
  const right = clip.cropRight ?? 0
  const bottom = clip.cropBottom ?? 0

  const drag = useRef<
    | { kind: 'sides'; sides: Side[] }
    | { kind: 'move'; fromX: number; fromY: number; l: number; t: number; r: number; b: number }
    | null
  >(null)

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const current = drag.current
      const area = box.current?.getBoundingClientRect()
      if (!current || !area) return
      const state = useCompose.getState()
      // Курсор в долях самой картинки клипа.
      const atX = (event.clientX - area.left) / area.width
      const atY = (event.clientY - area.top) / area.height
      const found = state.findClip(clip.id)?.clip
      if (!found) return
      // Обрезка под иглой — у неё могут быть ключи.
      const now = shownAt(found, state.playhead)
      const l = now.cropLeft ?? 0
      const t = now.cropTop ?? 0
      const r = now.cropRight ?? 0
      const b = now.cropBottom ?? 0

      if (current.kind === 'move') {
        // Окно обрезки едет по картинке целиком, не выходя за её края.
        const dx = (event.clientX - current.fromX) / area.width
        const dy = (event.clientY - current.fromY) / area.height
        const shiftX = Math.min(current.r, Math.max(-current.l, dx))
        const shiftY = Math.min(current.b, Math.max(-current.t, dy))
        state.applyValues(clip.id, {
          cropLeft: current.l + shiftX,
          cropRight: current.r - shiftX,
          cropTop: current.t + shiftY,
          cropBottom: current.b - shiftY,
        })
        return
      }

      const patch: Record<string, number> = {}
      for (const side of current.sides) {
        if (side === 'l') patch.cropLeft = Math.min(1 - r - MIN_KEEP, Math.max(0, stickTo(atX)))
        if (side === 'r') patch.cropRight = Math.min(1 - l - MIN_KEEP, Math.max(0, 1 - stickTo(atX)))
        if (side === 't') patch.cropTop = Math.min(1 - b - MIN_KEEP, Math.max(0, stickTo(atY)))
        if (side === 'b') patch.cropBottom = Math.min(1 - t - MIN_KEEP, Math.max(0, 1 - stickTo(atY)))
      }
      // Правка ложится в ключ под иглой: так обрезку подстраивают под
      // разные сцены.
      state.applyValues(clip.id, patch)
    }
    const drop = () => {
      drag.current = null
    }
    const keys = (event: KeyboardEvent) => {
      // Enter в поле числа — это ввод числа, а не «готово».
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault()
        setCropping(null)
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
    window.addEventListener('keydown', keys)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', drop)
      window.removeEventListener('keydown', keys)
    }
  }, [clip.id, setCropping])

  const start = (event: React.MouseEvent) => {
    if (event.button !== 0) return false
    event.preventDefault()
    event.stopPropagation()
    useCompose.getState().mark()
    return true
  }

  const along = (share: number) => fit.along(share, true)

  const shade = 'absolute bg-black/60 pointer-events-none'

  return (
    <div
      ref={box}
      className="absolute"
      style={{
        left: `${(clip.x - wide / 2) * 100}%`,
        top: `${(clip.y - tall / 2) * 100}%`,
        width: `${wide * 100}%`,
        height: `${tall * 100}%`,
      }}
    >
      {/* Отрезаемое — затемнено: видно, что уходит. */}
      <div className={shade} style={{ left: 0, top: 0, width: '100%', height: `${top * 100}%` }} />
      <div className={shade} style={{ left: 0, bottom: 0, width: '100%', height: `${bottom * 100}%` }} />
      <div
        className={shade}
        style={{ left: 0, top: `${top * 100}%`, width: `${left * 100}%`, height: `${(1 - top - bottom) * 100}%` }}
      />
      <div
        className={shade}
        style={{ right: 0, top: `${top * 100}%`, width: `${right * 100}%`, height: `${(1 - top - bottom) * 100}%` }}
      />
      {/* Граница всей картинки — чтобы было видно, откуда режем. */}
      <div className="pointer-events-none absolute inset-0 border border-dashed border-white/40" />

      <div
        ref={window_}
        className="absolute cursor-move"
        style={{
          left: `${left * 100}%`,
          top: `${top * 100}%`,
          width: `${(1 - left - right) * 100}%`,
          height: `${(1 - top - bottom) * 100}%`,
        }}
        title="Обрезка: тяните края и уголки. За середину — сдвинуть окно обрезки. Двойное нажатие — убрать обрезку. Enter или Esc — готово"
        onDoubleClick={() =>
          useCompose.getState().applyValues(clip.id, { cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 })
        }
        onMouseDown={(event) => {
          if (!start(event)) return
          drag.current = { kind: 'move', fromX: event.clientX, fromY: event.clientY, l: left, t: top, r: right, b: bottom }
        }}
      >
        <BoxOutline color="var(--color-accent-soft)" width={2} unit={fit.unit} />
        {HANDLES.filter((handle) => (handle.x === 0.5 ? fit.midX : handle.y === 0.5 ? fit.midY : true)).map((handle) => (
          <div
            key={handle.id}
            className="absolute bg-accent-soft"
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
        {/* Сколько останется в пикселях кадра — как у рамки размера. */}
        <span style={fit.label}
          className="pointer-events-none absolute left-0 whitespace-nowrap rounded bg-black/60 px-1.5 font-mono text-[9.5px] leading-[15px] tabular-nums text-white/85">
          обрезка · {Math.round(wide * (1 - left - right) * frameW)} × {Math.round(tall * (1 - top - bottom) * frameH)}
        </span>
      </div>
    </div>
  )
}
