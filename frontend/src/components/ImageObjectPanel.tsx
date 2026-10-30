import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic } from 'lucide-react'
import { api } from '../lib/api'
import { fitQuotes } from '../lib/quotes'
import { useFace } from './ComposeTextOverlay'
import type { Rect } from '../lib/types'
import {
  ColorSquare,
  EffectSection,
  FontPicker,
  IconToggle,
  SizeField,
  SliderNumber,
  type FontRow,
} from './ComposeTextPanel'
import { fullMark, saveTextStyle, type ImageTextMark } from './ImageTexts'

/**
 * Настройки выбранной надписи или заливки на картинке — в правой колонке,
 * как в монтаже: те же поля, те же эффекты за галочками. Ключей нет — у
 * картинки нет времени. Все размеры — в пикселях оригинала: они и уходят на
 * сервер.
 *
 * Правки этой колонки откатываются Ctrl+Z, как и правки на самой картинке:
 * серия правок подряд (ползунок, набор текста) — одно действие.
 */

/** Сколько ждать тишины, прежде чем следующая правка станет новым действием. */
const SESSION_MS = 700

function useUndoSession(commit: () => void) {
  const open = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  return () => {
    if (!open.current) {
      commit()
      open.current = true
    }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      open.current = false
    }, SESSION_MS)
  }
}

/** Число в поле: применяется по Enter или когда поле оставили. */
function NumberBox({
  value,
  unit,
  title,
  onDone,
}: {
  value: number
  unit: string
  title: string
  onDone: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const apply = () => {
    if (draft === null) return
    const number = Number(draft.replace(',', '.'))
    if (Number.isFinite(number)) onDone(number)
    setDraft(null)
  }
  return (
    <label
      title={title}
      className="flex min-w-0 flex-1 items-center rounded-md border border-line-soft bg-surface-2 px-1.5"
    >
      <input
        value={draft ?? String(Math.round(value))}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === 'Enter') apply()
          if (event.key === 'Escape') setDraft(null)
        }}
        className="w-full min-w-0 bg-transparent py-1 text-right font-mono text-[11.5px] tabular-nums outline-none"
      />
      <span className="ml-0.5 text-[10px] text-ink-faint">{unit}</span>
    </label>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 py-0.5">
      <span className="w-[70px] shrink-0 text-[11.5px] text-ink-dim">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  )
}

const Title = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{children}</h3>
)

/** Поле для текста: растёт вместе с текстом до предела, дальше — прокрутка. */
function TextBox({
  value,
  quotes,
  onChange,
}: {
  value: string
  quotes?: Record<string, string>
  onChange: (value: string) => void
}) {
  const area = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const node = area.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight + 2, 168)}px`
  }, [value])
  return (
    <textarea
      ref={area}
      rows={1}
      value={value}
      onChange={(event) => {
        // Кавычки, которых нет в шрифте, — парными (`fitQuotes`).
        const node = event.target
        const fitted = fitQuotes(node.value, quotes)
        if (fitted !== node.value) {
          const [start, end] = [node.selectionStart, node.selectionEnd]
          node.value = fitted
          node.setSelectionRange(start, end)
        }
        onChange(fitted)
      }}
      placeholder="Что написать"
      className="field block w-full resize-none overflow-y-auto leading-snug"
      style={{ maxHeight: 168 }}
    />
  )
}

export function ImageTextPanel({
  mark,
  natural,
  onChange,
  onCommit,
}: {
  mark: ImageTextMark
  natural: { width: number; height: number }
  onChange: (patch: Partial<ImageTextMark>) => void
  /** Запомнить состояние до правки — для Ctrl+Z. */
  onCommit: () => void
}) {
  const [fonts, setFonts] = useState<FontRow[] | null>(null)
  useEffect(() => {
    let alive = true
    api
      .fonts()
      .then((data) => alive && setFonts(data.fonts))
      // Без списка надпись всё равно нарисуется тем шрифтом, что найдётся.
      .catch(() => alive && setFonts([]))
    return () => {
      alive = false
    }
  }, [])

  const touch = useUndoSession(onCommit)
  const v = fullMark(mark)
  const put = (patch: Partial<ImageTextMark>) => {
    touch()
    // Обводка растёт и уменьшается вместе с буквами, как в монтаже.
    if (patch.size && patch.stroke === undefined && v.size > 0 && patch.size !== v.size) {
      patch = { ...patch, stroke: Math.round(v.stroke * (patch.size / v.size) * 10) / 10 }
    }
    onChange(patch)
    // Вид запоминается для следующей надписи — как раньше на панели.
    if (!('x' in patch) && !('y' in patch) && !('text' in patch)) saveTextStyle({ ...v, ...patch })
  }
  const family = fonts?.find((item) => item.name === v.font)
  const face = useFace(v.font, v.bold, v.italic)
  // Обычные толщина и сдвиги — от кегля, как в монтаже от высоты кадра.
  const stock = Math.max(1, Math.round(v.size / 16))

  return (
    <div className="space-y-3.5">
      <Title>Надпись</Title>

      <Row label="Положение">
        <NumberBox
          value={v.x}
          unit="x"
          title="Где стоит надпись по горизонтали, в пикселях картинки"
          onDone={(value) => put({ x: Math.min(natural.width, Math.max(0, value)) })}
        />
        <NumberBox
          value={v.y}
          unit="y"
          title="Середина букв по вертикали, в пикселях картинки"
          onDone={(value) => put({ y: Math.min(natural.height, Math.max(0, value)) })}
        />
      </Row>

      <TextBox value={v.text} quotes={face?.quotes} onChange={(text) => put({ text })} />

      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <FontPicker value={v.font} fonts={fonts} onChange={(font) => put({ font })} />
        </div>
        <SizeField
          pixels={Math.round(v.size)}
          max={2000}
          unitTitle="в пикселях картинки"
          onChange={(size) => put({ size })}
        />
      </div>

      {/* Цвет, начертание и выравнивание — тремя группами: на узком окне
          колонка уже строки, и группа целиком уходит на следующую строку. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <ColorSquare value={v.color} title="Цвет букв" onChange={(color) => put({ color })} />
        <span className="flex items-center gap-1.5">
          <IconToggle
            active={v.bold}
            disabled={Boolean(family && !family.bold)}
            title={family && !family.bold ? 'У этого шрифта нет жирного начертания' : 'Жирный'}
            onClick={() => put({ bold: !v.bold })}
          >
            <Bold size={14} />
          </IconToggle>
          <IconToggle
            active={v.italic}
            disabled={Boolean(family && !family.italic)}
            title={family && !family.italic ? 'У этого шрифта нет курсива' : 'Курсив'}
            onClick={() => put({ italic: !v.italic })}
          >
            <Italic size={14} />
          </IconToggle>
        </span>
        <span className="flex items-center gap-1.5">
          <IconToggle active={v.align === 'left'} title="По левому краю" onClick={() => put({ align: 'left' })}>
            <AlignLeft size={14} />
          </IconToggle>
          <IconToggle active={v.align === 'center'} title="По центру" onClick={() => put({ align: 'center' })}>
            <AlignCenter size={14} />
          </IconToggle>
          <IconToggle active={v.align === 'right'} title="По правому краю" onClick={() => put({ align: 'right' })}>
            <AlignRight size={14} />
          </IconToggle>
        </span>
      </div>

      <EffectSection
        label="Обводка"
        on={v.strokeOn}
        onToggle={(value) => put(value && !(mark.stroke ?? 0) ? { strokeOn: true, stroke: stock } : { strokeOn: value })}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SliderNumber
              label="Толщина"
              value={v.stroke}
              min={1}
              max={Math.max(20, stock * 4)}
              unit="px"
              reset={stock}
              onChange={(stroke) => put({ stroke: Math.max(0, stroke) })}
            />
          </div>
          <ColorSquare value={v.strokeColor} title="Цвет обводки" onChange={(strokeColor) => put({ strokeColor })} />
        </div>
      </EffectSection>

      <EffectSection
        label="Тень"
        on={v.shadowOn}
        onToggle={(value) =>
          put(
            value && mark.shadowX === undefined
              ? { shadowOn: true, shadowX: stock, shadowY: stock }
              : { shadowOn: value },
          )
        }
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-2">
            <SliderNumber
              label="Вправо"
              value={v.shadowX}
              min={-Math.max(30, stock * 6)}
              max={Math.max(30, stock * 6)}
              unit="px"
              reset={stock}
              onChange={(shadowX) => put({ shadowX })}
            />
            <SliderNumber
              label="Вниз"
              value={v.shadowY}
              min={-Math.max(30, stock * 6)}
              max={Math.max(30, stock * 6)}
              unit="px"
              reset={stock}
              onChange={(shadowY) => put({ shadowY })}
            />
            <SliderNumber
              label="Видимость"
              value={Math.round(v.shadowAlpha * 100)}
              min={0}
              max={100}
              unit="%"
              reset={75}
              onChange={(value) => put({ shadowAlpha: value / 100 })}
            />
            <SliderNumber
              label="Размытие"
              value={v.shadowBlur}
              min={0}
              max={Math.max(30, stock * 6)}
              step={0.5}
              unit="px"
              reset={0}
              onChange={(shadowBlur) => put({ shadowBlur: Math.max(0, shadowBlur) })}
            />
          </div>
          <ColorSquare value={v.shadowColor} title="Цвет тени" onChange={(shadowColor) => put({ shadowColor })} />
        </div>
      </EffectSection>

      <EffectSection label="Подложка" on={v.box} onToggle={(box) => put({ box })}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-2">
            <SliderNumber
              label="Видимость"
              value={Math.round(v.boxAlpha * 100)}
              min={0}
              max={100}
              unit="%"
              reset={50}
              onChange={(value) => put({ boxAlpha: value / 100 })}
            />
            <SliderNumber
              label="Отступ"
              value={v.boxPad}
              min={0}
              max={Math.max(40, stock * 8)}
              unit="px"
              reset={10}
              onChange={(boxPad) => put({ boxPad: Math.max(0, boxPad) })}
            />
            <SliderNumber
              label="Скругление"
              value={v.boxRadius}
              min={0}
              max={Math.max(60, stock * 10)}
              unit="px"
              reset={0}
              onChange={(boxRadius) => put({ boxRadius: Math.max(0, boxRadius) })}
            />
          </div>
          <ColorSquare value={v.boxColor} title="Цвет подложки" onChange={(boxColor) => put({ boxColor })} />
        </div>
      </EffectSection>
    </div>
  )
}

/** Код цвета: вписать можно и «#ff8800», и «ff8800». */
function HexField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const apply = () => {
    if (draft === null) return
    const clean = draft.trim().replace(/^#/, '')
    if (/^[0-9a-fA-F]{6}$/.test(clean)) onChange(`#${clean.toLowerCase()}`)
    setDraft(null)
  }
  return (
    <input
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={apply}
      onKeyDown={(event) => {
        if (event.key === 'Enter') apply()
      }}
      title="Код цвета"
      className="h-8 w-[92px] rounded-lg border border-line-soft bg-surface-2 px-2 font-mono text-[12px] uppercase outline-none"
    />
  )
}

export function ImageFillPanel({
  box,
  natural,
  onChange,
  onCommit,
}: {
  box: Rect
  natural: { width: number; height: number }
  onChange: (patch: Partial<Rect>) => void
  onCommit: () => void
}) {
  const touch = useUndoSession(onCommit)
  const put = (patch: Partial<Rect>) => {
    touch()
    onChange(patch)
  }
  const colour = box.color ?? '#000000'
  const short = Math.min(box.width, box.height)
  // Обычная толщина рамки и сдвиг тени — от размера картинки, как в монтаже
  // от высоты кадра: на снимке 4K рамка в пару пикселей не видна.
  const stock = Math.max(2, Math.round(Math.min(natural.width, natural.height) / 180))

  return (
    <div className="space-y-3.5">
      <Title>Заливка</Title>

      <div className="space-y-1">
        <Row label="Положение">
          <NumberBox
            value={box.x}
            unit="x"
            title="Левый край заливки, в пикселях картинки"
            onDone={(value) => put({ x: Math.round(Math.min(natural.width - box.width, Math.max(0, value))) })}
          />
          <NumberBox
            value={box.y}
            unit="y"
            title="Верхний край заливки, в пикселях картинки"
            onDone={(value) => put({ y: Math.round(Math.min(natural.height - box.height, Math.max(0, value))) })}
          />
        </Row>
        <Row label="Размер">
          <NumberBox
            value={box.width}
            unit="ш"
            title="Ширина заливки, в пикселях картинки"
            onDone={(value) => put({ width: Math.round(Math.min(natural.width - box.x, Math.max(8, value))) })}
          />
          <NumberBox
            value={box.height}
            unit="в"
            title="Высота заливки, в пикселях картинки"
            onDone={(value) => put({ height: Math.round(Math.min(natural.height - box.y, Math.max(8, value))) })}
          />
        </Row>
      </div>

      <div className="flex items-center gap-2">
        <ColorSquare value={colour} title="Цвет заливки" onChange={(color) => put({ color })} />
        <HexField value={colour} onChange={(color) => put({ color })} />
      </div>

      <SliderNumber
        label="Скругление"
        value={box.radius ?? 0}
        min={0}
        max={Math.max(8, Math.round(short / 2))}
        unit="px"
        reset={0}
        onChange={(radius) => put({ radius: Math.max(0, radius) })}
      />

      <EffectSection
        label="Рамка"
        on={box.strokeOn ?? false}
        onToggle={(value) =>
          put({
            strokeOn: value,
            ...(value && !((box.stroke ?? 0) > 0) ? { stroke: stock } : {}),
            ...(value && !box.strokeColor ? { strokeColor: '#ffffff' } : {}),
          })
        }
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SliderNumber
              label="Толщина"
              value={box.stroke ?? stock}
              min={1}
              max={Math.max(40, stock * 8)}
              unit="px"
              reset={stock}
              onChange={(stroke) => put({ stroke: Math.max(0, stroke) })}
            />
            {/* Рамка — снаружи заливки. Её внешние углы по умолчанию следуют
                скруглению заливки; ноль — так и есть. */}
            <SliderNumber
              label="Скругление"
              value={box.strokeRound ?? 0}
              min={0}
              max={Math.max(8, Math.round(short / 2))}
              unit="px"
              reset={0}
              onChange={(strokeRound) => put({ strokeRound: Math.max(0, strokeRound) })}
            />
          </div>
          <ColorSquare
            value={box.strokeColor ?? '#ffffff'}
            title="Цвет рамки"
            onChange={(strokeColor) => put({ strokeColor })}
          />
        </div>
      </EffectSection>

      <EffectSection
        label="Тень"
        on={box.shadowOn ?? false}
        onToggle={(value) =>
          put(
            value && box.shadowX === undefined && box.shadowY === undefined
              ? { shadowOn: true, shadowX: stock * 2, shadowY: stock * 2, shadowAlpha: 0.75 }
              : { shadowOn: value },
          )
        }
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-2">
            <SliderNumber
              label="Вправо"
              value={box.shadowX ?? 0}
              min={-Math.max(40, stock * 10)}
              max={Math.max(40, stock * 10)}
              unit="px"
              reset={stock * 2}
              onChange={(shadowX) => put({ shadowX })}
            />
            <SliderNumber
              label="Вниз"
              value={box.shadowY ?? 0}
              min={-Math.max(40, stock * 10)}
              max={Math.max(40, stock * 10)}
              unit="px"
              reset={stock * 2}
              onChange={(shadowY) => put({ shadowY })}
            />
            <SliderNumber
              label="Видимость"
              value={Math.round((box.shadowAlpha ?? 0.75) * 100)}
              min={0}
              max={100}
              unit="%"
              reset={75}
              onChange={(value) => put({ shadowAlpha: value / 100 })}
            />
            <SliderNumber
              label="Размытие"
              value={box.shadowBlur ?? 0}
              min={0}
              max={Math.max(40, stock * 10)}
              step={0.5}
              unit="px"
              reset={0}
              onChange={(shadowBlur) => put({ shadowBlur: Math.max(0, shadowBlur) })}
            />
          </div>
          <ColorSquare
            value={box.shadowColor ?? '#000000'}
            title="Цвет тени"
            onChange={(shadowColor) => put({ shadowColor })}
          />
        </div>
      </EffectSection>
    </div>
  )
}
