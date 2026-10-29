import { AnimClock, PlaceFields } from './ComposeAnimUi'
import { shownAt } from '../composeAnim'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  Italic,
  Search,
  Star,
} from 'lucide-react'
import { api } from '../lib/api'
import { ColorButton } from './ColorPicker'
import {
  EFFECT_PIXELS,
  TEXT_DEFAULTS,
  effectDefaults,
  useCompose,
  type ComposeClip,
} from '../composeStore'

/**
 * Настройки надписи — в правой колонке, пока надпись выделена.
 *
 * Отдельное окно закрывало собой экран просмотра, и подбирать цвет или тень,
 * не видя кадра, было нельзя. Здесь кадр всегда перед глазами. Текст пишут и
 * тут, в поле, и прямо в кадре — что удобнее: правка в одном месте тут же
 * видна в другом.
 *
 * Места в колонке немного, поэтому всё, что можно показать значком, показано
 * значком, а эффекты спрятаны за галочками: пока галочка снята, эффекта нет и
 * его настроек не видно, но они помнятся и вернутся такими же.
 *
 * Размеры человек задаёт в пикселях кадра проекта — это привычная мера. Внутри
 * они хранятся долями высоты кадра, чтобы проект, собранный в другом
 * разрешении, выглядел так же.
 */

export interface FontRow {
  name: string
  bold: boolean
  italic: boolean
}

const FAVORITES_KEY = 'sgh.fontFavorites'

/** Готовые размеры букв, в пикселях кадра проекта. Вписать можно любой. */
const SIZE_PRESETS = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72]

/**
 * Пределы размера букв. Сверху ограничиваем не из вредности: буквы в пару
 * тысяч пикселей не помещаются в кадр целиком, от надписи остаётся кусок
 * одной буквы, а окно тратит силы на то, чего не видно.
 */
const SIZE_MIN = 4
const SIZE_MAX = 300

/** Высота поля для текста, до которой оно растёт само; дальше — прокрутка. */
const TEXT_MAX_HEIGHT = 168

function readFavorites(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]')
    return Array.isArray(saved) ? saved.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** Закрыть всплывающий список, если нажали мимо него. */
function useOutside(open: boolean, ref: React.RefObject<HTMLElement>, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, ref, close])
}

/**
 * Выбор шрифта: поиск и избранное.
 *
 * Шрифтов в системе сотни, и листать их подряд невозможно. Поиск сужает
 * список по мере набора, а звёздочка поднимает шрифт в самый верх — те пять,
 * которыми пользуются постоянно, всегда под рукой. Каждое имя написано своим
 * же шрифтом: выбирают глазами, а не по названию.
 */
export function FontPicker({
  value,
  fonts,
  onChange,
  up = false,
}: {
  value: string
  fonts: FontRow[] | null
  onChange: (name: string) => void
  /** Открывать список вверх — когда поле стоит у нижнего края окна. */
  up?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [favorites, setFavorites] = useState<string[]>(readFavorites)
  const holder = useRef<HTMLDivElement>(null)
  useOutside(open, holder, () => setOpen(false))

  const toggleFavorite = (name: string) => {
    setFavorites((was) => {
      const next = was.includes(name) ? was.filter((item) => item !== name) : [...was, name]
      try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(next))
      } catch {
        // Без памяти избранное проживёт до перезапуска — это не беда.
      }
      return next
    })
  }

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const found = (fonts ?? []).filter((item) => !needle || item.name.toLowerCase().includes(needle))
    const starred = found.filter((item) => favorites.includes(item.name))
    const rest = found.filter((item) => !favorites.includes(item.name))
    return { starred, rest }
  }, [fonts, query, favorites])

  const row = (item: FontRow) => (
    <li key={item.name} className="flex items-center">
      <button
        type="button"
        title={favorites.includes(item.name) ? 'Убрать из избранного' : 'В избранное — будет наверху списка'}
        onClick={() => toggleFavorite(item.name)}
        className="shrink-0 p-1.5 text-ink-faint hover:text-warn"
      >
        <Star size={13} className={favorites.includes(item.name) ? 'fill-warn text-warn' : ''} />
      </button>
      <button
        type="button"
        onClick={() => {
          onChange(item.name)
          setOpen(false)
        }}
        className={`min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-left text-[14px] hover:bg-surface-3 ${
          item.name === value ? 'text-accent-soft' : 'text-ink'
        }`}
        style={{ fontFamily: `"${item.name}", sans-serif` }}
      >
        {item.name}
      </button>
    </li>
  )

  return (
    <div ref={holder} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((was) => !was)
          setQuery('')
        }}
        className="field flex w-full items-center gap-2 text-left"
        title="Шрифт"
      >
        <span className="min-w-0 flex-1 truncate text-[14px]" style={{ fontFamily: `"${value}", sans-serif` }}>
          {value}
        </span>
        <ChevronDown size={14} className="shrink-0 text-ink-faint" />
      </button>
      {open && (
        <div
          className={`absolute left-0 right-0 z-40 min-w-[240px] overflow-hidden rounded-xl border border-line bg-surface-2 shadow-xl ${
            up ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          <label className="flex items-center gap-2 border-b border-line-soft px-2.5 py-2">
            <Search size={13} className="shrink-0 text-ink-faint" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Найти шрифт"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-ink-faint"
            />
          </label>
          <ul className="max-h-[300px] overflow-y-auto p-1">
            {!fonts && <li className="px-2 py-3 text-[12px] text-ink-faint">Читаю список шрифтов…</li>}
            {rows.starred.map(row)}
            {rows.starred.length > 0 && rows.rest.length > 0 && <li className="my-1 h-px bg-line-soft" />}
            {rows.rest.map(row)}
            {fonts && !rows.starred.length && !rows.rest.length && (
              <li className="px-2 py-3 text-[12px] text-ink-faint">Такого шрифта нет</li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Квадратная кнопка-значок: включено — подсвечена. */
export function IconToggle({
  active,
  title,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  title: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-30 ${
        active ? 'border-accent bg-accent/20 text-accent-soft' : 'border-line-soft text-ink-dim hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Цвет квадратиком: нажали — открылось своё окошко выбора цвета, с рабочей
 * пипеткой (`ColorPicker`).
 */
export function ColorSquare({
  value,
  title,
  onChange,
}: {
  value: string
  title: string
  onChange: (value: string) => void
}) {
  return (
    <ColorButton
      value={value}
      title={title}
      onChange={onChange}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line-soft hover:border-line"
    >
      <span className="h-5 w-5 rounded-[4px] ring-1 ring-black/40" style={{ background: value }} />
    </ColorButton>
  )
}

/**
 * Ползунок с числом рядом. Ползунком подбирают на глаз, в поле вписывают
 * точное значение. Двойное нажатие по ползунку возвращает его на место: задеть
 * легко, а вспомнить, каким он был, — нет. Второе нажатие перехватываем ещё до
 * того, как ползунок прыгнет под курсор, иначе «вернуть» возвращало что попало.
 *
 * Поле держит набранное строкой и применяет по Enter или когда его оставили:
 * иначе на первой же цифре число подгонялось бы под пределы.
 */
export function SliderNumber({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  reset,
  onChange,
  stacked = false,
  marks,
  aside,
  readout,
  entryLimits,
}: {
  /** Подпись; у подписанного сверху ползунка это может быть и кнопка. */
  label: React.ReactNode
  value: number
  min: number
  max: number
  step?: number
  unit: string
  /** Куда вернуть по двойному нажатию. */
  reset: number
  onChange: (value: number) => void
  /** Подпись строкой над ползунком — для длинных подписей. */
  stacked?: boolean
  /** Рекомендованные значения — подписи под шкалой, нажатие ставит значение. */
  /** ``hint`` — что даёт это значение, во всплывающей подсказке. */
  marks?: { value: number; label: string; hint?: string }[]
  /** Что стоит справа от подписи — например, часики ключей. */
  aside?: React.ReactNode
  /**
   * Вместо поля числа — готовая подпись значения: у шкалы, где само число
   * человеку ничего не говорит (качество сборки).
   */
  readout?: React.ReactNode
  /** Пределы набранного числа, если они шире шкалы. */
  entryLimits?: [number, number]
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const apply = () => {
    if (draft === null) return
    const number = Number(draft.replace(',', '.'))
    const [low, high] = entryLimits ?? [min, max]
    if (Number.isFinite(number)) onChange(Math.min(high, Math.max(low, number)))
    setDraft(null)
  }
  const range = (
    <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        title={readout ? 'Двойное нажатие вернёт обычное значение' : `Двойное нажатие вернёт ${reset} ${unit}`}
        onMouseDown={(event) => {
          if (event.detail < 2) return
          event.preventDefault()
          onChange(reset)
        }}
        onChange={(event) => onChange(Number(event.target.value))}
        className={marks?.length ? 'w-full' : 'min-w-0 flex-1'}
      />
  )
  // Подписи рекомендованных значений под шкалой. Эффект считается не сразу —
  // стабилизатор и вовсе минуты, — и искать хорошее значение наугад долго.
  // Метка стоит ровно под своим делением: поправка на ширину бегунка, иначе у
  // краёв шкалы она съезжала бы от него.
  // Метки стоят плотно, если соседние ближе чем на полшкалы: шкала в колонке
  // шириной в полторы сотни пикселей, и слова соседних подписей налезали
  // друг на друга. Тогда подписи идут лесенкой — соседи в разных рядах.
  // Подписи-буквы (S, M, L) не налезают и стоят в один ряд.
  const crowded = Boolean(
    marks?.some((mark) => mark.label.length > 2) &&
      marks?.some((mark, index) => index > 0 && (mark.value - marks[index - 1].value) / (max - min) < 0.6),
  )
  const scale = marks?.length ? (
    <div className="min-w-0 flex-1">
      {range}
      <div className={`relative ${crowded ? 'h-[30px]' : 'h-3.5'}`}>
        {marks.map((mark, index) => {
          const share = (mark.value - min) / (max - min)
          // Тесно — каждая вторая подпись уходит строкой ниже, на длинной
          // риске: шкала в колонке узкая, и слова налезали друг на друга.
          const lower = crowded && index % 2 === 1
          const near = Math.abs(value - mark.value) <= (max - min) * 0.02
          // У самых краёв подпись не по центру деления, а прижата внутрь:
          // иначе она выступала бы за шкалу.
          const edge = share < 0.12 ? 'start' : share > 0.88 ? 'end' : 'middle'
          return (
            <button
              // По номеру, а не по значению: при совпавших значениях
              // одинаковые ключи оставляли на шкале лишние подписи.
              key={index}
              type="button"
              onClick={() => onChange(mark.value)}
              title={mark.hint ? (readout ? mark.hint : `${mark.hint} — ${mark.value}${unit ? ' ' + unit : ''}`) : readout ? `Поставить «${mark.label}»` : `Поставить ${mark.value}${unit ? ' ' + unit : ''}`}
              className={`absolute top-0 whitespace-nowrap text-[9.5px] leading-none transition-colors ${
                edge === 'middle' ? '-translate-x-1/2' : edge === 'end' ? '-translate-x-full' : ''
              } ${near ? 'text-accent-soft' : 'text-ink-faint hover:text-ink-dim'}`}
              style={{ left: `calc(${share * 100}% + ${(0.5 - share) * 12}px)` }}
            >
              <span
                className={`mb-0.5 block w-px bg-current ${lower ? 'h-[16px] opacity-50' : 'h-1'} ${
                  edge === 'middle' ? 'mx-auto' : edge === 'end' ? 'ml-auto' : ''
                }`}
              />
              {mark.label}
            </button>
          )
        })}
      </div>
    </div>
  ) : (
    range
  )
  // Поле числа. В строке с ползунком ему тесно: «кбит/с» не влезало, и
  // нельзя было понять, 700 там или 7000, — поэтому у подписанного сверху
  // ползунка число стоит в строке названия, где места хватает.
  const entry = (
    <label
      className={`flex shrink-0 items-center rounded-md border border-line-soft bg-surface-2 px-1.5 ${
        stacked ? '' : 'w-[60px]'
      }`}
    >
      <input
        value={draft ?? String(Math.round(value * 10) / 10)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === 'Enter') apply()
        }}
        className={`${stacked ? 'w-[52px]' : 'w-full'} min-w-0 bg-transparent py-1 text-right font-mono text-[11.5px] tabular-nums outline-none`}
      />
      <span className="ml-0.5 whitespace-nowrap text-[10px] text-ink-faint">{unit}</span>
    </label>
  )
  const row = (
    <div className={`flex gap-2 ${marks?.length ? 'items-start' : 'items-center'}`}>
      {!stacked && <span className="w-[70px] shrink-0 text-[11.5px] text-ink-dim">{label}</span>}
      {scale}
      {!stacked && entry}
    </div>
  )
  if (!stacked) return row
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <span className="block min-w-0 flex-1 text-[11.5px] text-ink-dim">{label}</span>
        {readout ?? entry}
        {aside}
      </div>
      {row}
    </div>
  )
}

/** Галочка, за которой прячутся настройки эффекта. */
export function EffectSection({
  label,
  on,
  onToggle,
  children,
}: {
  label: string
  on: boolean
  onToggle: (value: boolean) => void
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2.5 border-t border-line-soft pt-3">
      <label className="flex cursor-pointer items-center gap-2 text-[12.5px] font-medium">
        <input
          type="checkbox"
          checked={on}
          onChange={(event) => onToggle(event.target.checked)}
          className="h-3.5 w-3.5 accent-[var(--color-accent)]"
        />
        {label}
      </label>
      {on && <div className="space-y-2.5 pl-1">{children}</div>}
    </div>
  )
}

/** Размер букв: число и выпадающий список готовых. */
export function SizeField({
  pixels,
  onChange,
  max = SIZE_MAX,
  unitTitle = 'в пикселях кадра',
}: {
  pixels: number
  onChange: (value: number) => void
  /** Верхний предел: у картинки в тысячи точек буквы бывают крупнее кадра. */
  max?: number
  unitTitle?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const holder = useRef<HTMLDivElement>(null)
  useOutside(open, holder, () => setOpen(false))
  const apply = () => {
    if (draft === null) return
    const number = Number(draft.replace(',', '.'))
    if (Number.isFinite(number) && number > 0) onChange(Math.min(max, Math.max(SIZE_MIN, number)))
    setDraft(null)
  }
  return (
    <div ref={holder} className="relative flex w-[84px] shrink-0 items-center rounded-lg border border-line-soft bg-surface-2">
      <input
        value={draft ?? String(pixels)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === 'Enter') apply()
        }}
        title={`Размер букв, ${unitTitle}: от ${SIZE_MIN} до ${max}`}
        className="h-8 w-full min-w-0 bg-transparent pl-2 font-mono text-[12.5px] tabular-nums outline-none"
      />
      <button
        type="button"
        title="Готовые размеры"
        onClick={() => setOpen((was) => !was)}
        className="flex h-8 w-6 shrink-0 items-center justify-center text-ink-faint hover:text-ink"
      >
        <ChevronDown size={13} />
      </button>
      {open && (
        <ul className="absolute right-0 top-full z-40 mt-1 max-h-[260px] w-[84px] overflow-y-auto rounded-xl border border-line bg-surface-2 p-1 shadow-xl">
          {SIZE_PRESETS.map((size) => (
            <li key={size}>
              <button
                type="button"
                onClick={() => {
                  onChange(size)
                  setOpen(false)
                }}
                className={`w-full rounded-md px-2 py-1 text-left font-mono text-[12px] tabular-nums hover:bg-surface-3 ${
                  size === pixels ? 'text-accent-soft' : 'text-ink'
                }`}
              >
                {size}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Поле для текста: маленькое, растёт вместе с текстом и упирается в предел —
 * дальше обычная прокрутка, чтобы длинная надпись не заняла всю колонку.
 */
function TextBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const area = useRef<HTMLTextAreaElement>(null)
  // Высоту подгоняем до отрисовки, иначе поле на миг мигало бы прежней.
  useLayoutEffect(() => {
    const node = area.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight + 2, TEXT_MAX_HEIGHT)}px`
  }, [value])
  return (
    <textarea
      ref={area}
      rows={1}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onFocus={() => useCompose.getState().mark()}
      placeholder="Что написать"
      className="field block w-full resize-none overflow-y-auto leading-snug"
      style={{ maxHeight: TEXT_MAX_HEIGHT }}
    />
  )
}

export function ComposeTextPanel({ clip }: { clip: ComposeClip }) {
  const updateClip = useCompose((state) => state.updateClip)
  const height = useCompose((state) => state.height)
  const playhead = useCompose((state) => state.playhead)
  const applyValues = useCompose((state) => state.applyValues)
  const mark = useCompose((state) => state.mark)
  const [fonts, setFonts] = useState<FontRow[] | null>(null)

  useEffect(() => {
    let alive = true
    api
      .fonts()
      .then((data) => {
        if (alive) setFonts(data.fonts)
      })
      .catch(() => {
        // Без списка шрифтов надпись всё равно нарисуется — тем шрифтом, что
        // найдётся, — поэтому молча оставляем пустой список.
        if (alive) setFonts([])
      })
    return () => {
      alive = false
    }
  }, [])

  const v = { ...TEXT_DEFAULTS, ...clip }
  const put = (patch: Partial<ComposeClip>) => updateClip(clip.id, patch)
  // Пиксели кадра проекта ⇄ доли высоты кадра.
  const px = (share: number) => Math.round(share * height * 10) / 10
  const fraction = (pixels: number) => pixels / height
  const family = fonts?.find((item) => item.name === v.font)
  const stock = effectDefaults(height)

  return (
    <div className="space-y-3.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Надпись</h3>

      {/* Положение числами, с часиками: надпись можно вести по кадру. */}
      <PlaceFields clip={clip} size={false} />

      <TextBox
        value={v.text}
        onChange={(text) => put({ text, name: text.split('\n')[0] || 'Текст' })}
      />

      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <FontPicker value={v.font} fonts={fonts} onChange={(name) => put({ font: name })} />
        </div>
        {/* Размер букв меняется и по ключам: часики рядом с полем. */}
        <SizeField
          pixels={Math.round(shownAt(v, playhead).fontSize! * height)}
          onChange={(value) => {
            mark()
            applyValues(clip.id, { fontSize: fraction(value) })
          }}
        />
        <AnimClock clip={clip} group="fontSize" />
      </div>

      {/* Цвет, начертание и выравнивание — одной строкой значков. */}
      <div className="flex items-center gap-1.5">
        <ColorSquare value={v.textColor} title="Цвет букв" onChange={(value) => put({ textColor: value })} />
        <span className="mx-0.5 h-5 w-px bg-line-soft" />
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
        <span className="mx-0.5 h-5 w-px bg-line-soft" />
        <IconToggle active={v.align === 'left'} title="По левому краю" onClick={() => put({ align: 'left' })}>
          <AlignLeft size={14} />
        </IconToggle>
        <IconToggle active={v.align === 'center'} title="По центру" onClick={() => put({ align: 'center' })}>
          <AlignCenter size={14} />
        </IconToggle>
        <IconToggle active={v.align === 'right'} title="По правому краю" onClick={() => put({ align: 'right' })}>
          <AlignRight size={14} />
        </IconToggle>
      </div>

      <EffectSection
        label="Обводка"
        on={v.strokeOn}
        onToggle={(value) =>
          // Включили, а толщины нет (надпись из прежней версии) — даём
          // обычную, чтобы эффект было видно сразу.
          put(value && !(v.stroke > 0) ? { strokeOn: true, stroke: stock.stroke } : { strokeOn: value })
        }
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SliderNumber
              label="Толщина"
              value={px(v.stroke)}
              min={0.5}
              max={6}
              step={0.5}
              unit="px"
              reset={EFFECT_PIXELS.stroke}
              onChange={(value) => put({ stroke: fraction(value) })}
            />
          </div>
          <ColorSquare value={v.strokeColor} title="Цвет обводки" onChange={(value) => put({ strokeColor: value })} />
        </div>
      </EffectSection>

      <EffectSection
        label="Тень"
        on={v.shadowOn}
        onToggle={(value) =>
          // Тень на нулях не видна вовсе — включая её, ставим обычный сдвиг.
          put(
            value && !v.shadowX && !v.shadowY
              ? { shadowOn: true, shadowX: stock.shadowX, shadowY: stock.shadowY, shadowAlpha: stock.shadowAlpha }
              : { shadowOn: value },
          )
        }
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-2">
            <SliderNumber
              label="Вправо"
              value={px(v.shadowX)}
              min={-10}
              max={10}
              step={0.5}
              unit="px"
              reset={EFFECT_PIXELS.shadowX}
              onChange={(value) => put({ shadowX: fraction(value) })}
            />
            <SliderNumber
              label="Вниз"
              value={px(v.shadowY)}
              min={-10}
              max={10}
              step={0.5}
              unit="px"
              reset={EFFECT_PIXELS.shadowY}
              onChange={(value) => put({ shadowY: fraction(value) })}
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
              value={px(v.shadowBlur)}
              min={0}
              max={30}
              step={0.5}
              unit="px"
              reset={0}
              onChange={(value) => put({ shadowBlur: fraction(value) })}
            />
          </div>
          <ColorSquare value={v.shadowColor} title="Цвет тени" onChange={(value) => put({ shadowColor: value })} />
        </div>
      </EffectSection>

      <EffectSection label="Подложка" on={v.box} onToggle={(value) => put({ box: value })}>
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
              value={px(v.boxPad)}
              min={0}
              max={20}
              unit="px"
              reset={EFFECT_PIXELS.boxPad}
              onChange={(value) => put({ boxPad: fraction(value) })}
            />
            <SliderNumber
              label="Скругление"
              value={px(v.boxRadius)}
              min={0}
              max={60}
              unit="px"
              reset={0}
              onChange={(value) => put({ boxRadius: fraction(value) })}
            />
          </div>
          <ColorSquare value={v.boxColor} title="Цвет подложки" onChange={(value) => put({ boxColor: value })} />
        </div>
      </EffectSection>
    </div>
  )
}
