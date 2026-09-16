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
 *
 * Вид выбирается человеком — места под окном просмотра всем нужно разное:
 *
 * * ``off`` — шины нет вовсе, всё место отдано кадру;
 * * ``fader`` — одна колонка: ползунок громкости, и уровень нарисован прямо
 *   на нём, без отдельных полосок сбоку;
 * * ``meters`` — ползунок, рядом две полоски каналов с делениями на них;
 * * ``vegas`` — как в монтажных программах: ползунок, левый канал, деления
 *   между каналами, правый канал.
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

/** Вид мастер-шины. */
export type MeterView = 'off' | 'fader' | 'meters' | 'vegas'

/** Подписи видов — для переключателя над окном просмотра. */
export const METER_VIEWS: { value: MeterView; label: string }[] = [
  { value: 'off', label: 'Шина: убрать' },
  { value: 'fader', label: 'Шина: ползунок' },
  { value: 'meters', label: 'Шина: со шкалой' },
  { value: 'vegas', label: 'Шина: как в Vegas' },
]

/** Ширина шины под каждый вид. */
const WIDTH: Record<MeterView, number> = { off: 0, fader: 42, meters: 62, vegas: 76 }

export function MasterMeter({
  levels,
  master,
  onMaster,
  active,
  view,
}: {
  /** Текущий уровень по каналам, дБ. */
  levels: MeterLevels
  /** Громкость всего монтажа, 0..2. Уходит в готовый файл. */
  master: number
  onMaster: (value: number) => void
  /** Идёт ли воспроизведение — по нему гасим пики, когда всё остановлено. */
  active: boolean
  /** Какой вид шины выбран. */
  view: MeterView
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

  if (view === 'off') return null

  const fader = (
    <input
      type="range"
      min={0}
      max={200}
      value={Math.round(master * 100)}
      onChange={(event) => onMaster(Number(event.target.value) / 100)}
      title={`Громкость монтажа ${Math.round(master * 100)}% — уходит в готовый файл`}
      className="master-fader"
    />
  )

  return (
    <div
      className="flex shrink-0 flex-col items-center border-l border-line-soft bg-surface px-1.5 py-2"
      style={{ width: WIDTH[view] }}
    >
      <div className="flex min-h-0 flex-1 items-stretch gap-1">
        {view === 'fader' ? (
          /* Всё в одной колонке: уровень нарисован под ползунком, деления
             поверх него. Отдельных полосок сбоку нет — ради этого вид и
             выбирают, когда места под окном просмотра мало. */
          <div className="relative min-h-0 w-[22px] overflow-hidden rounded-sm bg-surface-3">
            <Fill db={Math.max(levels.left, levels.right)} />
            <Peak db={Math.max(peaks.left, peaks.right)} />
            <Marks />
            <input
              type="range"
              min={0}
              max={200}
              value={Math.round(master * 100)}
              onChange={(event) => onMaster(Number(event.target.value) / 100)}
              title={`Громкость монтажа ${Math.round(master * 100)}% — уходит в готовый файл`}
              className="master-fader over-meter"
            />
          </div>
        ) : view === 'vegas' ? (
          /* Как в монтажных программах: ползунок, левый канал, деления между
             каналами, правый канал. */
          <>
            {fader}
            <div className="flex min-h-0 gap-[3px]">
              <Channel db={levels.left} peak={peaks.left} />
              <div className="relative w-[18px]">
                {MARKS.map((db) => (
                  <div
                    key={db}
                    className="absolute inset-x-0 text-center font-mono text-[7.5px] leading-[9px] tabular-nums text-ink-faint"
                    style={{ top: `${(1 - share(db)) * 100}%`, transform: 'translateY(-50%)' }}
                  >
                    {db}
                  </div>
                ))}
              </div>
              <Channel db={levels.right} peak={peaks.right} />
            </div>
          </>
        ) : (
          <>
            {fader}
            {/* Полоски каналов с подписями делений прямо на них */}
            <div className="relative flex min-h-0 gap-[3px]">
              {(['left', 'right'] as const).map((side) => (
                <Channel key={side} db={levels[side]} peak={peaks[side]} />
              ))}
              <Marks />
            </div>
          </>
        )}
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

/** Подписи делений, нарисованные поверх полосок. */
function Marks() {
  return (
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
  )
}

/** Заливка по уровню: зелёная, ближе к потолку — жёлтая и красная. */
function Fill({ db }: { db: number }) {
  return (
    <div
      className={`absolute inset-x-0 bottom-0 transition-[height] duration-75 ${
        db > -1 ? 'bg-danger' : db > -6 ? 'bg-warn' : 'bg-ok'
      }`}
      style={{ height: `${share(db) * 100}%` }}
    />
  )
}

/** Метка недавнего пика. */
function Peak({ db }: { db: number }) {
  if (db <= FLOOR) return null
  return (
    <div
      className={`absolute inset-x-0 h-px ${db > -1 ? 'bg-danger' : 'bg-ink-dim'}`}
      style={{ bottom: `${share(db) * 100}%` }}
    />
  )
}

/** Одна полоска: заливка по уровню плюс метка пика. */
function Channel({ db, peak }: { db: number; peak: number }) {
  return (
    <div className="relative min-h-0 w-[9px] overflow-hidden rounded-sm bg-surface-3">
      <Fill db={db} />
      <Peak db={peak} />
    </div>
  )
}
