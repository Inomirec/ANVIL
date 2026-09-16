import { useEffect, useRef } from 'react'
import { clampPlace, useCompose, type ComposeClip } from '../composeStore'

/**
 * Рамка клипа поверх окна просмотра.
 *
 * Чтобы поставить картинку в нужное место кадра, её надо взять и перетащить,
 * а не выбирать из готовых положений: девяти кнопок хватало только на углы и
 * середины, а между ними ничего поставить было нельзя.
 *
 * Рамка показывает, какую часть кадра занимает клип: её тянут за середину —
 * клип едет, за уголок — меняется размер. Размер меняется от середины, чтобы
 * клип не убегал из-под курсора. Двойное нажатие возвращает клип в кадр
 * целиком.
 *
 * Рамка рисуется по размеру и месту, а не по настоящей картинке: если форма
 * кадра у клипа другая, внутри рамки он ляжет с полями. Зато понятно, что
 * именно двигаешь.
 */
const HANDLES = [
  { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
  { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
  { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
] as const

export function ComposeFrameBox({ clip }: { clip: ComposeClip }) {
  const box = useRef<HTMLDivElement>(null)
  /** Что тянем: всю рамку или уголок. От чего считаем — в `from`. */
  const drag = useRef<
    | { kind: 'move'; frameW: number; frameH: number; fromX: number; fromY: number; x: number; y: number }
    | { kind: 'size'; frameW: number; frameH: number; size: number; grab: number }
    | null
  >(null)

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const current = drag.current
      if (!current) return
      const state = useCompose.getState()
      if (current.kind === 'move') {
        state.updateClip(
          clip.id,
          clampPlace({
            x: current.x + (event.clientX - current.fromX) / current.frameW,
            y: current.y + (event.clientY - current.fromY) / current.frameH,
          }),
        )
      } else {
        // Размер считаем по тому, насколько уголок отъехал от середины:
        // расстояние до середины и есть половина стороны рамки.
        const area = box.current?.parentElement?.getBoundingClientRect()
        if (!area) return
        const middleX = area.left + (clip.x * current.frameW)
        const middleY = area.top + (clip.y * current.frameH)
        const away = Math.max(
          Math.abs(event.clientX - middleX) / current.frameW,
          Math.abs(event.clientY - middleY) / current.frameH,
        )
        state.updateClip(clip.id, clampPlace({ size: away * 2 }))
      }
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
  }, [clip.id, clip.x, clip.y])

  const frame = () => {
    const area = box.current?.parentElement?.getBoundingClientRect()
    return { frameW: area?.width ?? 1, frameH: area?.height ?? 1 }
  }

  const reset = () =>
    useCompose.getState().updateClip(clip.id, { size: 1, x: 0.5, y: 0.5 })

  return (
    <div
      ref={box}
      className="absolute cursor-move rounded-[3px] border border-dashed border-accent-soft/90 bg-accent/5"
      style={{
        left: `${(clip.x - clip.size / 2) * 100}%`,
        top: `${(clip.y - clip.size / 2) * 100}%`,
        width: `${clip.size * 100}%`,
        height: `${clip.size * 100}%`,
      }}
      title={`${clip.name}: тяните за середину, уголки меняют размер.
Двойное нажатие вернёт клип в кадр целиком`}
      onDoubleClick={reset}
      onMouseDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        const { frameW, frameH } = frame()
        drag.current = {
          kind: 'move',
          frameW,
          frameH,
          fromX: event.clientX,
          fromY: event.clientY,
          x: clip.x,
          y: clip.y,
        }
      }}
    >
      {HANDLES.map((handle) => (
        <div
          key={handle.id}
          className="absolute h-3 w-3 rounded-[2px] border border-base bg-accent-soft"
          style={{
            left: `${handle.x * 100}%`,
            top: `${handle.y * 100}%`,
            transform: 'translate(-50%, -50%)',
            cursor: handle.cursor,
          }}
          onDoubleClick={(event) => {
            event.stopPropagation()
            reset()
          }}
          onMouseDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            const { frameW, frameH } = frame()
            drag.current = { kind: 'size', frameW, frameH, size: clip.size, grab: 0 }
          }}
        />
      ))}

      <span className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded bg-black/60 px-1.5 font-mono text-[9.5px] leading-[15px] tabular-nums text-white/85">
        {Math.round(clip.size * 100)}%
      </span>
    </div>
  )
}
