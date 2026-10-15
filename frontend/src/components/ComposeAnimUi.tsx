import { useState } from 'react'
import { ChevronLeft, ChevronRight, DiamondMinus, DiamondPlus, Timer } from 'lucide-react'
import {
  groupOf,
  isKeyed,
  KEY_NEAR,
  keyTimes,
  shownAt,
  type AnimGroup,
} from '../composeAnim'
import { useCompose, type ComposeClip } from '../composeStore'

/**
 * Часики у показателя: «ключи этой настройки сейчас в работе».
 *
 * Гореть могут только одни часики на всё: включили эти — прежние погасли. У
 * включённых ключи видны на таймлайне, их двигают, копируют и удаляют, а
 * кнопки ключей на панели таймлайна работают с ними. Нет ещё ключей — под
 * иглой встаёт первый. Выключение ничего не стирает: ключи остаются и
 * работают, просто их не видно. Правка настройки с ключами в любом случае
 * ложится в ключ под иглой.
 */
export function AnimClock({ clip, group }: { clip: ComposeClip; group: string }) {
  const found = groupOf(clip, group)
  const toggleAnim = useCompose((state) => state.toggleAnim)
  const focus = useCompose((state) => state.animFocus)
  if (!found) return null
  const keyed = isKeyed(clip, found)
  const active = focus === group
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        toggleAnim(clip.id, group)
      }}
      title={
        active
          ? `${found.label}: ключи в работе — видны на таймлайне. Нажмите, чтобы спрятать (ключи останутся)`
          : keyed
            ? `${found.label}: есть ключи. Нажмите, чтобы показать их на таймлайне и править`
            : `${found.label}: менять во времени. Под иглой встанет ключ; поставьте иглу в другое место и поменяйте значение — там появится второй`
      }
      className={`shrink-0 rounded p-0.5 transition-colors ${
        active
          ? 'bg-accent text-white'
          : keyed
            ? 'text-accent-soft hover:bg-surface-3'
            : 'text-ink-faint/60 hover:text-ink-dim'
      }`}
    >
      <Timer size={13} />
    </button>
  )
}

/** Число, которое правят набором: применяется по Enter и когда поле оставили. */
function NumberBox({
  value,
  unit,
  onDone,
  title,
  narrow = false,
}: {
  value: number
  unit: string
  onDone: (value: number) => void
  title?: string
  /** Узкое поле на три цифры — рядом с ползунком, которому нужно место. */
  narrow?: boolean
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
      className={`flex min-w-0 items-center rounded-md border border-line-soft bg-surface-2 px-1.5 ${
        narrow ? 'w-[52px] shrink-0' : 'flex-1'
      }`}
    >
      <input
        value={draft ?? String(Math.round(value))}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => useCompose.getState().mark()}
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

/**
 * Место и размер клипа числами — с часиками у каждого.
 *
 * Положение — середина клипа в пикселях кадра проекта (0 — левый/верхний
 * край), размер — в процентах от кадра. Рамкой в окне просмотра то же самое
 * делается мышью; числа нужны, чтобы поставить точно и чтобы было к чему
 * приделать часики.
 */
export function PlaceFields({
  clip,
  size = true,
  opacity = true,
}: {
  clip: ComposeClip
  size?: boolean
  /** У картинки и ролика непрозрачность живёт в карточке «Видимость». */
  opacity?: boolean
}) {
  const playhead = useCompose((state) => state.playhead)
  const frameW = useCompose((state) => state.width)
  const frameH = useCompose((state) => state.height)
  const applyValues = useCompose((state) => state.applyValues)
  const focus = useCompose((state) => state.animFocus)
  const now = shownAt(clip, playhead)
  const row = (group: string, label: string, body: React.ReactNode) => (
    <AnimRow clip={clip} group={group} label={label} focused={focus === group}>
      {body}
    </AnimRow>
  )
  return (
    <div className="space-y-1">
      {row(
        'position',
        'Положение',
        <>
          <NumberBox
            value={now.x * frameW}
            unit="x"
            title="Середина клипа по горизонтали, в пикселях кадра"
            onDone={(value) => applyValues(clip.id, { x: value / frameW })}
          />
          <NumberBox
            value={now.y * frameH}
            unit="y"
            title="Середина клипа по вертикали, в пикселях кадра"
            onDone={(value) => applyValues(clip.id, { y: value / frameH })}
          />
        </>,
      )}
      {opacity && <OpacityRow clip={clip} label="Видимость" />}
      {size &&
        row(
          'size',
          'Размер',
          <>
            <NumberBox
              value={now.size * 100}
              unit="%"
              title="Ширина места клипа в процентах кадра"
              onDone={(value) => applyValues(clip.id, { size: Math.max(1, value) / 100 })}
            />
            {clip.kind === 'color' && (
              <NumberBox
                value={(now.sizeY && now.sizeY > 0 ? now.sizeY : now.size) * 100}
                unit="%"
                title="Высота заливки в процентах кадра"
                onDone={(value) => applyValues(clip.id, { sizeY: Math.max(1, value) / 100 })}
              />
            )}
          </>,
        )}
    </div>
  )
}

/**
 * Кнопки ключей под окном просмотра: к предыдущему, поставить или убрать под
 * иглой, к следующему. Работают с группой, выбранной в колонке справа, и
 * появляются, только когда у неё уже есть ключи.
 */
export function KeyButtons({ clip }: { clip: ComposeClip }) {
  const focus = useCompose((state) => state.animFocus)
  const playhead = useCompose((state) => state.playhead)
  const setPlayhead = useCompose((state) => state.setPlayhead)
  const keyHere = useCompose((state) => state.keyHere)
  const unkeyHere = useCompose((state) => state.unkeyHere)
  const group: AnimGroup | undefined = groupOf(clip, focus)
  if (!group || !isKeyed(clip, group)) return null
  const local = playhead - clip.start
  const times = keyTimes(clip, group).filter((t) => t >= -1e-3 && t <= clip.duration + 1e-3)
  const onKey = times.some((t) => Math.abs(t - local) < KEY_NEAR)
  const before = [...times].reverse().find((t) => t < local - KEY_NEAR)
  const after = times.find((t) => t > local + KEY_NEAR)
  const button = 'flex h-7 w-6 items-center justify-center rounded-md text-ink-dim hover:bg-surface-3 hover:text-ink disabled:opacity-30'
  return (
    <div className="flex items-center" title={group.label}>
      <button
        type="button"
        className={button}
        disabled={before === undefined}
        onClick={() => before !== undefined && setPlayhead(clip.start + before)}
        title={`${group.label}: к предыдущему ключу`}
      >
        <ChevronLeft size={14} />
      </button>
      <button
        type="button"
        className={button}
        disabled={onKey}
        onClick={() => keyHere(clip.id, group.id)}
        title={`${group.label}: поставить ключ под иглой (K)`}
      >
        <DiamondPlus size={14} />
      </button>
      <button
        type="button"
        className={`${button} ${onKey ? 'text-accent-soft' : ''}`}
        disabled={!onKey}
        onClick={() => unkeyHere(clip.id, group.id)}
        title={`${group.label}: удалить ключ под иглой (Shift+K). Выбранные ромбики удаляет Delete`}
      >
        <DiamondMinus size={14} />
      </button>
      <button
        type="button"
        className={button}
        disabled={after === undefined}
        onClick={() => after !== undefined && setPlayhead(clip.start + after)}
        title={`${group.label}: к следующему ключу`}
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}

/**
 * Кнопки ключей на панели таймлайна — для выбранного клипа и включённых
 * часиков. Стоят рядом с кнопками дорожек, надписи и заливки: за ключом не
 * надо тянуться мышью через весь экран.
 */
export function KeyBar() {
  const selected = useCompose((state) => state.selected)
  const focus = useCompose((state) => state.animFocus)
  const tracks = useCompose((state) => state.tracks)
  if (!focus) return null
  const clip = tracks
    .flatMap((track) => track.clips)
    .find((item) => selected.includes(item.id) && groupOf(item, focus))
  if (!clip) return null
  return (
    <>
      <span className="mx-0.5 h-4 w-px bg-line-soft" />
      <KeyButtons clip={clip} />
    </>
  )
}

/** Строка «подпись — поля — часики» с подсветкой, пока её часики горят. */
function AnimRow({
  clip,
  group,
  label,
  focused,
  children,
  wide = false,
}: {
  clip: ComposeClip
  group: string
  label: string
  focused: boolean
  children: React.ReactNode
  /** Подпись с часиками строкой сверху — для длинной подписи в узкой колонке. */
  wide?: boolean
}) {
  if (wide) {
    // Подпись с часиками — строкой сверху, ползунку остаётся вся ширина.
    return (
      <div className={`space-y-1 rounded-md px-1 py-0.5 ${focused ? 'bg-accent/10' : ''}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-ink-dim">{label}</span>
          <AnimClock clip={clip} group={group} />
        </div>
        <div className="flex min-w-0 items-center gap-1.5">{children}</div>
      </div>
    )
  }
  return (
    <div className={`flex items-center gap-2 rounded-md px-1 py-0.5 ${focused ? 'bg-accent/10' : ''}`}>
      <span className="w-[70px] shrink-0 text-[11.5px] text-ink-dim">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
      <AnimClock clip={clip} group={group} />
    </div>
  )
}

/**
 * Непрозрачность клипа — ползунком и числом, с часиками. Правка ложится в
 * ключ под иглой, если ключи есть (`applyValues`).
 */
export function OpacityRow({
  clip,
  label,
  wide = false,
}: {
  clip: ComposeClip
  label: string
  wide?: boolean
}) {
  const playhead = useCompose((state) => state.playhead)
  const applyValues = useCompose((state) => state.applyValues)
  const focus = useCompose((state) => state.animFocus)
  const now = shownAt(clip, playhead)
  return (
    <AnimRow clip={clip} group="opacity" label={label} focused={focus === 'opacity'} wide={wide}>
      {/* Ползунок — подбирать на глаз, поле — вписать точно. */}
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(now.opacity * 100)}
        title="Непрозрачность клипа: вправо — виден целиком, влево — не виден вовсе. Двойное нажатие вернёт 100%"
        onMouseDown={(event) => {
          useCompose.getState().mark()
          if (event.detail >= 2) {
            event.preventDefault()
            applyValues(clip.id, { opacity: 1 })
          }
        }}
        onChange={(event) => applyValues(clip.id, { opacity: Number(event.target.value) / 100 })}
        className="min-w-0 flex-1"
      />
      <NumberBox
        value={now.opacity * 100}
        unit="%"
        narrow
        title="Непрозрачность клипа: 100 — виден целиком, 0 — не виден вовсе"
        onDone={(value) => applyValues(clip.id, { opacity: Math.min(100, Math.max(0, value)) / 100 })}
      />
    </AnimRow>
  )
}
