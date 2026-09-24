import { useEffect, useRef } from 'react'
import { clipRect, useCompose, type ClipMask, type ComposeClip } from '../composeStore'

/**
 * Маска клипа в окне просмотра: её двигают и растягивают прямо по кадру.
 *
 * Результат виден сразу — кадр собирается с маской, как и в готовом файле, —
 * а поверх лежит контур формы с ручками. Тянешь за середину — маска едет,
 * за край или уголок — меняется размер, противоположная сторона стоит на
 * месте. Маска может частично выходить за картинку: например, чтобы закрыть
 * угол.
 *
 * Выйти — Enter, Esc или кнопка «Готово» в колонке справа.
 */

type Side = 'l' | 't' | 'r' | 'b'

const MIN = 0.03

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

export function ComposeMaskBox({ clip }: { clip: ComposeClip }) {
  const frameW = useCompose((state) => state.width)
  const frameH = useCompose((state) => state.height)
  const setMasking = useCompose((state) => state.setMasking)
  const box = useRef<HTMLDivElement>(null)
  const { w: wide, h: tall } = clipRect(clip, frameW, frameH)
  const mask = clip.mask

  const drag = useRef<
    | { kind: 'sides'; sides: Side[]; start: ClipMask }
    | { kind: 'move'; fromX: number; fromY: number; start: ClipMask }
    | null
  >(null)

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const current = drag.current
      const area = box.current?.getBoundingClientRect()
      if (!current || !area || !area.width || !area.height) return
      const state = useCompose.getState()
      const m = current.start
      if (current.kind === 'move') {
        const dx = (event.clientX - current.fromX) / area.width
        const dy = (event.clientY - current.fromY) / area.height
        state.updateClip(clip.id, {
          mask: {
            ...m,
            x: Math.min(1.5, Math.max(-0.5, m.x + dx)),
            y: Math.min(1.5, Math.max(-0.5, m.y + dy)),
          },
        })
        return
      }
      // Края маски в долях картинки; двигается та сторона, за которую взяли.
      const atX = (event.clientX - area.left) / area.width
      const atY = (event.clientY - area.top) / area.height
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
      state.updateClip(clip.id, {
        mask: { ...m, x: (l + r) / 2, y: (t + b) / 2, w: r - l, h: b - t },
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
  }, [clip.id, setMasking])

  if (!mask) return null

  const begin = (event: React.MouseEvent) => {
    if (event.button !== 0) return false
    event.preventDefault()
    event.stopPropagation()
    useCompose.getState().mark()
    return true
  }

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
      {/* Граница картинки клипа — маска считается от неё. */}
      <div className="pointer-events-none absolute inset-0 border border-dashed border-white/30" />
      <div
        className="absolute cursor-move"
        style={{
          left: `${(mask.x - mask.w / 2) * 100}%`,
          top: `${(mask.y - mask.h / 2) * 100}%`,
          width: `${mask.w * 100}%`,
          height: `${mask.h * 100}%`,
        }}
        title="Маска: тяните за середину — сдвинуть, за края и уголки — изменить размер. Enter или Esc — готово"
        onMouseDown={(event) => {
          if (!begin(event)) return
          drag.current = { kind: 'move', fromX: event.clientX, fromY: event.clientY, start: mask }
        }}
      >
        {/* Контур формы: у овала — овал, чтобы было видно, что именно
            вырезается; рамка ручек — всегда прямоугольник. */}
        <div
          className={`pointer-events-none absolute inset-0 border-2 border-warn ${
            mask.shape === 'ellipse' ? 'rounded-[50%]' : ''
          }`}
        />
        {mask.shape === 'ellipse' && (
          <div className="pointer-events-none absolute inset-0 border border-dashed border-warn/50" />
        )}
        {HANDLES.map((handle) => (
          <div
            key={handle.id}
            className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 border border-base bg-warn"
            style={{ left: `${handle.x * 100}%`, top: `${handle.y * 100}%`, cursor: handle.cursor }}
            onMouseDown={(event) => {
              if (!begin(event)) return
              drag.current = { kind: 'sides', sides: handle.sides, start: mask }
            }}
          />
        ))}
        <span className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded bg-black/60 px-1.5 font-mono text-[9.5px] leading-[15px] text-white/85">
          маска
        </span>
      </div>
    </div>
  )
}
