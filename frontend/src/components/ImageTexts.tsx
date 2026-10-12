import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { inkShift, useFace } from './ComposeTextOverlay'

/** Надпись на картинке. Место — середина букв, всё в пикселях оригинала. */
export interface ImageTextMark {
  x: number
  y: number
  text: string
  font: string
  /** Высота букв (кегль) в пикселях оригинала. */
  size: number
  color: string
  /** Толщина обводки в пикселях оригинала; 0 или нет — без обводки. */
  stroke?: number
  strokeColor?: string
}

/** Обводка кольцом теней — скруглённая и снаружи букв, как у программы. */
function ring(width: number, colour: string): string {
  const shadows: string[] = []
  for (let step = 0; step < 24; step += 1) {
    const angle = (step / 24) * Math.PI * 2
    shadows.push(`${(Math.cos(angle) * width).toFixed(2)}px ${(Math.sin(angle) * width).toFixed(2)}px 0 ${colour}`)
  }
  return shadows.join(', ')
}

/** Насколько сдвинуть мышь, чтобы нажатие стало перетаскиванием. */
const DRAG_START = 3

/**
 * Надписи поверх картинки: ставят нажатием инструментом «Текст», печатают
 * прямо на месте и таскают мышью.
 *
 * Слой лежит внутри увеличенной картинки, поэтому и масштаб, и сдвиг у него
 * общие с ней. Размер букв задан в пикселях оригинала и пересчитывается в
 * точки окна (`scale`). В заданной точке — середина самих букв, как и у
 * программы при сохранении (`drawtext`), поэтому надпись в окне и в готовом
 * файле стоит одинаково.
 */
export function ImageTexts({
  texts,
  natural,
  scale,
  zoom,
  active,
  selected,
  fresh,
  onSelect,
  onChange,
  onCommit,
  onCreate,
  onRemove,
}: {
  /** Стёрли все буквы — надпись больше не нужна. */
  onRemove: (index: number) => void
  /** Номер только что поставленной надписи. */
  fresh: number | null
  texts: ImageTextMark[]
  natural: { width: number; height: number }
  /** Точек окна на пиксель оригинала — без приближения. */
  scale: number
  /** Приближение картинки: мышь двигается по увеличенной. */
  zoom: number
  /** Включён инструмент «Текст»: нажатие по пустому месту ставит надпись. */
  active: boolean
  selected: number | null
  onSelect: (index: number | null) => void
  onChange: (index: number, patch: Partial<ImageTextMark>) => void
  /** Запомнить состояние до правки — для Ctrl+Z. */
  onCommit: () => void
  onCreate: (x: number, y: number) => void
}) {
  const layer = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={layer}
      className="absolute inset-0"
      // Слой ловит нажатия только с инструментом «Текст»; иначе под ним
      // работают закраска, кисть и обрезка.
      style={{ pointerEvents: active ? 'auto' : 'none', cursor: active ? 'text' : undefined }}
      onMouseDown={(event) => {
        if (!active || event.button !== 0 || event.target !== layer.current) return
        event.preventDefault()
        const box = layer.current!.getBoundingClientRect()
        onCreate(
          ((event.clientX - box.left) / box.width) * natural.width,
          ((event.clientY - box.top) / box.height) * natural.height,
        )
      }}
    >
      {texts.map((mark, index) => (
        <TextItem
          key={index}
          mark={mark}
          natural={natural}
          scale={scale}
          zoom={zoom}
          interactive={active}
          chosen={selected === index}
          fresh={fresh === index}
          onSelect={() => onSelect(index)}
          onChange={(patch) => onChange(index, patch)}
          onCommit={onCommit}
          onRemove={() => onRemove(index)}
        />
      ))}
    </div>
  )
}

function TextItem({
  mark,
  natural,
  scale,
  zoom,
  interactive,
  chosen,
  fresh,
  onSelect,
  onChange,
  onCommit,
  onRemove,
}: {
  onRemove: () => void
  /** Только что поставленная: сразу открыть для набора. */
  fresh: boolean
  mark: ImageTextMark
  natural: { width: number; height: number }
  scale: number
  zoom: number
  interactive: boolean
  chosen: boolean
  onSelect: () => void
  onChange: (patch: Partial<ImageTextMark>) => void
  onCommit: () => void
}) {
  const field = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const face = useFace(mark.font, false, false)

  // Текст в поле ставим сами и только когда он пришёл снаружи (отмена,
  // новая надпись): иначе каждый перерисованный кадр сбивал бы курсор.
  useEffect(() => {
    const element = field.current
    if (element && document.activeElement !== element && element.innerText !== mark.text) {
      element.innerText = mark.text
    }
  }, [mark.text])

  /** Открыть надпись для набора, выделив её текст целиком. */
  const startEditing = () => {
    setEditing(true)
    setTimeout(() => {
      const element = field.current
      if (!element) return
      element.focus()
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }, 0)
  }

  // Новая надпись сразу открывается для набора.
  useEffect(() => {
    if (fresh && field.current) startEditing()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh])
  // Сняли выбор — набор закончился.
  useEffect(() => {
    if (!chosen && editing) {
      // Поле могло уже потерять фокус — тогда «ушли из поля» не придёт, и
      // надпись так и осталась бы в наборе, не давая себя таскать.
      setEditing(false)
      field.current?.blur()
      if (!mark.text.trim()) onRemove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen])

  const [lift, setLift] = useState(0)
  useLayoutEffect(() => {
    if (!field.current) return
    const next = inkShift(field.current, mark.text)
    if (Math.abs(next - lift) > 0.05) setLift(next)
  })

  // Одно нажатие — выбрать и таскать, двойное — печатать. Пока печатают,
  // таскают за поле вокруг букв: внутри букв нажатие ставит курсор.
  const frame = useRef<HTMLDivElement>(null)
  const begin = (event: React.MouseEvent) => {
    if (!interactive || event.button !== 0) return
    if (editing && event.target !== frame.current) return
    event.preventDefault()
    event.stopPropagation()
    onSelect()
    const from = { x: event.clientX, y: event.clientY, mx: mark.x, my: mark.y }
    let moved = false
    const move = (moving: MouseEvent) => {
      const dx = moving.clientX - from.x
      const dy = moving.clientY - from.y
      if (!moved) {
        if (Math.abs(dx) + Math.abs(dy) < DRAG_START) return
        moved = true
        onCommit()
      }
      const unit = scale * zoom || 1
      onChange({
        x: Math.round(Math.min(natural.width, Math.max(0, from.mx + dx / unit))),
        y: Math.round(Math.min(natural.height, Math.max(0, from.my + dy / unit))),
      })
    }
    const drop = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', drop)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
  }

  return (
    <div
      ref={frame}
      className="absolute"
      style={{
        // Поле вокруг букв — за него таскают и во время набора.
        padding: 6 / zoom,
        left: `${(mark.x / natural.width) * 100}%`,
        top: `${(mark.y / natural.height) * 100}%`,
        marginTop: lift,
        transform: 'translate(-50%, -50%)',
        pointerEvents: interactive ? 'auto' : 'none',
        // Рамка — контуром: он не занимает места и не сдвигает буквы.
        outline: chosen && interactive ? `${1 / zoom}px dashed var(--color-accent-soft)` : undefined,
        outlineOffset: -1 / zoom,
        cursor: interactive ? 'move' : undefined,
      }}
      onMouseDown={begin}
      onDoubleClick={(event) => {
        if (!interactive || editing) return
        event.stopPropagation()
        startEditing()
      }}
    >
      <div
        ref={field}
        contentEditable={editing ? 'plaintext-only' : false}
        suppressContentEditableWarning
        spellCheck={false}
        className="select-text whitespace-pre text-center outline-none"
        style={{
          cursor: editing ? 'text' : undefined,
          textShadow: mark.stroke ? ring(mark.stroke * scale, mark.strokeColor ?? '#000000') : undefined,
          fontFamily: face ? `"${face.family}"` : `"${mark.font}", Arial, sans-serif`,
          fontSize: mark.size * scale,
          lineHeight: face?.lineHeight ?? 1.2,
          color: mark.color,
        }}
        onFocus={onCommit}
        onBlur={(event) => {
          setEditing(false)
          if (!event.currentTarget.innerText.trim()) onRemove()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') (event.target as HTMLElement).blur()
          // Клавиши редактора (Delete, Ctrl+Z) — тексту, а не картинке.
          event.stopPropagation()
        }}
        onInput={(event) => onChange({ text: (event.currentTarget as HTMLDivElement).innerText })}
      />
    </div>
  )
}
