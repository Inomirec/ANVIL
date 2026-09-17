import { useEffect, useRef } from 'react'
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
function guidesOf(kind: GridKind): number[] {
  const grid = GRIDS.find((item) => item.value === kind)
  return [...new Set([0, 0.5, 1, ...(grid?.lines ?? [])])]
}

/** Насколько близко надо подвести, чтобы прилипло. Доля кадра. */
const SNAP = 0.012

/** Двигает значение к ближайшей направляющей, если она рядом. */
function stick(anchors: number[], shift: number, guides: number[]): number {
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
  const { w: wide, h: tall } = clipRect(clip, frameW, frameH)

  useEffect(() => {
    const move = (event: MouseEvent) => {
      const current = drag.current
      if (!current) return
      const state = useCompose.getState()
      const guides = guidesOf(grid)
      const area = box.current?.parentElement?.getBoundingClientRect()
      if (!area) return

      if (current.kind === 'move') {
        // Прилипают и края клипа, и его середина: выравнивают то по краю
        // кадра, то по его центру, и заранее не угадать, что человеку нужно.
        const shiftX = stick(
          [current.x - current.w / 2, current.x, current.x + current.w / 2],
          (event.clientX - current.fromX) / current.frameW,
          guides,
        )
        const shiftY = stick(
          [current.y - current.h / 2, current.y, current.y + current.h / 2],
          (event.clientY - current.fromY) / current.frameH,
          guides,
        )
        state.updateClip(
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
        const stuckX = atX + stick([atX], 0, guides)
        const stuckY = atY + stick([atY], 0, guides)
        const w = Math.max(
          MIN_SIZE,
          Math.max(Math.abs(stuckX - current.anchorX), Math.abs(stuckY - current.anchorY) / shape),
        )
        const h = w * shape
        const right = atX >= current.anchorX ? 1 : -1
        const down = atY >= current.anchorY ? 1 : -1
        const free = clip.sizeY && clip.sizeY > 0
        state.updateClip(
          clip.id,
          clampPlace({
            size: free ? w : rectToSize(w, h),
            sizeY: free ? h : 0,
            x: current.anchorX + (right * w) / 2,
            y: current.anchorY + (down * h) / 2,
          }),
        )
        return
      }

      // Край тянет одну сторону: с этого мгновения у клипа своя форма, и
      // высоту надо хранить отдельно. Противоположный край не двигается.
      if (current.side === 'x') {
        const edge = atX + stick([atX], 0, guides)
        const size = Math.max(MIN_SIZE, Math.abs(edge - current.anchor))
        const right = edge >= current.anchor ? 1 : -1
        state.updateClip(
          clip.id,
          clampPlace({ size, sizeY: tall, x: current.anchor + (right * size) / 2 }),
        )
      } else {
        const edge = atY + stick([atY], 0, guides)
        const sizeY = Math.max(MIN_SIZE, Math.abs(edge - current.anchor))
        const down = edge >= current.anchor ? 1 : -1
        state.updateClip(
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
  }, [clip.id, clip.x, clip.y, clip.size, clip.sizeY, tall, grid])

  const frame = () => {
    const area = box.current?.parentElement?.getBoundingClientRect()
    return { frameW: area?.width ?? 1, frameH: area?.height ?? 1 }
  }

  const reset = () =>
    useCompose.getState().updateClip(clip.id, { size: 1, sizeY: 0, x: 0.5, y: 0.5 })

  /**
   * Ручки держим внутри окна просмотра.
   *
   * У клипа во весь кадр рамка совпадает с краями окна, и ручки наполовину
   * уходили за него: чтобы взяться за размер, клип приходилось сначала
   * отодвигать. Поэтому место ручки считаем в кадре и прижимаем к его краю.
   */
  const INSET = 0.014
  const place = (share: number, from: number, span: number) => {
    const at = Math.min(1 - INSET, Math.max(INSET, from + share * span))
    return ((at - from) / (span || 1)) * 100
  }

  const handle = (
    key: string,
    at: { x: number; y: number; cursor: string },
    start: (frameW: number, frameH: number) => void,
    hint: string,
  ) => (
    <div
      key={key}
      title={hint}
      className="absolute h-3 w-3 rounded-[2px] border border-base bg-accent-soft"
      style={{
        left: `${place(at.x, clip.x - wide / 2, wide)}%`,
        top: `${place(at.y, clip.y - tall / 2, tall)}%`,
        transform: 'translate(-50%, -50%)',
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
      className="absolute cursor-move rounded-[3px] border border-dashed border-accent-soft/90 bg-accent/5"
      style={{
        left: `${(clip.x - wide / 2) * 100}%`,
        top: `${(clip.y - tall / 2) * 100}%`,
        width: `${wide * 100}%`,
        height: `${tall * 100}%`,
      }}
      title={`${clip.name}: тяните за середину, уголки меняют размер, края растягивают.
Двойное нажатие вернёт клип в кадр целиком`}
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
          w: wide,
          h: tall,
        }
      }}
    >
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
              anchorX: clip.x + (corner.x === 0 ? wide / 2 : -wide / 2),
              anchorY: clip.y + (corner.y === 0 ? tall / 2 : -tall / 2),
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
        EDGES.map((edge) =>
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
      <span className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded bg-black/60 px-1.5 font-mono text-[9.5px] leading-[15px] tabular-nums text-white/85">
        {Math.round(wide * frameW)} × {Math.round(tall * frameH)}
      </span>
    </div>
  )
}
