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
 * Часики у показателя: включить ключи и выключить.
 *
 * Включили — под иглой встаёт первый ключ с тем, что сейчас в кадре; дальше
 * любая правка этого показателя в другом месте клипа ставит там ключ, и между
 * ключами значение плавно меняется. Выключили — ключи пропадают, показатель
 * остаётся таким, каким был под иглой. Нажатие заодно выбирает группу: её
 * ключи видны на таймлайне.
 */
export function AnimClock({ clip, group }: { clip: ComposeClip; group: string }) {
  const found = groupOf(clip, group)
  const toggleAnim = useCompose((state) => state.toggleAnim)
  const focus = useCompose((state) => state.animFocus)
  if (!found) return null
  const keyed = isKeyed(clip, found)
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        toggleAnim(clip.id, group)
      }}
      title={
        keyed
          ? `${found.label}: меняется по ключам. Нажмите, чтобы убрать ключи — останется то, что сейчас под иглой`
          : `${found.label}: менять во времени. Под иглой встанет ключ; поставьте иглу в другое место и поменяйте значение — там появится второй`
      }
      className={`shrink-0 rounded p-0.5 transition-colors ${
        keyed
          ? `text-accent-soft hover:text-ink ${focus === group ? 'bg-accent/25' : ''}`
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
}: {
  value: number
  unit: string
  onDone: (value: number) => void
  title?: string
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
export function PlaceFields({ clip, size = true }: { clip: ComposeClip; size?: boolean }) {
  const playhead = useCompose((state) => state.playhead)
  const frameW = useCompose((state) => state.width)
  const frameH = useCompose((state) => state.height)
  const applyValues = useCompose((state) => state.applyValues)
  const setAnimFocus = useCompose((state) => state.setAnimFocus)
  const focus = useCompose((state) => state.animFocus)
  const now = shownAt(clip, playhead)
  const row = (group: string, label: string, body: React.ReactNode) => (
    <div
      className={`flex items-center gap-2 rounded-md px-1 py-0.5 ${focus === group ? 'bg-accent/10' : ''}`}
      onMouseDown={() => setAnimFocus(group)}
    >
      <span className="w-[70px] shrink-0 text-[11.5px] text-ink-dim">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{body}</div>
      <AnimClock clip={clip} group={group} />
    </div>
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
  const button = 'flex h-8 w-7 items-center justify-center rounded-lg text-ink-dim hover:bg-surface-3 hover:text-ink disabled:opacity-30'
  return (
    <div className="flex items-center rounded-lg border border-line-soft bg-surface-2" title={group.label}>
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
        title={`${group.label}: поставить ключ под иглой`}
      >
        <DiamondPlus size={14} />
      </button>
      <button
        type="button"
        className={`${button} ${onKey ? 'text-accent-soft' : ''}`}
        disabled={!onKey}
        onClick={() => unkeyHere(clip.id, group.id)}
        title={`${group.label}: удалить ключ под иглой`}
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
