import { useEffect, useRef } from 'react'
import { useHandles } from '../lib/handles'
import { magnetOn } from '../lib/magnet'
import { moveAxis } from '../lib/moveAxis'
import { shownAt } from '../composeAnim'
import { BoxOutline } from './BoxOutline'
import {
  clampPlace,
  clipRect,
  MIN_SIZE,
  rectToSize,
  useCompose,
  type ComposeClip,
} from '../composeStore'

/**
 * Рамка клипа поверх окна просмотра и сетка под ней.
 *
 * Чтобы поставить картинку в нужное место кадра, её надо взять и перетащить,
 * а не выбирать из готовых положений: девяти кнопок хватало только на углы и
 * середины, а между ними ничего поставить было нельзя.
 *
 * Рамку тянут за середину — клип едет; за уголок — меняется размер.
 * Растягивать по одной стороне можно только заливку: у картинки и ролика
 * форма своя, и тянуть их вбок бессмысленно — они всё равно вписываются в
 * рамку целиком. Двойное нажатие возвращает клип в кадр целиком.
 *
 * Рамка повторяет форму самой картинки, а не кадра: у квадратной картинки в
 * широком кадре она квадратная. Иначе выравнивать было бы не по чему — рамка
 * шире картинки, а по её краю ничего не стоит.
 */

/** Виды сетки. Линии заданы долями кадра. */
export type GridKind = 'none' | 'thirds' | 'halves' | 'quarters' | 'margins'

export const GRIDS: { value: GridKind; label: string; lines: number[] }[] = [
  { value: 'none', label: 'Сетка: нет', lines: [] },
  { value: 'thirds', label: 'Сетка: трети', lines: [1 / 3, 2 / 3] },
  { value: 'halves', label: 'Сетка: пополам', lines: [0.5] },
  { value: 'quarters', label: 'Сетка: четверти', lines: [0.25, 0.5, 0.75] },
  { value: 'margins', label: 'Сетка: поля', lines: [0.06, 0.94] },
]

/**
 * К чему прилипает клип.
 *
 * Края кадра и его середина — всегда: выровнять картинку по краю на глаз
 * невозможно, а промах в пару пикселей на готовом видео видно. Линии сетки
 * добавляются к ним, поэтому сетка — не только разметка для глаза, но и
 * помощь руке.
 */
export function guidesOf(kind: GridKind): number[] {
  const grid = GRIDS.find((item) => item.value === kind)
  return [...new Set([0, 0.5, 1, ...(grid?.lines ?? [])])]
}

/**
 * Видимые края и середины других клипов под иглой — к ним тоже липнет.
 * Края — у видимой части: у обрезанного клипа это края того, что осталось.
 * Надписи не в счёт: их размер знает только окно.
 */
export function clipGuides(skip: string): { x: number[]; y: number[] } {
  const state = useCompose.getState()
  const at = state.playhead
  const x: number[] = []
  const y: number[] = []
  for (const track of state.tracks) {
    if (track.kind !== 'video' || track.muted) continue
    for (const item of track.clips) {
      if (item.id === skip || item.kind === 'text' || at < item.start || at >= item.start + item.duration) continue
      const shown = shownAt(item, at)
      const { w, h } = clipRect(shown, state.width, state.height)
      const cl = shown.cropLeft ?? 0
      const ct = shown.cropTop ?? 0
      const cr = shown.cropRight ?? 0
      const cb = shown.cropBottom ?? 0
      const left = shown.x - w / 2 + w * cl
      const right = shown.x + w / 2 - w * cr
      const top = shown.y - h / 2 + h * ct
      const bottom = shown.y + h / 2 - h * cb
      x.push(left, (left + right) / 2, right)
      y.push(top, (top + bottom) / 2, bottom)
    }
  }
  return { x, y }
}

/** Насколько близко надо подвести, чтобы прилипло. Доля кадра. */
const SNAP = 0.012

/** Двигает значение к ближайшей направляющей, если она рядом. */
export function stick(anchors: number[], shift: number, guides: number[]): number {
  if (!magnetOn()) return shift
  let best = 0
  let closest = SNAP
  for (const anchor of anchors) {
    for (const guide of guides) {
      const away = guide - (anchor + shift)
      if (Math.abs(away) < closest) {
        closest = Math.abs(away)
        best = away
      }
    }
  }
  return shift + best
}

const CORNERS = [
  { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
  { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
  { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
] as const

const EDGES = [
  { id: 'w', x: 0, y: 0.5, cursor: 'ew-resize', side: 'x' },
  { id: 'e', x: 1, y: 0.5, cursor: 'ew-resize', side: 'x' },
  { id: 'n', x: 0.5, y: 0, cursor: 'ns-resize', side: 'y' },
  { id: 's', x: 0.5, y: 1, cursor: 'ns-resize', side: 'y' },
] as const

/** Сетка поверх кадра: и разметка для глаза, и то, к чему клип прилипает. */
export function ComposeGrid({ kind }: { kind: GridKind }) {
  const grid = GRIDS.find((item) => item.value === kind)
  if (!grid || !grid.lines.length) return null
  return (
    <div className="pointer-events-none absolute inset-0">
      {grid.lines.map((at) => (
        <div
          key={`v${at}`}
          className="absolute inset-y-0 w-px bg-white/25"
          style={{ left: `${at * 100}%` }}
        />
      ))}
      {grid.lines.map((at) => (
        <div
          key={`h${at}`}
          className="absolute inset-x-0 h-px bg-white/25"
          style={{ top: `${at * 100}%` }}
        />
      ))}
    </div>
  )
}

export function ComposeFrameBox({ clip, grid }: { clip: ComposeClip; grid: GridKind }) {
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<
    | {
        kind: 'move'
        frameW: number
        frameH: number
        fromX: number
        fromY: number
        x: number
        y: number
        /** Середина видимой части — по ней и прилипает. */
        vx: number
        vy: number
        w: number
        h: number
      }
    /**
     * Тянем за уголок или край. ``anchor`` — противоположная сторона: она
     * остаётся на месте, а двигается только та, за которую взялись. Тянуть
     * обе стороны разом нельзя: тогда нужный размер приходится подбирать
     * вслепую, потому что рамка разъезжается в обе стороны сразу.
     */
    | {
        kind: 'corner'
        frameW: number
        frameH: number
        anchorX: number
        anchorY: number
        ratio: number
      }
    | {
        kind: 'edge'
        frameW: number
        frameH: number
        side: 'x' | 'y'
        anchor: number
      }
    | null
  >(null)

  // Рамка повторяет саму картинку, а не отведённое ей место: у вертикального
  // ролика место втрое выше картинки, и тянуть было бы не за что.
  const frameW = useCompose((state) => state.width)
  const frameH = useCompose((state) => state.height)
  // Вся картинка клипа — в долях кадра…
  const { w: imageW, h: imageH } = clipRect(clip, frameW, frameH)
  // …а рамка идёт по видимой части: у обрезанного клипа выравнивают то, что
  // осталось, и к сетке липнут именно его края, а не края отрезанного.
  const cl = clip.cropLeft ?? 0
  const ct = clip.cropTop ?? 0
  const cr = clip.cropRight ?? 0
  const cb = clip.cropBottom ?? 0
  const keepW = Math.max(0.05, 1 - cl - cr)
  const keepH = Math.max(0.05, 1 - ct - cb)
  const wide = imageW * keepW
  const tall = imageH * keepH
  // Середина видимой части: сдвинута от середины картинки в сторону, где
  // отрезано меньше.
  const middleX = clip.x + (imageW * (cl - cr)) / 2
  const middleY = clip.y + (imageH * (ct - cb)) / 2

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const current = drag.current
      if (!current) return
      const state = useCompose.getState()
      const guides = guidesOf(grid)
      // К сетке и краям кадра — и к соседним клипам, по каждой оси свои.
      const others = clipGuides(clip.id)
      const guidesX = [...guides, ...others.x]
      const guidesY = [...guides, ...others.y]
      const area = box.current?.parentElement?.getBoundingClientRect()
      if (!area) return

      if (current.kind === 'move') {
        // Прилипают и края клипа, и его середина: выравнивают то по краю
        // кадра, то по его центру, и заранее не угадать, что человеку нужно.
        // Замок направления оставляет на месте запертую ось.
        const axis = moveAxis()
        const shiftX = axis === 'y' ? 0 : stick(
          [current.vx - current.w / 2, current.vx, current.vx + current.w / 2],
          (event.clientX - current.fromX) / current.frameW,
          guidesX,
        )
        const shiftY = axis === 'x' ? 0 : stick(
          [current.vy - current.h / 2, current.vy, current.vy + current.h / 2],
          (event.clientY - current.fromY) / current.frameH,
          guidesY,
        )
        state.placeClip(
          clip.id,
          clampPlace({ x: current.x + shiftX, y: current.y + shiftY }),
        )
        return
      }

      // Курсор в долях кадра.
      const atX = (event.clientX - area.left) / current.frameW
      const atY = (event.clientY - area.top) / current.frameH

      if (current.kind === 'corner') {
        // Уголок тянет обе стороны и сохраняет форму рамки. Противоположный
        // уголок при этом стоит на месте. Тянущийся угол прилипает к сетке:
        // попасть в её линию на глаз почти невозможно, а подогнать размер под
        // разметку хочется чаще всего.
        const shape = current.ratio || 1
        const stuckX = atX + stick([atX], 0, guidesX)
        const stuckY = atY + stick([atY], 0, guidesY)
        const w = Math.max(
          MIN_SIZE,
          Math.max(Math.abs(stuckX - current.anchorX), Math.abs(stuckY - current.anchorY) / shape),
        )
        const h = w * shape
        const right = atX >= current.anchorX ? 1 : -1
        const down = atY >= current.anchorY ? 1 : -1
        const free = clip.sizeY && clip.sizeY > 0
        // w и h — видимая часть; вся картинка больше на отрезанное.
        const fullW = w / keepW
        const fullH = h / keepH
        const visibleX = current.anchorX + (right * w) / 2
        const visibleY = current.anchorY + (down * h) / 2
        state.placeClip(
          clip.id,
          clampPlace({
            size: free ? fullW : rectToSize(fullW, fullH),
            sizeY: free ? fullH : 0,
            x: visibleX - (fullW * (cl - cr)) / 2,
            y: visibleY - (fullH * (ct - cb)) / 2,
          }),
        )
        return
      }

      // Край тянет одну сторону: с этого мгновения у клипа своя форма, и
      // высоту надо хранить отдельно. Противоположный край не двигается.
      if (current.side === 'x') {
        const edge = atX + stick([atX], 0, guidesX)
        const size = Math.max(MIN_SIZE, Math.abs(edge - current.anchor))
        const right = edge >= current.anchor ? 1 : -1
        state.placeClip(
          clip.id,
          clampPlace({ size, sizeY: tall, x: current.anchor + (right * size) / 2 }),
        )
      } else {
        const edge = atY + stick([atY], 0, guidesY)
        const sizeY = Math.max(MIN_SIZE, Math.abs(edge - current.anchor))
        const down = edge >= current.anchor ? 1 : -1
        state.placeClip(
          clip.id,
          clampPlace({ sizeY, y: current.anchor + (down * sizeY) / 2 }),
        )
      }
    }
    const drop = () => {
      drag.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', drop)
    }
  }, [clip.id, clip.x, clip.y, clip.size, clip.sizeY, tall, grid, keepW, keepH, cl, cr, ct, cb])

  const frame = () => {
    const area = box.current?.parentElement?.getBoundingClientRect()
    return { frameW: area?.width ?? 1, frameH: area?.height ?? 1 }
  }

  // У анимированного клипа это ложится в ключ под иглой, как и любая правка
  // рамкой: см. ``placeClip``.
  const reset = () => useCompose.getState().resetPlace(clip.id)

  /**
   * Ручки стоят вплотную к углам рамки, но внутри неё.
   *
   * Посаженные ровно на границу, они наполовину уходили за край окна у клипа
   * во весь кадр: чтобы взяться за размер, клип приходилось сначала
   * отодвигать. Поэтому у краёв ручка прижимается внутрь, а на серединах
   * сторон остаётся по центру.
   */
  // Размер ручек — экранный, у мелкой рамки они выходят наружу.
  const fit = useHandles(box)
  const along = fit.along

  const handle = (
    key: string,
    at: { x: number; y: number; cursor: string },
    start: (frameW: number, frameH: number) => void,
    hint: string,
  ) => (
    <div
      key={key}
      className="absolute bg-accent-soft"
      style={{
        ...fit.size,
        left: along(at.x).pos,
        top: along(at.y).pos,
        transform: `translate(${along(at.x).shift}, ${along(at.y).shift})`,
        cursor: at.cursor,
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        reset()
      }}
      onMouseDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        useCompose.getState().mark()
        const { frameW, frameH } = frame()
        start(frameW, frameH)
      }}
    />
  )

  return (
    <div
      ref={box}
      // Без заливки: даже лёгкая пелена цвета программы поверх клипа делала
      // картинку тусклее, пока клип выделен. Хватает пунктирной рамки.
      className="absolute cursor-move"
      style={{
        left: `${(middleX - wide / 2) * 100}%`,
        top: `${(middleY - tall / 2) * 100}%`,
        width: `${wide * 100}%`,
        height: `${tall * 100}%`,
      }}
      onDoubleClick={reset}
      onMouseDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        useCompose.getState().mark()
        const { frameW, frameH } = frame()
        drag.current = {
          kind: 'move',
          frameW,
          frameH,
          fromX: event.clientX,
          fromY: event.clientY,
          x: clip.x,
          y: clip.y,
          vx: middleX,
          vy: middleY,
          w: wide,
          h: tall,
        }
      }}
    >
      {/* Линия рамки — точка экрана при любом приближении, как и ручки. */}
      <BoxOutline color="var(--color-accent-soft)" dashed unit={fit.unit} />
      {CORNERS.map((corner) =>
        handle(
          corner.id,
          corner,
          (frameW, frameH) => {
            drag.current = {
              kind: 'corner',
              frameW,
              frameH,
              // Противоположный уголок: он и остаётся на месте.
              anchorX: middleX + (corner.x === 0 ? wide / 2 : -wide / 2),
              anchorY: middleY + (corner.y === 0 ? tall / 2 : -tall / 2),
              ratio: tall / wide,
            }
          },
          'Тяните — клип станет крупнее или мельче, противоположный угол останется на месте',
        ),
      )}
      {/* Края растягивают только заливку: у неё формы нет, и прямоугольник
          любой формы — это как раз то, зачем её кладут. Картинку и ролик
          растягивать некуда — они всё равно сохраняют свою форму, и уголков
          для размера достаточно. */}
      {clip.kind === 'color' &&
        EDGES.filter((edge) => (edge.x === 0.5 ? fit.midX : fit.midY)).map((edge) =>
        handle(
          edge.id,
          edge,
          (frameW, frameH) => {
            drag.current = {
              kind: 'edge',
              frameW,
              frameH,
              side: edge.side,
              anchor:
                edge.side === 'x'
                  ? clip.x + (edge.x === 0 ? wide / 2 : -wide / 2)
                  : clip.y + (edge.y === 0 ? tall / 2 : -tall / 2),
            }
          },
          'Тяните — двигается только эта сторона, противоположная стоит на месте',
        ),
      )}

      {/* Размер в пикселях, а не в долях кадра: «9 × 15%» человеку ничего не
          говорит, а «192 × 108» он сравнит с чем угодно. */}
      <span style={fit.label}
          className="pointer-events-none absolute left-0 whitespace-nowrap rounded bg-black/60 px-1.5 font-mono text-[9.5px] leading-[15px] tabular-nums text-white/85">
        {Math.round(wide * frameW)} × {Math.round(tall * frameH)}
      </span>
    </div>
  )
}
