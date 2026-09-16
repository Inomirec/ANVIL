import { useEffect, useRef, useState } from 'react'

/**
 * Мастер-шина: уровень звука в децибелах и громкость всего монтажа.
 *
 * Шкала показывает, насколько громким получится файл, — ради этого такая
 * штука и стоит в монтажных программах. Фейдер рядом меняет громкость всего
 * монтажа разом и влияет на готовый файл; громкость прослушивания живёт
 * отдельно, на панели под окном просмотра, и на файл не влияет.
 *
 * Подписи делений нарисованы **внутри** шкалы: вынесенные наружу, они
 * занимали ширину, которой у шины и так немного.
 */

/** Отметки шкалы, дБ. Ноль — потолок, ниже -60 уже ничего не разобрать. */
const MARKS = [0, -12, -24, -36, -48]
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
  master,
  onMaster,
  active,
}: {
  /** Текущий уровень по каналам, дБ. */
  levels: MeterLevels
  /** Громкость всего монтажа, 0..2. Уходит в готовый файл. */
  master: number
  onMaster: (value: number) => void
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

  return (
    <div className="flex w-[62px] shrink-0 flex-col items-center border-l border-line-soft bg-surface px-1.5 py-2">
      <div className="flex min-h-0 flex-1 items-stretch gap-1">
        {/* Фейдер громкости всего монтажа */}
        <input
          type="range"
          min={0}
          max={200}
          value={Math.round(master * 100)}
          onChange={(event) => onMaster(Number(event.target.value) / 100)}
          title={`Громкость монтажа ${Math.round(master * 100)}% — уходит в готовый файл`}
          className="master-fader"
        />

        {/* Полоски каналов с подписями делений прямо на них */}
        <div className="relative flex min-h-0 gap-[3px]">
          {(['left', 'right'] as const).map((side) => (
            <Channel key={side} db={levels[side]} peak={peaks[side]} />
          ))}

          <div className="pointer-events-none absolute inset-0">
            {MARKS.map((db) => (
              <div
                key={db}
                className="absolute inset-x-0 flex items-center"
                style={{ top: `${(1 - share(db)) * 100}%`, transform: 'translateY(-50%)' }}
              >
                <span className="w-full bg-black/45 text-center font-mono text-[7.5px] leading-[9px] tabular-nums text-white/70">
                  {db}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <span
        className={`mt-1 font-mono text-[10px] tabular-nums ${
          master > 1 ? 'text-warn' : 'text-ink-faint'
        }`}
        title="Громкость монтажа"
      >
        {Math.round(master * 100)}%
      </span>
    </div>
  )
}

/** Одна полоска: заливка по уровню плюс метка пика. */
function Channel({ db, peak }: { db: number; peak: number }) {
  const height = share(db)
  const loud = db > -6
  const hot = db > -1
  return (
    <div className="relative min-h-0 w-[9px] overflow-hidden rounded-sm bg-surface-3">
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
