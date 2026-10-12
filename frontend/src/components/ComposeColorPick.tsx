import { useEffect, useRef, useState } from 'react'
import { finishColorPick, snapshotColors, useColorPickOwner } from '../lib/colorPick'

/**
 * Слой пипетки поверх кадра: пока квадратик цвета ждёт цвет, нажатие по
 * кадру отдаёт ему цвет пикселя, а у курсора виден цвет, который возьмётся.
 * Esc или нажатие мимо кадра — отмена.
 */
export function ComposeColorPick({ source }: { source: () => HTMLImageElement | HTMLVideoElement | null }) {
  const owner = useColorPickOwner()
  const read = useRef<ReturnType<typeof snapshotColors>>(null)
  const [hover, setHover] = useState<{ x: number; y: number; hex: string; scale: number } | null>(null)

  useEffect(() => {
    if (!owner) {
      read.current = null
      setHover(null)
      return
    }
    read.current = snapshotColors(source())
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      finishColorPick(null)
    }
    // Нажатие мимо кадра (кроме самой кнопки пипетки) — отмена.
    const away = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('[data-color-pick]') && !target.closest('[data-color-pick-layer]')) finishColorPick(null)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', away, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', away, true)
    }
  }, [owner, source])

  if (!owner) return null
  return (
    <div
      data-color-pick-layer
      className="absolute inset-0 z-50 cursor-crosshair"
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.button !== 0) return
        const hex = read.current?.(event.clientX, event.clientY) ?? null
        finishColorPick(hex)
      }}
      onMouseMove={(event) => {
        const hex = read.current?.(event.clientX, event.clientY)
        const box = event.currentTarget.getBoundingClientRect()
        // Слой лежит внутри приближенного кадра — переводим в его точки.
        const scale = box.width / (event.currentTarget.offsetWidth || box.width)
        setHover(
          hex
            ? { x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale, hex, scale }
            : null,
        )
      }}
      onMouseLeave={() => setHover(null)}
    >
      {hover && (
        <span
          className="pointer-events-none absolute flex items-center gap-1.5 rounded-lg bg-black/75 px-1.5 py-1 font-mono text-[11px] uppercase text-white shadow-lg"
          style={{
            left: hover.x + 14 / hover.scale,
            top: hover.y + 14 / hover.scale,
            // Подпись — обычного размера, как бы ни был приближен кадр.
            transform: `scale(${1 / hover.scale})`,
            transformOrigin: 'top left',
          }}
        >
          <span className="h-4 w-4 rounded-[3px] ring-1 ring-white/60" style={{ background: hover.hex }} />
          {hover.hex}
        </span>
      )}
    </div>
  )
}
