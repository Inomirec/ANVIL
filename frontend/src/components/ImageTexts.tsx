import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { inkBounds, useFace } from './ComposeTextOverlay'

/**
 * Надпись на картинке. Место — середина букв по высоте и точка выравнивания
 * по ширине (середина, левый или правый край), всё в пикселях оригинала.
 * Настройки те же, что у надписи в монтаже: сервер рисует её тем же кодом.
 */
export interface ImageTextMark {
  x: number
  y: number
  text: string
  font: string
  bold?: boolean
  italic?: boolean
  /** Высота букв (кегль) в пикселях оригинала. */
  size: number
  color: string
  align?: 'left' | 'center' | 'right'
  /** Обводка: включатель отдельно от толщины, как в монтаже. */
  strokeOn?: boolean
  /** Толщина обводки в пикселях оригинала. */
  stroke?: number
  strokeColor?: string
  shadowOn?: boolean
  shadowX?: number
  shadowY?: number
  shadowAlpha?: number
  shadowBlur?: number
  shadowColor?: string
  /** Подложка под буквами. */
  box?: boolean
  boxColor?: string
  boxAlpha?: number
  boxPad?: number
  boxRadius?: number
}

/** Всё, кроме места и текста, — то, что запоминается для следующей надписи. */
export type TextStyle = Omit<ImageTextMark, 'x' | 'y' | 'text'>

export const TEXT_STYLE_DEFAULTS: Required<TextStyle> = {
  font: 'Arial',
  bold: false,
  italic: false,
  size: 64,
  color: '#ffffff',
  align: 'center',
  strokeOn: false,
  stroke: 4,
  strokeColor: '#000000',
  shadowOn: false,
  shadowX: 4,
  shadowY: 4,
  shadowAlpha: 0.75,
  shadowBlur: 0,
  shadowColor: '#000000',
  box: false,
  boxColor: '#000000',
  boxAlpha: 0.5,
  boxPad: 10,
  boxRadius: 0,
}

/** Как выглядит следующая надпись — запоминается между картинками. */
const TEXT_STYLE_KEY = 'sgh.imageText'

export function readTextStyle(): Required<TextStyle> {
  try {
    const saved = JSON.parse(localStorage.getItem(TEXT_STYLE_KEY) ?? 'null')
    if (saved && typeof saved.font === 'string') {
      // Прежние записи знали только толщину обводки: больше нуля — включена.
      const strokeOn = saved.strokeOn ?? (saved.stroke ?? 0) > 0
      return { ...TEXT_STYLE_DEFAULTS, ...saved, strokeOn, stroke: saved.stroke || TEXT_STYLE_DEFAULTS.stroke }
    }
  } catch {
    // Испорченная запись — берём обычные.
  }
  return TEXT_STYLE_DEFAULTS
}

export function saveTextStyle(mark: ImageTextMark): void {
  const { x: _x, y: _y, text: _text, ...style } = mark
  try {
    localStorage.setItem(TEXT_STYLE_KEY, JSON.stringify(style))
  } catch {
    // Без памяти просто не запомним.
  }
}

/** Надпись со всеми настройками: у прежних части полей нет. */
export function fullMark(mark: ImageTextMark): ImageTextMark & Required<TextStyle> {
  // Прежние надписи: обводка была, если толщина больше нуля.
  const strokeOn = mark.strokeOn ?? (mark.stroke ?? 0) > 0
  return { ...TEXT_STYLE_DEFAULTS, ...mark, strokeOn, stroke: mark.stroke || TEXT_STYLE_DEFAULTS.stroke }
}

/** Цвет #rrggbb с прозрачностью — для тени и подложки. */
function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Обводка кольцом теней — скруглённая и снаружи букв, как у программы. */
function ring(width: number, colour: string): string[] {
  const shadows: string[] = []
  for (let step = 0; step < 24; step += 1) {
    const angle = (step / 24) * Math.PI * 2
    shadows.push(`${(Math.cos(angle) * width).toFixed(2)}px ${(Math.sin(angle) * width).toFixed(2)}px 0 ${colour}`)
  }
  return shadows
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
  toImage,
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
  /** Точка окна → пиксели оригинала, с учётом поворота и отражения. */
  toImage: (clientX: number, clientY: number) => { x: number; y: number } | null
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
        const point = toImage(event.clientX, event.clientY)
        if (point) onCreate(point.x, point.y)
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
          toImage={toImage}
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
  toImage,
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
  toImage: (clientX: number, clientY: number) => { x: number; y: number } | null
  onSelect: () => void
  onChange: (patch: Partial<ImageTextMark>) => void
  onCommit: () => void
}) {
  const field = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const v = fullMark(mark)
  const face = useFace(v.font, v.bold, v.italic)

  // Текст в поле ставим сами и только когда он пришёл снаружи (отмена,
  // новая надпись, поле в колонке справа): иначе каждый перерисованный кадр
  // сбивал бы курсор.
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
      // Выделенный при наборе текст иначе так и висел синей плашкой поверх
      // надписи, которую больше не правят.
      const selection = window.getSelection()
      if (selection?.anchorNode && field.current?.contains(selection.anchorNode)) selection.removeAllRanges()
      if (!mark.text.trim()) onRemove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen])

  // Где сами буквы: по ним ставится середина и рисуется подложка.
  const [ink, setInk] = useState({ shift: 0, top: 0, bottom: 0 })
  useLayoutEffect(() => {
    if (!field.current) return
    const next = inkBounds(field.current, mark.text)
    if (
      Math.abs(next.shift - ink.shift) > 0.05 ||
      Math.abs(next.top - ink.top) > 0.05 ||
      Math.abs(next.bottom - ink.bottom) > 0.05
    ) {
      setInk(next)
    }
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
    const start = toImage(event.clientX, event.clientY)
    if (!start) return
    const from = { cx: event.clientX, cy: event.clientY, x: start.x, y: start.y, mx: mark.x, my: mark.y }
    let moved = false
    const move = (moving: MouseEvent) => {
      if (!moved) {
        if (Math.abs(moving.clientX - from.cx) + Math.abs(moving.clientY - from.cy) < DRAG_START) return
        moved = true
        onCommit()
      }
      // Сдвиг считаем в пикселях оригинала: картинка может быть повёрнута
      // и отражена, и сдвиг мыши по экрану — не сдвиг по картинке.
      const point = toImage(moving.clientX, moving.clientY)
      if (!point) return
      onChange({
        x: Math.round(Math.min(natural.width, Math.max(0, from.mx + point.x - from.x))),
        y: Math.round(Math.min(natural.height, Math.max(0, from.my + point.y - from.y))),
      })
    }
    const drop = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', drop)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
  }

  const px = (value: number) => value * scale
  const stroke = v.strokeOn && v.stroke > 0
  const shadow = v.shadowOn && v.shadowAlpha > 0
  const pad = 6 / zoom
  // Выравнивание задаёт, какая точка надписи стоит в x: левый край,
  // середина или правый. У программы в x — край самих букв, а не поля
  // вокруг них и не подложки: выносим рамку за x на этот отступ.
  const edge = pad + (v.box ? px(v.boxPad) : 0)
  const shiftX = v.align === 'left' ? '0%' : v.align === 'right' ? '-100%' : '-50%'
  const nudge = v.align === 'left' ? -edge : v.align === 'right' ? edge : 0

  return (
    <div
      ref={frame}
      className="absolute"
      style={{
        // Поле вокруг букв — за него таскают и во время набора.
        padding: pad,
        left: `calc(${(mark.x / natural.width) * 100}% + ${nudge}px)`,
        top: `${(mark.y / natural.height) * 100}%`,
        marginTop: ink.shift,
        transform: `translate(${shiftX}, -50%)`,
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
      {/* Подложка — вокруг самих букв, как у программы, а не вокруг строк
          шрифта; по бокам — по ширине строки. */}
      {v.box && (
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            left: pad,
            right: pad,
            top: pad + ink.top,
            height: Math.max(0, ink.bottom - ink.top) + 2 * px(v.boxPad),
            background: withAlpha(v.boxColor, v.boxAlpha),
            borderRadius: v.boxRadius ? px(v.boxRadius) : undefined,
          }}
        />
      )}
      <div
        ref={field}
        contentEditable={editing ? 'plaintext-only' : false}
        suppressContentEditableWarning
        spellCheck={false}
        className="relative select-text whitespace-pre outline-none"
        style={{
          cursor: editing ? 'text' : undefined,
          // Сначала кольцо обводки, под ним тень: первая в списке лежит сверху.
          // Размытие в CSS задаётся радиусом — это примерно две сигмы.
          textShadow:
            [
              ...(stroke ? ring(px(v.stroke), v.strokeColor) : []),
              ...(shadow
                ? [`${px(v.shadowX)}px ${px(v.shadowY)}px ${px(2 * v.shadowBlur)}px ${withAlpha(v.shadowColor, v.shadowAlpha)}`]
                : []),
            ].join(', ') || undefined,
          // Пока файл шрифта не пришёл — по имени. Пришёл — ровно им: жирность
          // и наклон тогда уже в самом файле.
          fontFamily: face ? `"${face.family}"` : `"${v.font}", Arial, sans-serif`,
          fontWeight: face ? 400 : v.bold ? 700 : 400,
          fontStyle: face ? 'normal' : v.italic ? 'italic' : 'normal',
          fontSize: px(v.size),
          lineHeight: face?.lineHeight ?? 1.2,
          color: v.color,
          textAlign: v.align,
          padding: v.box ? px(v.boxPad) : undefined,
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
