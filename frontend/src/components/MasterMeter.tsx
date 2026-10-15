import { useEffect, useRef, useState } from 'react'
import { dbToGain, gainToDb, MAX_DB, MIN_DB, volumeLabel } from '../composeStore'

/**
 * Шина громкости: уровень звука в децибелах и громкость всего монтажа.
 *
 * Шкала показывает, насколько громким получится файл, — ради этого такая
 * штука и стоит в монтажных программах. Фейдер меняет громкость всего
 * монтажа и влияет на готовый файл; громкость прослушивания живёт отдельно,
 * на панели под окном просмотра, и на файл не влияет.
 *
 * **Вид задаётся шириной, а не отдельной кнопкой.** Шину тянут за левую
 * границу, и видов у неё два: узкий — одна полоса уровня, средний — полоски
 * двух каналов. Громкость в обоих — одна и та же тонкая черта поверх шкалы. Третий, с
 * делениями отдельной колонкой между каналами, убран: цифры посреди двух
 * шкал читались плохо. Сжатая до упора шина исчезает, оставляя полоску, за
 * которую её возвращают обратно.
 *
 * Подписи делений нарисованы **внутри** шкалы: вынесенные наружу, они
 * занимали ширину, которой у шины и так немного.
 */

/**
 * Отметки шкалы, дБ. Ноль — потолок, ниже -60 уже ничего не разобрать.
 *
 * Сверху деления частые: -3 и -6 — то место, где и настраивают громкость,
 * дальше от потолка точность уже не нужна.
 */
const MARKS = [0, -3, -6, -12, -24, -36, -48]
const FLOOR = -60
/** Сколько держится пиковая отметка, прежде чем поползёт вниз. */
const PEAK_HOLD_MS = 1200

/** Ширина шины: от полоски-ручки до полной раскладки. */
export const METER_MIN = 7
export const METER_MAX = 70
export const METER_DEFAULT = 62
/** Ниже этой ширины показывать нечего — остаётся только ручка. */
const HIDDEN_BELOW = 18
/** С этой ширины рядом с ползунком помещаются полоски каналов. */
const CHANNELS_FROM = 46

/** Доля высоты шкалы для уровня в децибелах. */
function share(db: number): number {
  if (db <= FLOOR) return 0
  return Math.min(1, (db - FLOOR) / -FLOOR)
}

/**
 * Где нарисовать подпись деления.
 *
 * Раньше крайние подписи зажимались внутрь шкалы, и «0» вставал не у самого
 * потолка: над ним оставалась полоса, по которой непонятно было, кончилась
 * шкала или продолжается. Теперь отметка стоит ровно на своём месте, а
 * съезжает сама подпись — у потолка вниз, у пола вверх.
 */
function markPlace(db: number): { top: string; transform: string } {
  const at = 1 - share(db)
  if (share(db) >= 1) return { top: '0%', transform: 'translateY(0)' }
  if (at >= 0.97) return { top: '100%', transform: 'translateY(-100%)' }
  return { top: `${at * 100}%`, transform: 'translateY(-50%)' }
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
  width,
  onWidth,
}: {
  /** Текущий уровень по каналам, дБ. */
  levels: MeterLevels
  /** Громкость всего монтажа, 0..2. Уходит в готовый файл. */
  master: number
  onMaster: (value: number) => void
  /** Идёт ли воспроизведение — по нему гасим пики, когда всё остановлено. */
  active: boolean
  /** Ширина шины в пикселях: её тянут за левую границу. */
  width: number
  onWidth: (value: number) => void
  /** Включено ли выравнивание громкости — его видно прямо на шкале. */
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

  // Тянем за левую границу. Ширина считается от начала перетаскивания, а не
  // от прошлого события: иначе она уползает, когда курсор обгоняет отрисовку.
  const grab = useRef<{ from: number; width: number } | null>(null)
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!grab.current) return
      const next = grab.current.width - (event.clientX - grab.current.from)
      onWidth(Math.round(Math.min(METER_MAX, Math.max(METER_MIN, next))))
    }
    const drop = () => {
      grab.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', drop)
    }
  }, [onWidth])

  /**
   * Фейдер громкости монтажа — тонкая черта поверх шкалы уровня, одна и та
   * же в обоих видах шины. Прежде в широком виде он был отдельным крупным
   * ползунком с яркой подписью и забирал на себя всё внимание.
   */
  const fader = (
    <input
      type="range"
      min={MIN_DB}
      max={MAX_DB}
      step={0.5}
      value={gainToDb(master)}
      onChange={(event) => onMaster(dbToGain(Number(event.target.value)))}
      // Двойное нажатие возвращает обычную громкость: задеть ползунок легко,
      // а понять потом, каким он был, — нет. Второе нажатие перехватываем
      // до того, как ползунок прыгнет под курсор: иначе он успевал встать
      // туда, куда ткнули, и «вернуть 0 дБ» возвращало что попало.
      onMouseDown={(event) => {
        if (event.detail < 2) return
        event.preventDefault()
        onMaster(1)
      }}
      onDoubleClick={() => onMaster(1)}
      title={`Громкость монтажа ${volumeLabel(master)} — уходит в готовый файл.
Двойное нажатие вернёт 0 дБ`}
      className="master-fader over-meter"
    />
  )
  /** Место черты по высоте шкалы — для бледной подписи над ней. */
  const faderTop = `${(1 - (gainToDb(master) - MIN_DB) / (MAX_DB - MIN_DB)) * 100}%`

  // Шина, запомненная шире нынешнего предела, встаёт на предел.
  width = Math.min(width, METER_MAX)
  const shown = width >= HIDDEN_BELOW
  const withChannels = width >= CHANNELS_FROM

  return (
    <div
      className="relative flex shrink-0 flex-col items-center border-l border-line-soft bg-surface py-2"
      style={{ width, paddingLeft: shown ? 6 : 0, paddingRight: shown ? 6 : 0 }}
    >
      {/* Ручка на границе: за неё шину и тянут. */}
      <div
        className="absolute inset-y-0 left-0 z-10 w-[7px] cursor-col-resize hover:bg-accent/30"
        title="Потяните, чтобы сделать шину шире или убрать её"
        onMouseDown={(event) => {
          event.preventDefault()
          grab.current = { from: event.clientX, width }
        }}
        onDoubleClick={() => onWidth(width > HIDDEN_BELOW ? METER_MIN : METER_DEFAULT)}
      />

      {shown && (
        <>
          <div className="flex min-h-0 flex-1 items-stretch gap-1">
            {withChannels ? (
              <div className="relative flex min-h-0 gap-[3px]">
                <Channel db={levels.left} peak={peaks.left} />
                <Channel db={levels.right} peak={peaks.right} />
                <Marks />
                {fader}
                {/* Громкость — еле заметной подписью над чертой: число нужно,
                    но спорить с уровнем за внимание оно не должно. */}
                <span
                  className={`pointer-events-none absolute inset-x-0 text-center font-mono text-[8px] leading-[9px] tabular-nums ${
                    master > 1 ? 'text-warn/80' : 'text-white/45'
                  }`}
                  style={{ top: faderTop, transform: 'translateY(calc(-100% - 3px))' }}
                >
                  {shortLabel(master)}
                </span>
              </div>
            ) : (
              /* Совсем узкая шина: уровень нарисован прямо под ползунком. */
              <div className="relative min-h-0 w-[22px] overflow-hidden rounded-sm bg-surface-3">
                <Fill db={Math.max(levels.left, levels.right)} />
                <Peak db={Math.max(peaks.left, peaks.right)} />
                <Marks />
                {fader}
              </div>
            )}
          </div>

        </>
      )}
    </div>
  )
}

/** Короткая подпись громкости: в узкую колонку длинная не помещается. */
function shortLabel(gain: number): string {
  if (gain <= 0) return '−∞'
  const db = gainToDb(gain)
  return `${db > 0 ? '+' : ''}${Math.round(db)} дБ`
}

/** Подписи делений, нарисованные поверх полосок. */
function Marks() {
  return (
    <div className="pointer-events-none absolute inset-0">
      {MARKS.map((db) => (
        <div
          key={db}
          className="absolute inset-x-0 flex items-center"
          style={markPlace(db)}
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
    <div className="relative min-h-0 w-[14px] overflow-hidden rounded-sm bg-surface-3">
      <Fill db={db} />
      <Peak db={peak} />
    </div>
  )
}
