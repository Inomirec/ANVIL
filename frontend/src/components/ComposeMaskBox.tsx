import { useEffect, useRef, useState } from 'react'
import { clipRect, useCompose, type ClipMask, type ComposeClip } from '../composeStore'
import { POINTS } from '../composeAnim'
import { useHandles } from '../lib/handles'
import { BoxOutline } from './BoxOutline'

/**
 * Маска клипа в окне просмотра: её двигают и растягивают прямо по кадру.
 *
 * Результат виден сразу — кадр собирается с маской, как и в готовом файле, —
 * а поверх лежит контур формы с ручками. Тянешь за середину — маска едет,
 * за край или уголок — меняется размер, противоположная сторона стоит на
 * месте. Правка ложится в ключ под иглой: маску можно вести за лицом.
 *
 * Своя форма рисуется точками: нажатие ставит точку, нажатие по первой
 * замыкает форму. Готовую форму можно поправить, перетаскивая точки.
 *
 * Выйти — Enter, Esc или кнопка «Готово» в колонке справа.
 */

type Side = 'l' | 't' | 'r' | 'b'

const MIN = 0.03
/** Насколько близко к первой точке надо нажать, чтобы замкнуть форму, в пикселях. */
const CLOSE_PIXELS = 10

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

/** Прямоугольник вокруг точек и сами точки в его долях. */
function frameOf(points: [number, number][]): {
  box: { x: number; y: number; w: number; h: number }
  inside: [number, number][]
} {
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const w = Math.max(MIN, Math.max(...xs) - left)
  const h = Math.max(MIN, Math.max(...ys) - top)
  return {
    box: { x: left + w / 2, y: top + h / 2, w, h },
    inside: points.map(([x, y]) => [(x - left) / w, (y - top) / h]),
  }
}

export function ComposeMaskBox({ clip }: { clip: ComposeClip }) {
  const frameW = useCompose((state) => state.width)
  const frameH = useCompose((state) => state.height)
  const setMasking = useCompose((state) => state.setMasking)
  const box = useRef<HTMLDivElement>(null)
  // Ручки и точки — экранного размера при любом приближении: внешняя рамка
  // меряет картинку клипа, внутренняя — прямоугольник маски.
  const maskArea = useRef<HTMLDivElement>(null)
  const outer = useHandles(box)
  const fit = useHandles(maskArea)
  const { w: wide, h: tall } = clipRect(clip, frameW, frameH)
  const mask = clip.mask
  // Точки своей формы, пока её рисуют, — в долях картинки клипа.
  const [draft, setDraft] = useState<[number, number][]>([])
  const drawing = mask?.shape === 'custom' && (mask.points?.length ?? 0) < 3

  const drag = useRef<
    | { kind: 'sides'; sides: Side[]; start: ClipMask }
    | { kind: 'move'; fromX: number; fromY: number; start: ClipMask }
    | { kind: 'point'; index: number; start: ClipMask }
    | null
  >(null)

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const current = drag.current
      const area = box.current?.getBoundingClientRect()
      if (!current || !area || !area.width || !area.height) return
      const state = useCompose.getState()
      const m = current.start
      const atX = (event.clientX - area.left) / area.width
      const atY = (event.clientY - area.top) / area.height
      if (current.kind === 'move') {
        const dx = (event.clientX - current.fromX) / area.width
        const dy = (event.clientY - current.fromY) / area.height
        state.applyValues(clip.id, {
          'mask.x': Math.min(1.5, Math.max(-0.5, m.x + dx)),
          'mask.y': Math.min(1.5, Math.max(-0.5, m.y + dy)),
        })
        return
      }
      if (current.kind === 'point') {
        // Точка своей формы: переводим все точки в доли картинки, двигаем
        // одну и заново находим прямоугольник вокруг них.
        const absolute = (m.points ?? []).map(
          ([u, v]) => [m.x - m.w / 2 + u * m.w, m.y - m.h / 2 + v * m.h] as [number, number],
        )
        absolute[current.index] = [atX, atY]
        const { box: frame, inside } = frameOf(absolute)
        // Точки — тоже показатель маски: у маски с ключами правка ляжет в
        // ключ под иглой, и форма будет меняться во времени.
        state.applyValues(clip.id, {
          'mask.x': frame.x,
          'mask.y': frame.y,
          'mask.w': frame.w,
          'mask.h': frame.h,
          [POINTS]: inside,
        })
        return
      }
      // Края маски в долях картинки; двигается та сторона, за которую взяли.
      let l = m.x - m.w / 2
      let r = m.x + m.w / 2
      let t = m.y - m.h / 2
      let b = m.y + m.h / 2
      for (const side of current.sides) {
        if (side === 'l') l = Math.min(r - MIN, atX)
        if (side === 'r') r = Math.max(l + MIN, atX)
        if (side === 't') t = Math.min(b - MIN, atY)
        if (side === 'b') b = Math.max(t + MIN, atY)
      }
      state.applyValues(clip.id, {
        'mask.x': (l + r) / 2,
        'mask.y': (t + b) / 2,
        'mask.w': r - l,
        'mask.h': b - t,
      })
    }
    const drop = () => {
      drag.current = null
    }
    const keys = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault()
        // Рисуют форму — Esc сначала отменяет недорисованное.
        if (event.key === 'Escape' && draft.length) {
          setDraft([])
          return
        }
        setMasking(null)
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
  }, [clip.id, setMasking, draft.length])

  if (!mask) return null

  const begin = (event: React.MouseEvent) => {
    if (event.button !== 0) return false
    event.preventDefault()
    event.stopPropagation()
    useCompose.getState().mark()
    return true
  }

  const place = {
    left: `${(clip.x - wide / 2) * 100}%`,
    top: `${(clip.y - tall / 2) * 100}%`,
    width: `${wide * 100}%`,
    height: `${tall * 100}%`,
  }

  if (drawing) {
    // Рисуем свою форму: нажатие — точка, нажатие по первой — готово.
    const addPoint = (event: React.MouseEvent) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const area = box.current?.getBoundingClientRect()
      if (!area) return
      const point: [number, number] = [
        (event.clientX - area.left) / area.width,
        (event.clientY - area.top) / area.height,
      ]
      if (draft.length >= 3) {
        const first = draft[0]
        const gap = Math.hypot((point[0] - first[0]) * area.width, (point[1] - first[1]) * area.height)
        if (gap <= CLOSE_PIXELS) {
          const state = useCompose.getState()
          state.mark()
          const { box: frame, inside } = frameOf(draft)
          // Нарисованная форма — во всех ключах маски: иначе до первого
          // ключа или после последнего осталась бы прежняя.
          const found = state.findClip(clip.id)?.clip
          if (found?.anim?.[POINTS]?.length) {
            state.updateClip(clip.id, { anim: { ...found.anim, [POINTS]: [] } })
          }
          state.applyValues(clip.id, {
            'mask.x': frame.x,
            'mask.y': frame.y,
            'mask.w': frame.w,
            'mask.h': frame.h,
            [POINTS]: inside,
          })
          setDraft([])
          return
        }
      }
      setDraft([...draft, point])
    }
    return (
      <div
        ref={box}
        className="absolute cursor-crosshair"
        style={place}
        onMouseDown={addPoint}
      >
        <div className="pointer-events-none absolute inset-0 border border-dashed border-white/30" />
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
          {draft.length > 1 && (
            <polyline
              points={draft.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')}
              fill="none"
              stroke="var(--color-warn)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {draft.map(([x, y], index) => (
          <div
            key={index}
            className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full ${
              index === 0 && draft.length >= 3 ? 'bg-white' : 'bg-warn'
            }`}
            style={{
              ...outer.ring,
              width: (index === 0 && draft.length >= 3 ? 14 : 10) * outer.unit,
              height: (index === 0 && draft.length >= 3 ? 14 : 10) * outer.unit,
              left: `${x * 100}%`,
              top: `${y * 100}%`,
            }}
          />
        ))}
        <span style={outer.label}
          className="pointer-events-none absolute left-0 whitespace-nowrap rounded bg-black/60 px-1.5 font-mono text-[9.5px] leading-[15px] text-white/85">
          {draft.length < 3 ? 'ставьте точки' : 'нажмите по первой точке, чтобы замкнуть'}
        </span>
      </div>
    )
  }

  const custom = mask.shape === 'custom' ? mask.points ?? [] : []

  return (
    <div ref={box} className="absolute" style={place}>
      {/* Граница картинки клипа — маска считается от неё. */}
      <div className="pointer-events-none absolute inset-0 border border-dashed border-white/30" />
      <div
        ref={maskArea}
        className="absolute cursor-move"
        style={{
          left: `${(mask.x - mask.w / 2) * 100}%`,
          top: `${(mask.y - mask.h / 2) * 100}%`,
          width: `${mask.w * 100}%`,
          height: `${mask.h * 100}%`,
        }}
        onMouseDown={(event) => {
          if (!begin(event)) return
          drag.current = { kind: 'move', fromX: event.clientX, fromY: event.clientY, start: mask }
        }}
      >
        {/* Контур формы: у овала — овал, у своей — многоугольник; рамка
            ручек — всегда прямоугольник. */}
        {mask.shape === 'custom' ? (
          <>
            <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polygon
                points={custom.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')}
                fill="none"
                stroke="var(--color-warn)"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <div className="pointer-events-none absolute inset-0 border border-dashed border-warn/50" />
            {custom.map(([x, y], index) => (
              <div
                key={index}
                // Над ручками рамки: крайние точки формы всегда лежат на её
                // краю, и иначе точку перехватывала ручка размера.
                className="absolute z-10 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full bg-white"
                style={{ ...fit.ring, width: 12 * fit.unit, height: 12 * fit.unit, left: `${x * 100}%`, top: `${y * 100}%` }}
                onMouseDown={(event) => {
                  if (!begin(event)) return
                  drag.current = { kind: 'point', index, start: mask }
                }}
              />
            ))}
          </>
        ) : (
          <>
            <BoxOutline color="var(--color-warn)" width={2} ellipse={mask.shape === 'ellipse'} unit={fit.unit} />
            {mask.shape === 'ellipse' && (
              <div className="pointer-events-none absolute inset-0 border border-dashed border-warn/50" />
            )}
          </>
        )}
        {HANDLES.filter((handle) => (handle.x === 0.5 ? fit.midX : handle.y === 0.5 ? fit.midY : true)).map((handle) => (
          <div
            key={handle.id}
            className="absolute bg-warn"
            style={{
              ...fit.size,
              left: fit.along(handle.x, true).pos,
              top: fit.along(handle.y, true).pos,
              transform: `translate(${fit.along(handle.x, true).shift}, ${fit.along(handle.y, true).shift})`,
              cursor: handle.cursor,
            }}
            onMouseDown={(event) => {
              if (!begin(event)) return
              drag.current = { kind: 'sides', sides: handle.sides, start: mask }
            }}
          />
        ))}
        <span style={fit.label}
          className="pointer-events-none absolute left-0 whitespace-nowrap rounded bg-black/60 px-1.5 font-mono text-[9.5px] leading-[15px] text-white/85">
          маска
        </span>
      </div>
    </div>
  )
}
