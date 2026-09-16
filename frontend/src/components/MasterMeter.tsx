import { useEffect, useRef, useState } from 'react'
import { Volume1, Volume2, VolumeX } from 'lucide-react'

/**
 * Мастер-шина: уровень звука в децибелах и громкость прослушивания.
 *
 * Показывает, насколько громким получится файл, — именно то, ради чего такая
 * шкала стоит в монтажных программах. Ползунок рядом меняет только громкость
 * в наушниках: на готовый файл он не влияет, поэтому уровень снимается **до**
 * него. Иначе, убавив звук у себя, человек увидел бы тихий монтаж и полез бы
 * его усиливать.
 */

/** Отметки шкалы, дБ. Ноль — потолок, ниже -60 уже ничего не разобрать. */
const MARKS = [0, -6, -12, -18, -24, -30, -36, -42, -48, -54, -60]
const FLOOR = -60
/** Сколько держится пиковая отметка, прежде чем поползёт вниз. */
const PEAK_HOLD_MS = 1200

/** Доля высоты шкалы для уровня в децибелах. */
function share(db: number): number {
  if (db <= FLOOR) return 0
  return Math.min(1, (db - FLOOR) / -FLOOR)
}

export interface MeterLevels {
  left: number
  right: number
}

export function MasterMeter({
  levels,
  volume,
  onVolume,
  active,
}: {
  /** Текущий уровень по каналам, дБ. */
  levels: MeterLevels
  /** Громкость прослушивания, 0..1. */
  volume: number
  onVolume: (value: number) => void
  /** Идёт ли воспроизведение — по нему гасим пики, когда всё остановлено. */
  active: boolean
}) {
  const [peaks, setPeaks] = useState<MeterLevels>({ left: FLOOR, right: FLOOR })
  const peakAt = useRef<{ left: number; right: number }>({ left: 0, right: 0 })

  // Пик держится секунду и сползает: мгновенный всплеск иначе не заметить,
  // а именно он и решает, не будет ли в файле перегруза.
  useEffect(() => {
    const now = Date.now()
    setPeaks((old) => {
      const next = { ...old }
      for (const side of ['left', 'right'] as const) {
        if (levels[side] >= old[side]) {
          next[side] = levels[side]
          peakAt.current[side] = now
        } else if (now - peakAt.current[side] > PEAK_HOLD_MS) {
          next[side] = Math.max(FLOOR, old[side] - 1.5)
        }
      }
      return next
    })
  }, [levels])

  useEffect(() => {
    if (!active) setPeaks({ left: FLOOR, right: FLOOR })
  }, [active])

  const Icon = volume <= 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  return (
    <div className="flex w-[104px] shrink-0 flex-col border-l border-line-soft bg-surface px-2 py-2">
      <span className="mb-1 text-center text-[10px] uppercase tracking-[0.08em] text-ink-faint">
        Уровень
      </span>

      <div className="flex min-h-0 flex-1 gap-1.5">
        {/* Ползунок громкости прослушивания */}
        <div className="flex w-5 flex-col items-center">
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            onChange={(event) => onVolume(Number(event.target.value) / 100)}
            title={`Громкость прослушивания ${Math.round(volume * 100)}% — на готовый файл не влияет`}
            className="master-volume"
          />
        </div>

        {/* Шкала с подписями */}
        <div className="relative w-6 shrink-0">
          {MARKS.map((db) => (
            <div
              key={db}
              className="absolute right-0 flex w-full items-center justify-end gap-0.5"
              style={{ top: `${(1 - share(db)) * 100}%`, transform: 'translateY(-50%)' }}
            >
              <span className="font-mono text-[8px] tabular-nums text-ink-faint">{db}</span>
              <span className="h-px w-1 bg-line" />
            </div>
          ))}
        </div>

        {/* Полоски каналов */}
        <div className="flex min-h-0 flex-1 gap-1">
          {(['left', 'right'] as const).map((side) => (
            <Channel key={side} db={levels[side]} peak={peaks[side]} />
          ))}
        </div>
      </div>

      <div className="mt-1.5 flex items-center justify-center gap-1 text-[10px] text-ink-faint">
        <Icon size={11} />
        {Math.round(volume * 100)}%
      </div>
    </div>
  )
}

/** Одна полоска: заливка по уровню плюс метка пика. */
function Channel({ db, peak }: { db: number; peak: number }) {
  const height = share(db)
  const loud = db > -6
  const hot = db > -1
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-sm bg-surface-3">
      <div
        className={`absolute inset-x-0 bottom-0 transition-[height] duration-75 ${
          hot ? 'bg-danger' : loud ? 'bg-warn' : 'bg-ok'
        }`}
        style={{ height: `${height * 100}%` }}
      />
      {peak > FLOOR && (
        <div
          className={`absolute inset-x-0 h-px ${peak > -1 ? 'bg-danger' : 'bg-ink-dim'}`}
          style={{ bottom: `${share(peak) * 100}%` }}
        />
      )}
    </div>
  )
}
