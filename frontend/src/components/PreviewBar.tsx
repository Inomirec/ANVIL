import { useState } from 'react'
import { Camera, ChevronDown, Grid3x3 } from 'lucide-react'
import { GRIDS, type GridKind } from './ComposeFrameBox'
import { Dropdown, IconButton } from './ui'

/** Кратности экрана просмотра в списке у «100%». */
export const VIEWS = [0.5, 0.75, 1, 1.5, 2, 3, 4]

/**
 * Сетка поверх кадра: кнопка включает, список рядом меняет вид. Выбор
 * запоминается под ``key`` — включают её обычно надолго. Выключенная сетка
 * помнит свой вид: включил — вернулась та же.
 */
export function useGridChoice(key: string) {
  const [on, setOn] = useState(() => localStorage.getItem(`${key}On`) === '1')
  const [kind, setKind] = useState<GridKind>(() => {
    const saved = localStorage.getItem(key)
    return GRIDS.some((item) => item.value === saved && item.value !== 'none') ? (saved as GridKind) : 'thirds'
  })
  return {
    on,
    kind,
    shown: (on ? kind : 'none') as GridKind,
    toggle: () => {
      setOn((was) => {
        localStorage.setItem(`${key}On`, was ? '0' : '1')
        return !was
      })
    },
    pick: (value: GridKind) => {
      setKind(value)
      setOn(true)
      localStorage.setItem(key, value)
      localStorage.setItem(`${key}On`, '1')
    },
  }
}

/**
 * Плашка над кадром: увеличение экрана, сетка, свои кнопки окна и снимок
 * кадра. Одна и та же в монтаже и в медиатеке. Маленькой плашкой поверх
 * сцены, а не своей строкой: строка отнимала у кадра высоту.
 *
 * Плашка — с полупрозрачным размытым фоном; списки на ней открываются в
 * корне страницы (`Dropdown`), иначе они уезжали бы в сторону.
 */
export function PreviewBar({
  view,
  changed,
  onReset,
  onView,
  grid,
  onSnap,
  snapping,
  snapTitle = 'Сохранить кадр картинкой',
  gridTitle = 'Сетка поверх кадра. По ней видно, попадает ли важное в середину и в трети кадра.',
  children,
}: {
  view: number
  /** Кадр увеличен или сдвинут — «100%» подсвечено. */
  changed: boolean
  onReset: () => void
  onView: (view: number) => void
  grid: ReturnType<typeof useGridChoice>
  onSnap: () => void
  snapping: boolean
  snapTitle?: string
  gridTitle?: string
  /** Кнопки только этого окна — между сеткой и снимком. */
  children?: React.ReactNode
}) {
  return (
    <div className="absolute inset-x-0 top-1.5 z-20 mx-auto flex w-fit items-center gap-0.5 rounded-lg bg-surface/85 px-1 py-0.5 ring-1 ring-line-soft backdrop-blur">
      {/* Увеличительное стекло: сколько сейчас и выбор кратности. Нажатие
          на число возвращает обычный размер. */}
      <div className="flex items-center">
        <button
          type="button"
          onClick={onReset}
          title="Увеличение экрана просмотра — на готовый файл не влияет. Колесо приближает, зажатое колесо таскает кадр. Нажмите, чтобы вернуть обычный размер."
          className={`inline-flex h-6 items-center rounded-md px-1.5 font-mono text-[10.5px] tabular-nums transition-colors ${
            changed ? 'bg-accent/20 text-accent-soft hover:bg-accent/30' : 'text-ink-faint hover:text-ink'
          }`}
        >
          {Math.round(view * 100)}%
        </button>
        <Dropdown
          value={String(view)}
          title="Насколько увеличить экран"
          className="flex h-6 w-3.5 items-center justify-center text-ink-faint hover:text-ink"
          options={VIEWS.map((item) => ({ value: String(item), label: `Экран ${Math.round(item * 100)}%` }))}
          onChange={(item) => onView(Number(item))}
        >
          <ChevronDown size={11} />
        </Dropdown>
      </div>

      {/* Сетка — кнопка включает и выключает, стрелка рядом меняет вид:
          сам список нужен редко, а место занимал бы постоянно. */}
      <div className="flex items-center">
        <IconButton
          className="h-6 w-6"
          title={gridTitle}
          active={grid.on}
          onClick={grid.toggle}
        >
          <Grid3x3 size={13} />
        </IconButton>
        <Dropdown
          value={grid.kind}
          title="Какая сетка"
          className="flex h-6 w-3.5 items-center justify-center text-ink-faint hover:text-ink"
          options={GRIDS.filter((item) => item.value !== 'none')}
          onChange={grid.pick}
        >
          <ChevronDown size={11} />
        </Dropdown>
      </div>

      {children}

      <IconButton className="h-6 w-6" title={snapTitle} onClick={onSnap} disabled={snapping}>
        <Camera size={13} />
      </IconButton>
    </div>
  )
}
