import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Pipette } from 'lucide-react'

/**
 * Своё окошко выбора цвета вместо окна браузера.
 *
 * У окна браузера своя пипетка, и во встроенном в программу браузере она не
 * работает — нажатие ничего не делает, а спрятать её нельзя: окно рисует
 * браузер, не программа. Здесь пипетка рабочая: берёт цвет из любой
 * картинки или видео на экране — кадра монтажа, картинки в медиатеке.
 *
 * Окошко и слой пипетки помечены ``data-color-popover``: меню и всплывашки,
 * которые закрываются по нажатию мимо себя, должны их пропускать — окошко
 * живёт в отдельном слое страницы, а не внутри них.
 */

type Hsv = { h: number; s: number; v: number }

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0')
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16) || 0) as [number, number, number]
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((part) => Math.round(Math.min(255, Math.max(0, part))).toString(16).padStart(2, '0')).join('')}`
}

function rgbToHsv(r: number, g: number, b: number): Hsv {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255]
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const d = max - min
  let h = 0
  if (d) {
    if (max === rr) h = ((gg - bb) / d) % 6
    else if (max === gg) h = (bb - rr) / d + 2
    else h = (rr - gg) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max ? d / max : 0, v: max }
}

function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

/**
 * Кнопка с квадратиком цвета; нажатие открывает окошко выбора.
 * ``onOpen`` — окошко открылось: правки цвета дальше идут одной серией.
 */
export function ColorButton({
  value,
  onChange,
  title,
  onOpen,
  className = 'flex items-center rounded-lg p-1.5 transition-colors hover:bg-surface-3',
  children,
}: {
  value: string
  onChange: (hex: string) => void
  title?: string
  onOpen?: () => void
  className?: string
  /** Что нарисовать на кнопке вместо обычного квадратика. */
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={button}
        type="button"
        title={title}
        onClick={() => {
          if (!open) onOpen?.()
          setOpen((was) => !was)
        }}
        className={className}
      >
        {children ?? <span className="h-4 w-4 rounded-[3px] ring-1 ring-line" style={{ background: value }} />}
      </button>
      {open && (
        <ColorPopover anchor={button.current} value={value} onChange={onChange} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

function ColorPopover({
  anchor,
  value,
  onChange,
  onClose,
}: {
  anchor: HTMLElement | null
  value: string
  onChange: (hex: string) => void
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: -9999, top: -9999 })
  // Оттенок держим сами: у серого и чёрного он из цвета не вычисляется, и
  // без этого полоса оттенков прыгала бы в красный, стоило увести цвет в серый.
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(...hexToRgb(value)))
  const [picking, setPicking] = useState(false)
  const last = useRef(value)

  // Цвет поменяли снаружи (пипеткой, полем кода) — подтягиваем.
  useEffect(() => {
    if (value.toLowerCase() === last.current.toLowerCase()) return
    last.current = value
    const next = rgbToHsv(...hexToRgb(value))
    setHsv((was) => ({ ...next, h: next.s === 0 || next.v === 0 ? was.h : next.h }))
  }, [value])

  const emit = (next: Hsv) => {
    setHsv(next)
    const hex = rgbToHex(...hsvToRgb(next))
    last.current = hex
    onChange(hex)
  }
  const emitHex = (hex: string) => {
    last.current = hex
    const next = rgbToHsv(...hexToRgb(hex))
    setHsv((was) => ({ ...next, h: next.s === 0 || next.v === 0 ? was.h : next.h }))
    onChange(hex)
  }

  // Место — под кнопкой, а если внизу тесно — над ней; в пределах окна.
  useLayoutEffect(() => {
    const own = box.current
    if (!anchor || !own) return
    const at = anchor.getBoundingClientRect()
    const width = own.offsetWidth
    const height = own.offsetHeight
    let top = at.bottom + 6
    if (top + height > window.innerHeight - 8) top = Math.max(8, at.top - height - 6)
    const left = Math.min(Math.max(8, at.left + at.width / 2 - width / 2), window.innerWidth - width - 8)
    setPlace({ left, top })
  }, [anchor])

  useEffect(() => {
    if (picking) return
    const away = (event: MouseEvent) => {
      const target = event.target as Node
      if (box.current?.contains(target) || anchor?.contains(target)) return
      onClose()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', away, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('mousedown', away, true)
      window.removeEventListener('keydown', escape, true)
    }
  }, [anchor, onClose, picking])

  const hex = rgbToHex(...hsvToRgb(hsv))
  const [r, g, b] = hexToRgb(hex)

  const dragOn = (element: HTMLElement, move: (x: number, y: number) => void) => (event: React.PointerEvent) => {
    event.preventDefault()
    element.setPointerCapture(event.pointerId)
    const rect = element.getBoundingClientRect()
    const at = (clientX: number, clientY: number) =>
      move(
        Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
        Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
      )
    at(event.clientX, event.clientY)
    const onMove = (moved: PointerEvent) => at(moved.clientX, moved.clientY)
    const onUp = () => {
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerup', onUp)
    }
    element.addEventListener('pointermove', onMove)
    element.addEventListener('pointerup', onUp)
  }

  return createPortal(
    <>
      <div
        ref={box}
        data-color-popover
        className="fixed z-[90] w-[220px] space-y-2 border border-line bg-surface-2 p-2.5 text-[11px] text-ink-dim shadow-2xl"
        style={{ left: place.left, top: place.top, visibility: picking ? 'hidden' : undefined }}
      >
        {/* Насыщенность вправо, яркость вверх. */}
        <div
          className="relative h-[130px] cursor-crosshair"
          style={{ background: `hsl(${hsv.h} 100% 50%)` }}
          onPointerDown={(event) => dragOn(event.currentTarget, (x, y) => emit({ ...hsv, s: x, v: 1 - y }))(event)}
        >
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, #fff, rgba(255,255,255,0))' }} />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, #000, rgba(0,0,0,0))' }} />
          <span
            className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPicking(true)}
            title="Взять цвет с экрана — из кадра, картинки или видео. Esc — отмена"
            className="flex h-7 w-7 shrink-0 items-center justify-center text-ink-dim transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <Pipette size={14} />
          </button>
          <span className="h-7 w-7 shrink-0 ring-1 ring-line" style={{ background: hex }} />
          {/* Оттенок. */}
          <div
            className="relative h-3 flex-1 cursor-pointer"
            style={{ background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
            onPointerDown={(event) => dragOn(event.currentTarget, (x) => emit({ ...hsv, h: Math.min(359.9, x * 360) }))(event)}
          >
            <span
              className="pointer-events-none absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
              style={{ left: `${(hsv.h / 360) * 100}%` }}
            />
          </div>
        </div>

        <div className="flex gap-1.5">
          <HexInput value={hex} onChange={emitHex} />
          {(['R', 'G', 'B'] as const).map((name, index) => (
            <NumberInput
              key={name}
              label={name}
              value={[r, g, b][index]}
              onChange={(part) => {
                const next: [number, number, number] = [r, g, b]
                next[index] = part
                emitHex(rgbToHex(...next))
              }}
            />
          ))}
        </div>
      </div>
      {picking && (
        <ScreenPick
          onPick={(picked) => {
            setPicking(false)
            if (picked) emitHex(picked)
          }}
        />
      )}
    </>,
    document.body,
  )
}

function HexInput({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const apply = () => {
    if (draft === null) return
    const clean = draft.trim().replace(/^#/, '')
    if (/^[0-9a-fA-F]{6}$/.test(clean)) onChange(`#${clean.toLowerCase()}`)
    else if (/^[0-9a-fA-F]{3}$/.test(clean)) onChange(`#${clean.split('').map((c) => c + c).join('').toLowerCase()}`)
    setDraft(null)
  }
  return (
    <label className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
      <input
        value={draft ?? value.toUpperCase()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === 'Enter') apply()
        }}
        className="w-full border border-line-soft bg-surface px-1 py-1 text-center font-mono text-[11px] text-ink outline-none focus:border-accent"
      />
      <span className="text-[9.5px] text-ink-faint">Код</span>
    </label>
  )
}

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const apply = () => {
    if (draft === null) return
    const number = Number(draft)
    if (Number.isFinite(number)) onChange(Math.round(Math.min(255, Math.max(0, number))))
    setDraft(null)
  }
  return (
    <label className="flex w-9 shrink-0 flex-col items-center gap-0.5">
      <input
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === 'Enter') apply()
        }}
        className="w-full border border-line-soft bg-surface px-0.5 py-1 text-center font-mono text-[11px] tabular-nums text-ink outline-none focus:border-accent"
      />
      <span className="text-[9.5px] text-ink-faint">{label}</span>
    </label>
  )
}

/**
 * Пипетка: слой поверх всего окна. Под курсором ищется картинка или видео,
 * цвет читается из того, что они показывают сейчас. У курсора — образец.
 */
function ScreenPick({ onPick }: { onPick: (hex: string | null) => void }) {
  const layer = useRef<HTMLDivElement>(null)
  const cache = useRef(new Map<Element, ((x: number, y: number) => string | null) | null>())
  const [hover, setHover] = useState<{ x: number; y: number; hex: string | null } | null>(null)

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onPick(null)
      }
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [onPick])

  const colorAt = (clientX: number, clientY: number): string | null => {
    const own = layer.current
    if (own) own.style.pointerEvents = 'none'
    const stack = document.elementsFromPoint(clientX, clientY)
    if (own) own.style.pointerEvents = ''
    const media = stack.find(
      (element) => element instanceof HTMLImageElement || element instanceof HTMLVideoElement,
    ) as HTMLImageElement | HTMLVideoElement | undefined
    if (!media) return null
    // Снимок берём один раз на элемент: видео при этом стоит на месте —
    // цвет берут с того кадра, что сейчас на экране.
    if (!cache.current.has(media)) cache.current.set(media, readerFor(media))
    return cache.current.get(media)?.(clientX, clientY) ?? null
  }

  return (
    <div
      ref={layer}
      data-color-popover
      className="fixed inset-0 z-[95] cursor-crosshair"
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.button !== 0) return onPick(null)
        onPick(colorAt(event.clientX, event.clientY))
      }}
      onMouseMove={(event) => setHover({ x: event.clientX, y: event.clientY, hex: colorAt(event.clientX, event.clientY) })}
      onContextMenu={(event) => event.preventDefault()}
    >
      {hover && (
        <span
          className="pointer-events-none fixed flex items-center gap-1.5 bg-black/80 px-1.5 py-1 font-mono text-[11px] uppercase text-white shadow-lg"
          style={{
            left: Math.min(hover.x + 16, window.innerWidth - 110),
            top: Math.min(hover.y + 16, window.innerHeight - 30),
          }}
        >
          {hover.hex ? (
            <>
              <span className="h-4 w-4 ring-1 ring-white/60" style={{ background: hover.hex }} />
              {hover.hex}
            </>
          ) : (
            <span className="normal-case">Наведите на картинку или кадр</span>
          )}
        </span>
      )}
      <span className="pointer-events-none fixed left-1/2 top-3 -translate-x-1/2 bg-black/80 px-3 py-1.5 text-[12px] text-white shadow-lg">
        Нажмите на картинку или кадр, чтобы взять цвет. Esc — отмена
      </span>
    </div>
  )
}

/** Чтение цвета из картинки или видео — с поправкой на вписывание (object-fit). */
function readerFor(source: HTMLImageElement | HTMLVideoElement) {
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight
  if (!width || !height) return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  let pixels: Uint8ClampedArray
  try {
    context.drawImage(source, 0, 0, width, height)
    pixels = context.getImageData(0, 0, width, height).data
  } catch {
    return null
  }
  const fit = getComputedStyle(source).objectFit
  return (clientX: number, clientY: number): string | null => {
    // Прямоугольник уже с приближением — переводить ничего не нужно.
    const box = source.getBoundingClientRect()
    let left = box.left
    let top = box.top
    let shownW = box.width
    let shownH = box.height
    if (fit === 'contain' || fit === 'scale-down') {
      const scale = Math.min(box.width / width, box.height / height)
      shownW = width * scale
      shownH = height * scale
      left += (box.width - shownW) / 2
      top += (box.height - shownH) / 2
    }
    const x = Math.floor(((clientX - left) / shownW) * width)
    const y = Math.floor(((clientY - top) / shownH) * height)
    if (x < 0 || y < 0 || x >= width || y >= height) return null
    const at = (y * width + x) * 4
    return rgbToHex(pixels[at], pixels[at + 1], pixels[at + 2])
  }
}
