import { sampleAt } from '../lib/scenes'
import type { SceneInfo } from '../lib/types'

/** Больше плиток на одну ленту не рисуем — на сильном приближении их тысячи. */
const MAX_TILES = 1500
/** Сцена уже этого в пикселях не начинает свою плитку — была бы щелью. */
const MIN_SEGMENT = 6

/**
 * Лента кадров по сценам.
 *
 * Каждая сцена начинается своей плиткой ровно там, где на ленте склейка, и
 * первая плитка сцены — её первый кадр. Дальше плитки идут вплотную и
 * показывают кадр своего места; кадр из соседней сцены на чужое место не
 * попадает. Так по ленте видно, где что происходит и где кончается сцена.
 *
 * `from`/`to` — отрезок файла в секундах, который лёг на ширину `width`;
 * `reverse` — клип задом наперёд, файл идёт справа налево.
 */
export function SceneStrip({
  info,
  from,
  to,
  width,
  height,
  reverse = false,
  className = '',
}: {
  info: SceneInfo
  from: number
  to: number
  width: number
  height: number
  reverse?: boolean
  className?: string
}) {
  if (!info.times.length || width <= 0 || height <= 0 || to <= from) return null
  const perSecond = width / (to - from)
  let tile = (height * info.tileWidth) / info.tileHeight
  if (width / tile > MAX_TILES) tile = width / MAX_TILES
  const sourceAt = (x: number) => (reverse ? to - x / perSecond : from + x / perSecond)

  // Где на ленте склейки.
  const edges: number[] = [0]
  const cuts = info.cuts
    .map((index) => info.times[index])
    .filter((at) => at > from && at < to)
    .map((at) => (reverse ? (to - at) * perSecond : (at - from) * perSecond))
    .sort((a, b) => a - b)
  for (const x of cuts) {
    if (x - edges[edges.length - 1] >= MIN_SEGMENT && width - x >= MIN_SEGMENT) edges.push(x)
  }
  edges.push(width)

  const columns = info.columns
  const sheet = `${columns * tile}px ${Math.ceil(info.times.length / columns) * height}px`
  const tiles: { left: number; width: number; index: number }[] = []
  for (let segment = 0; segment < edges.length - 1; segment++) {
    const start = edges[segment]
    const end = edges[segment + 1]
    for (let x = start; x < end; x += tile) {
      // Середина первого пикселя плитки: у задом наперёд левый край
      // сцены — это её конец, и сам край уже принадлежит соседней.
      tiles.push({ left: x, width: Math.min(tile, end - x), index: sampleAt(info, sourceAt(x + 0.5)) })
    }
  }

  return (
    <div className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      {tiles.map((item) => (
        <div
          key={item.left}
          className="absolute top-0 h-full bg-no-repeat"
          style={{
            left: item.left,
            width: item.width,
            backgroundImage: `url(${info.url})`,
            backgroundSize: sheet,
            backgroundPosition: `-${(item.index % columns) * tile}px -${Math.floor(item.index / columns) * height}px`,
          }}
        />
      ))}
      {edges.slice(1, -1).map((x) => (
        <div key={`cut-${x}`} className="absolute top-0 h-full w-px bg-black/70" style={{ left: x }} />
      ))}
    </div>
  )
}
