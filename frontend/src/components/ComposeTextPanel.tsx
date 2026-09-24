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

interface FontRow {
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
function FontPicker({
  value,
  fonts,
  onChange,
}: {
  value: string
  fonts: FontRow[] | null
  onChange: (name: string) => void
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
        <div className="absolute inset-x-0 top-full z-40 mt-1 overflow-hidden rounded-xl border border-line bg-surface-2 shadow-xl">
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

/** Цвет квадратиком: нажали — открылся выбор цвета. */
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
    <label
      title={title}
      className="relative flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line-soft hover:border-line"
    >
      <span className="h-5 w-5 rounded-[4px] ring-1 ring-black/40" style={{ background: value }} />
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </label>
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
}: {
  label: string
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
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const apply = () => {
    if (draft === null) return
    const number = Number(draft.replace(',', '.'))
    if (Number.isFinite(number)) onChange(Math.min(max, Math.max(min, number)))
    setDraft(null)
  }
  const row = (
    <div className="flex items-center gap-2">
      {!stacked && <span className="w-[70px] shrink-0 text-[11.5px] text-ink-dim">{label}</span>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        title={`Двойное нажатие вернёт ${reset} ${unit}`}
        onMouseDown={(event) => {
          if (event.detail < 2) return
          event.preventDefault()
          onChange(reset)
        }}
        onChange={(event) => onChange(Number(event.target.value))}
        className="min-w-0 flex-1"
      />
      <label className="flex w-[60px] shrink-0 items-center rounded-md border border-line-soft bg-surface-2 px-1.5">
        <input
          value={draft ?? String(Math.round(value * 10) / 10)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={apply}
          onKeyDown={(event) => {
            if (event.key === 'Enter') apply()
          }}
          className="w-full min-w-0 bg-transparent py-1 text-right font-mono text-[11.5px] tabular-nums outline-none"
        />
        <span className="ml-0.5 text-[10px] text-ink-faint">{unit}</span>
      </label>
    </div>
  )
  if (!stacked) return row
  return (
    <div className="space-y-1">
      <span className="block text-[11.5px] text-ink-dim">{label}</span>
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
function SizeField({ pixels, onChange }: { pixels: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const holder = useRef<HTMLDivElement>(null)
  useOutside(open, holder, () => setOpen(false))
  const apply = () => {
    if (draft === null) return
    const number = Number(draft.replace(',', '.'))
    if (Number.isFinite(number) && number > 0) onChange(Math.min(SIZE_MAX, Math.max(SIZE_MIN, number)))
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
        title={`Размер букв, в пикселях кадра: от ${SIZE_MIN} до ${SIZE_MAX}`}
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

      <TextBox
        value={v.text}
        onChange={(text) => put({ text, name: text.split('\n')[0] || 'Текст' })}
      />

      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <FontPicker value={v.font} fonts={fonts} onChange={(name) => put({ font: name })} />
        </div>
        <SizeField pixels={Math.round(v.fontSize * height)} onChange={(value) => put({ fontSize: fraction(value) })} />
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
          </div>
          <ColorSquare value={v.boxColor} title="Цвет подложки" onChange={(value) => put({ boxColor: value })} />
        </div>
      </EffectSection>
    </div>
  )
}
