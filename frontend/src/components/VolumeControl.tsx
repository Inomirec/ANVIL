import { useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { IconButton } from './ui'

/**
 * Громкость просмотра: значок, а над ним при наведении — вертикальный
 * ползунок. Отдельный ползунок в строке на узком окне прятался, и оставалось
 * только «есть звук / нет звука». Нажатие по значку — выключить и включить.
 */
export function VolumeControl({
  volume,
  muted,
  onMute,
  onChange,
  title,
  small = false,
  popupClassName = '',
}: {
  volume: number
  muted: boolean
  onMute: () => void
  onChange: (value: number) => void
  /** Что это за громкость — в подсказке у значка. */
  title?: string
  /** Кнопка помельче — для плотной панели таймлайна монтажа. */
  small?: boolean
  /**
   * Классы всплывающего ползунка. Панель монтажа прячет его, когда рядом со
   * значком помещается обычная полоска: значок при этом остаётся тем же.
   */
  popupClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  const shown = muted ? 0 : volume

  const setFrom = (clientY: number) => {
    const box = bar.current?.getBoundingClientRect()
    if (!box) return
    const value = Math.min(1, Math.max(0, 1 - (clientY - box.top) / box.height))
    onChange(Math.round(value * 100) / 100)
  }

  return (
    <span
      className="relative flex shrink-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!dragging) setOpen(false)
      }}
    >
      <IconButton
        onClick={onMute}
        className={small ? 'h-7 w-7' : ''}
        title={title ?? `Громкость просмотра ${Math.round(shown * 100)}% — на файл не влияет. Нажмите, чтобы ${muted ? 'включить' : 'выключить'} (M)`}
      >
        {shown === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </IconButton>
      {(open || dragging) && (
        // Отступ снизу — прозрачный мостик: курсор идёт от значка к
        // ползунку и не теряет его по дороге.
        <span className={`absolute bottom-full left-1/2 z-40 -translate-x-1/2 pb-1 ${popupClassName}`}>
          <span className="flex flex-col items-center gap-1.5 border border-line bg-surface-2 px-2 pb-2 pt-1.5 shadow-xl">
            <span className="font-mono text-[10px] tabular-nums text-ink-dim">{Math.round(shown * 100)}</span>
            <div
              ref={bar}
              className="relative h-24 w-1.5 cursor-pointer bg-surface-3"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                setDragging(true)
                setFrom(event.clientY)
              }}
              onPointerMove={(event) => {
                if (dragging) setFrom(event.clientY)
              }}
              onPointerUp={() => setDragging(false)}
              onLostPointerCapture={() => setDragging(false)}
            >
              <div className="absolute inset-x-0 bottom-0 bg-accent" style={{ height: `${shown * 100}%` }} />
              <div
                className="absolute left-1/2 h-3 w-3 -translate-x-1/2 translate-y-1/2 rounded-full bg-ink shadow"
                style={{ bottom: `${shown * 100}%` }}
              />
            </div>
          </span>
        </span>
      )}
    </span>
  )
}
