import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Check, ChevronDown, MoreHorizontal, X, type LucideIcon } from 'lucide-react'

/* Мелкие переиспользуемые элементы интерфейса. */

/**
 * Подсказки только при наведении.
 *
 * В панелях обработки и загрузки описания под каждой галочкой и пресетом
 * занимали столько места, что важные кнопки уезжали за прокрутку, а человеку,
 * который знает, что делает переключатель, описание ничего не даёт. Внутри
 * `QuietHints` описание уходит во всплывающую подсказку — оно по-прежнему есть,
 * просто не занимает место. В диалогах (настройки, сборка) описания остаются
 * на виду: туда заходят редко и как раз затем, чтобы разобраться.
 */
const Quiet = createContext(false)

export function QuietHints({ children }: { children: ReactNode }) {
  return <Quiet.Provider value={true}>{children}</Quiet.Provider>
}

/** Подпись под полем — или ничего, если подсказки прячутся в наведение. */
/** Подсказка при наведении — только там, где она не написана под полем. */
function useHintTitle(hint?: string): string | undefined {
  return useContext(Quiet) ? hint : undefined
}

function HintLine({ hint }: { hint?: string }) {
  const quiet = useContext(Quiet)
  if (!hint || quiet) return null
  return <p className="mt-1 text-[11px] leading-snug text-ink-faint">{hint}</p>
}

type ButtonTone = 'primary' | 'ghost' | 'subtle' | 'danger'

export function Button({
  children,
  onClick,
  tone = 'subtle',
  disabled,
  title,
  className = '',
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  tone?: ButtonTone
  disabled?: boolean
  title?: string
  className?: string
  type?: 'button' | 'submit'
}) {
  const tones: Record<ButtonTone, string> = {
    primary:
      'bg-accent-strong text-white hover:bg-accent shadow-[0_0_10px_rgba(22,156,145,0.14),inset_0_1px_0_rgba(255,255,255,0.1)]',
    subtle: 'bg-surface-3 text-ink hover:bg-line',
    ghost: 'bg-transparent text-ink-dim hover:bg-surface-3 hover:text-ink',
    danger: 'bg-danger/15 text-danger hover:bg-danger/25',
  }
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  )
}

export function IconButton({
  children,
  onClick,
  title,
  active,
  disabled,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  title?: string
  active?: boolean
  disabled?: boolean
  className?: string
}) {
  // Свой размер в className заменяет обычный, а не спорит с ним: из двух
  // «h-8» и «h-6» побеждал тот, что раньше в таблице стилей, — и «маленькие»
  // кнопки оставались обычными, вылезая за край колонки.
  const size = /(^|\s)h-/.test(className) ? '' : 'h-8 w-8'
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex shrink-0 ${size} items-center justify-center rounded-lg transition-colors disabled:opacity-35 ${
        active ? 'bg-accent/20 text-accent-soft' : 'text-ink-dim hover:bg-surface-3 hover:text-ink'
      } ${className}`}
    >
      {children}
    </button>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  const quiet = useContext(Quiet)
  return (
    <label
      title={quiet ? hint : undefined}
      className={`flex items-start gap-3 rounded-lg px-1 py-1.5 ${
        disabled ? 'opacity-45' : 'cursor-pointer'
      }`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative mt-0.5 h-[18px] w-[32px] shrink-0 rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-surface-3'
        }`}
      >
        <span
          className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${
            checked ? 'left-[16px]' : 'left-[2px]'
          }`}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium leading-tight text-ink">{label}</span>
        {hint && !quiet && (
          <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">{hint}</span>
        )}
      </span>
    </label>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
  hint,
  disabled,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onChange: (value: number) => void
  hint?: string
  disabled?: boolean
}) {
  const hintTitle = useHintTitle(hint)
  return (
    <div className={disabled ? 'opacity-45' : ''} title={hintTitle}>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="label mb-0">{label}</span>
        <span className="font-mono text-[12px] text-ink">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        className="w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <HintLine hint={hint} />
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className = '',
  columns: forced,
  stacked = false,
}: {
  value: T
  options: { value: T; label: string; badge?: ReactNode; title?: string; disabled?: boolean }[]
  onChange: (value: T) => void
  className?: string
  /** Сколько кнопок в ряду. Больше кнопок — перенесутся на следующий ряд. */
  columns?: number
  /** Подпись сверху, число снизу. Нужно там, где числа бывают большими:
      в строку «Кадры 909» не влезает, и название обрезается до «Кад…». */
  stacked?: boolean
}) {
  // grid вместо flex: колонки одинаковой ширины делятся поровну и не
  // раздуваются под длинную подпись, поэтому переключатель никогда не вылезает
  // за пределы панели — и полосы прокрутки не нужны.
  const perRow = forced ?? options.length
  const columns =
    ['', 'grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4', 'grid-cols-5', 'grid-cols-6'][
      perRow
    ] ?? 'grid-cols-4'

  return (
    <div className={`grid ${columns} gap-1 rounded-xl bg-surface-2 p-1 ${className}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={`flex min-w-0 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
            stacked
              ? 'flex-col items-center justify-center gap-0.5 px-1 py-2 text-[12px]'
              : `items-center justify-center gap-1 px-1 py-1.5 ${
                  perRow > 4 ? 'text-[11px]' : 'text-[12px]'
                }`
          } ${
            value === option.value
              ? 'bg-surface-3 text-ink shadow-sm'
              : 'text-ink-faint hover:text-ink-dim'
          }`}
        >
          <span className="max-w-full truncate">{option.label}</span>
          {option.badge !== undefined &&
            (stacked ? (
              <span className="text-[12px] tabular-nums opacity-80">{option.badge}</span>
            ) : (
              <span className="shrink-0 rounded bg-base/60 px-1 text-[10px] tabular-nums">
                {option.badge}
              </span>
            ))}
        </button>
      ))}
    </div>
  )
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: {
  label?: string
  value: T
  options: { value: T; label: string; disabled?: boolean }[]
  onChange: (value: T) => void
  hint?: string
  disabled?: boolean
}) {
  const hintTitle = useHintTitle(hint)
  return (
    <div title={hintTitle}>
      {label && <span className="label">{label}</span>}
      <select
        className="field cursor-pointer"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <HintLine hint={hint} />
    </div>
  )
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  hint,
  disabled,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  hint?: string
  disabled?: boolean
}) {
  const hintTitle = useHintTitle(hint)
  return (
    <div className={disabled ? 'opacity-45' : ''} title={hintTitle}>
      <span className="label">{label}</span>
      <div className="relative">
        <input
          type="number"
          className="field pr-10"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => {
            const next = Number(event.target.value)
            if (Number.isFinite(next)) onChange(next)
          }}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-ink-faint">
            {suffix}
          </span>
        )}
      </div>
      <HintLine hint={hint} />
    </div>
  )
}

/**
 * Раздел правой колонки.
 *
 * С `id` раздел сворачивается нажатием на заголовок, и это запоминается.
 * Свёрнутый раздел показывает рядом с заголовком `summary` — что в нём
 * выбрано: иначе, свернув «Разрешение», человек забыл бы, что там стоит.
 * `hint` — пояснение ко всему разделу, при наведении.
 */
export function Section({
  title,
  children,
  action,
  id,
  summary,
  hint,
  defaultFolded = false,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
  /** Ключ для запоминания свёрнутости. Без него раздел не сворачивается. */
  id?: string
  /** Что показать у заголовка, пока раздел свёрнут. */
  summary?: ReactNode
  hint?: string
  /** Свёрнут, пока человек сам его не раскрыл. */
  defaultFolded?: boolean
}) {
  const key = id ? `sgh.section.${id}` : null
  const [folded, setFolded] = useState(() => {
    if (!key) return false
    try {
      const saved = localStorage.getItem(key)
      return saved === null ? defaultFolded : saved === '1'
    } catch {
      return false
    }
  })
  const toggle = () => {
    if (!key) return
    const next = !folded
    setFolded(next)
    try {
      localStorage.setItem(key, next ? '1' : '0')
    } catch {
      /* запомнить не вышло — не беда */
    }
  }
  const heading = (
    <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{title}</h3>
  )
  return (
    <section className={folded ? '' : 'space-y-3'} title={hint}>
      <header className="flex items-center justify-between gap-2">
        {key ? (
          <button
            type="button"
            onClick={toggle}
            title={folded ? 'Развернуть' : 'Свернуть'}
            className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <ChevronDown
              size={12}
              className={`shrink-0 text-accent-soft transition-transform group-hover:text-ink ${
                folded ? '-rotate-90' : ''
              }`}
            />
            {heading}
            {folded && summary && (
              <span className="ml-auto flex min-w-0 items-center gap-1.5 truncate text-[11px] text-ink-dim">
                {summary}
              </span>
            )}
          </button>
        ) : (
          heading
        )}
        {action}
      </header>
      {!folded && children}
    </section>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
  steady,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  wide?: boolean
  /**
   * Постоянная высота: окно не растёт, когда внутри раскрывают подсказку, а
   * прокручивается внутри. Иначе окно с длинным списком прыгало по экрану.
   */
  steady?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className={`animate-in-up flex max-h-[86vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl ${
          wide ? 'max-w-4xl' : 'max-w-lg'
        } ${steady ? 'h-[86vh]' : ''}`}
      >
        <header className="flex items-center justify-between border-b border-line-soft px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <IconButton onClick={onClose} title="Закрыть">
            <X size={16} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

/**
 * Небольшой список выбора в стиле программы.
 *
 * Обычный ``select`` рисует список силами Windows: белый, с чужими шрифтами и
 * отступами — посреди тёмного окна он выглядит заплаткой. Здесь список свой,
 * как меню по правой кнопке на таймлайне.
 *
 * Кнопку рисует тот, кто вызывает: где-то это значок со стрелкой, где-то
 * подпись с нынешним значением.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  children,
  align = 'left',
  title,
  className = '',
}: {
  value: T
  /** ``title`` — пояснение пункта при наведении. */
  /** ``disabled`` — пункт виден, но выбрать его нельзя. */
  options: { value: T; label: string; hint?: string; title?: string; disabled?: boolean }[]
  onChange: (value: T) => void
  /** Кнопка, по которой список открывается. */
  children: ReactNode
  align?: 'left' | 'right'
  title?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: 0, top: 0 })

  useLayoutEffect(() => {
    if (!open) return
    const from = trigger.current?.getBoundingClientRect()
    const size = list.current?.getBoundingClientRect()
    if (!from || !size) return
    const gap = 6
    const left = align === 'right' ? from.right - size.width : from.left
    setPlace({
      left: Math.max(gap, Math.min(left, window.innerWidth - size.width - gap)),
      top: Math.max(
        gap,
        Math.min(from.bottom + 4, window.innerHeight - size.height - gap),
      ),
    })
  }, [open, align])

  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      if (event.type === 'mousedown' && trigger.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <>
      <button
        ref={trigger}
        type="button"
        title={title}
        onClick={() => setOpen((was) => !was)}
        className={className}
      >
        {children}
      </button>
      {open && (
        <div
          ref={list}
          className="fixed z-50 min-w-[150px] rounded-xl border border-line bg-surface-2 p-1 shadow-xl"
          style={place}
        >
          {options.map((item) => (
            <button
              key={item.value}
              type="button"
              title={item.title}
              disabled={item.disabled}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => {
                onChange(item.value)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                item.value === value
                  ? 'bg-accent/20 text-accent-soft'
                  : 'text-ink-dim hover:bg-surface-3 hover:text-ink'
              }`}
            >
              <span className="w-3 shrink-0">
                {item.value === value && <Check size={12} />}
              </span>
              <span className="flex-1 truncate">{item.label}</span>
              {item.hint && (
                <span className="shrink-0 font-mono text-[10px] text-ink-faint">{item.hint}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

export function Empty({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="text-ink-faint/50">{icon}</div>
      <p className="text-[15px] font-medium text-ink-dim">{title}</p>
      {hint && <p className="max-w-sm text-[13px] leading-relaxed text-ink-faint">{hint}</p>}
    </div>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-line border-t-accent"
      style={{ width: size, height: size }}
    />
  )
}

/** Включённая галочка в свёрнутом разделе: значок и что он значит. */
export interface Mark {
  icon: LucideIcon
  label: string
  /** Опасное (удаление оригинала) — красным, чтобы не забыть. */
  danger?: boolean
}

/**
 * Значки всех включённых галочек — для заголовка свёрнутого раздела.
 *
 * Прежде там стоял один-два значка из нескольких, и по свёрнутому разделу
 * нельзя было понять, что в нём включено. Теперь видны все, а если в одну
 * строку с названием раздела они не помещаются — лишние уходят под «…», и
 * их список — в подсказке. Опасные стоят первыми: их нельзя прятать.
 */
export function MarkIcons({ marks, max = 4 }: { marks: Mark[]; max?: number }) {
  const sorted = [...marks.filter((mark) => mark.danger), ...marks.filter((mark) => !mark.danger)]
  const shown = sorted.length > max ? sorted.slice(0, max - 1) : sorted
  const hidden = sorted.slice(shown.length)
  return (
    <>
      {shown.map((mark) => (
        <span
          key={mark.label}
          title={mark.label}
          className={
            mark.danger
              ? 'flex items-center rounded bg-danger/15 px-1 py-0.5 text-danger'
              : 'flex items-center text-accent-soft'
          }
        >
          <mark.icon size={13} />
        </span>
      ))}
      {hidden.length > 0 && (
        <span title={hidden.map((mark) => mark.label).join('\n')} className="flex items-center text-accent-soft">
          <MoreHorizontal size={14} />
        </span>
      )}
    </>
  )
}

/** Где лежит ширина колонок: левая одна на все вкладки, правая — тоже. */
const COLUMN_KEYS = { left: 'sgh.leftWidth', right: 'sgh.rightWidth' } as const

/**
 * Боковая колонка, которую тянут за край.
 *
 * Пока человек её не трогал, ширина — по окну (``fallback``, `clamp` в CSS).
 * Потянул — ширина запоминается и не меньше той, что у колонки в самом
 * маленьком окне (``min``): уже настройки перестают помещаться. Двойное
 * нажатие по краю возвращает ширину по окну. Нужна, чтобы отдать середине
 * больше места — кадру и таймлайну.
 */
export function SideColumn({
  side,
  min,
  max,
  fallback,
  className = '',
  children,
}: {
  side: 'left' | 'right'
  min: number
  max: number
  /** Класс ширины, пока человек её не задал. */
  fallback: string
  className?: string
  children: ReactNode
}) {
  const key = COLUMN_KEYS[side]
  const [width, setWidth] = useState<number | null>(() => {
    try {
      const saved = Number(localStorage.getItem(key))
      return saved > 0 ? saved : null
    } catch {
      return null
    }
  })
  const box = useRef<HTMLElement>(null)
  const fit = (value: number) => Math.round(Math.min(max, Math.max(min, value)))

  const grab = (event: React.MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    if (event.detail >= 2) {
      setWidth(null)
      try {
        localStorage.removeItem(key)
      } catch {
        /* не запомнилось — не беда */
      }
      return
    }
    const from = event.clientX
    const start = box.current?.offsetWidth ?? min
    let last = start
    const move = (moved: MouseEvent) => {
      const shift = moved.clientX - from
      last = fit(side === 'left' ? start + shift : start - shift)
      setWidth(last)
    }
    const drop = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', drop)
      try {
        localStorage.setItem(key, String(last))
      } catch {
        /* не запомнилось — не беда */
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
  }

  return (
    <aside
      ref={box}
      className={`relative ${width === null ? fallback : ''} ${className}`}
      style={width === null ? undefined : { width: fit(width) }}
    >
      {children}
      <div
        onMouseDown={grab}
        title="Потяните, чтобы сделать колонку уже или шире. Двойное нажатие — обычная ширина"
        className={`absolute inset-y-0 z-30 w-[5px] cursor-col-resize hover:bg-accent/30 ${
          side === 'left' ? 'right-0' : 'left-0'
        }`}
      />
    </aside>
  )
}

