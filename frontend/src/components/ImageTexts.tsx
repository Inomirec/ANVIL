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
}: {
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
}: {
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

  // Новая надпись сразу открывается для набора с выделенным текстом.
  useEffect(() => {
    if (fresh && field.current) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh])

  const [lift, setLift] = useState(0)
  useLayoutEffect(() => {
    if (!field.current) return
    const next = inkShift(field.current, mark.text)
    if (Math.abs(next - lift) > 0.05) setLift(next)
  })

  const begin = (event: React.MouseEvent) => {
    if (!interactive || event.button !== 0 || editing) return
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
      // Не сдвинули — это нажатие по уже выбранной надписи: открыть для набора.
      if (!moved && chosen) {
        setEditing(true)
        setTimeout(() => field.current?.focus(), 0)
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
  }

  return (
    <div
      className="absolute"
      style={{
        left: `${(mark.x / natural.width) * 100}%`,
        top: `${(mark.y / natural.height) * 100}%`,
        marginTop: lift,
        transform: 'translate(-50%, -50%)',
        pointerEvents: interactive ? 'auto' : 'none',
        // Рамка — контуром: он не занимает места и не сдвигает буквы.
        outline: chosen && interactive ? `${1 / zoom}px dashed var(--color-accent-soft)` : undefined,
        outlineOffset: 4 / zoom,
        cursor: interactive ? (editing ? 'text' : 'move') : undefined,
      }}
      onMouseDown={begin}
    >
      <div
        ref={field}
        contentEditable={editing ? 'plaintext-only' : false}
        suppressContentEditableWarning
        spellCheck={false}
        className="select-text whitespace-pre text-center outline-none"
        style={{
          fontFamily: face ? `"${face.family}"` : `"${mark.font}", Arial, sans-serif`,
          fontSize: mark.size * scale,
          lineHeight: face?.lineHeight ?? 1.2,
          color: mark.color,
        }}
        onFocus={onCommit}
        onBlur={() => setEditing(false)}
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
