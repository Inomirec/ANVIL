import { useEffect, useRef } from 'react'
import { clampPlace, clipTall, useCompose, type ComposeClip } from '../composeStore'

/**
 * Рамка клипа поверх окна просмотра и сетка под ней.
 *
 * Чтобы поставить картинку в нужное место кадра, её надо взять и перетащить,
 * а не выбирать из готовых положений: девяти кнопок хватало только на углы и
 * середины, а между ними ничего поставить было нельзя.
 *
 * Рамку тянут за середину — клип едет; за уголок — меняется размер; за край —
 * только одна сторона, и клип перестаёт держать свою форму. Двойное нажатие
 * возвращает клип в кадр целиком.
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
    | { kind: 'corner'; frameW: number; frameH: number }
    | { kind: 'edge'; frameW: number; frameH: number; side: 'x' | 'y' }
    | null
  >(null)

  // Рамка повторяет форму самой картинки, а не кадра: по её краям человек и
  // выравнивает. У заливки формы нет — там рамка какая задана.
  const frameW = useCompose((state) => state.width)
  const frameH = useCompose((state) => state.height)
  const tall = clipTall(clip, frameW, frameH)

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

      // Размер считаем по тому, насколько уголок отъехал от середины:
      // расстояние до середины и есть половина стороны рамки.
      const awayX = Math.abs((event.clientX - area.left) / current.frameW - clip.x) * 2
      const awayY = Math.abs((event.clientY - area.top) / current.frameH - clip.y) * 2

      if (current.kind === 'corner') {
        // Уголок тянет обе стороны разом и сохраняет нынешнюю форму рамки.
        const ratio = tall / clip.size
        const size = Math.max(awayX, awayY / (ratio || 1))
        state.updateClip(
          clip.id,
          clampPlace({ size, sizeY: clip.sizeY && clip.sizeY > 0 ? size * ratio : 0 }),
        )
        return
      }

      // Край тянет одну сторону: с этого мгновения у клипа своя форма, и
      // высоту надо хранить отдельно.
      state.updateClip(
        clip.id,
        current.side === 'x'
          ? clampPlace({ size: awayX, sizeY: tall })
          : clampPlace({ sizeY: awayY }),
      )
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
        left: `${at.x * 100}%`,
        top: `${at.y * 100}%`,
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
        left: `${(clip.x - clip.size / 2) * 100}%`,
        top: `${(clip.y - tall / 2) * 100}%`,
        width: `${clip.size * 100}%`,
        height: `${tall * 100}%`,
      }}
      title={`${clip.name}: тяните за середину, уголки меняют размер, края растягивают.
Двойное нажатие вернёт клип в кадр целиком`}
      onDoubleClick={reset}
      onMouseDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        const { frameW, frameH } = frame()
        drag.current = {
          kind: 'move',
          frameW,
          frameH,
          fromX: event.clientX,
          fromY: event.clientY,
          x: clip.x,
          y: clip.y,
          w: clip.size,
          h: tall,
        }
      }}
    >
      {CORNERS.map((corner) =>
        handle(
          corner.id,
          corner,
          (frameW, frameH) => {
            drag.current = { kind: 'corner', frameW, frameH }
          },
          'Тяните — клип станет крупнее или мельче',
        ),
      )}
      {EDGES.map((edge) =>
        handle(
          edge.id,
          edge,
          (frameW, frameH) => {
            drag.current = { kind: 'edge', frameW, frameH, side: edge.side }
          },
          'Тяните — растянется только эта сторона',
        ),
      )}

      <span className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded bg-black/60 px-1.5 font-mono text-[9.5px] leading-[15px] tabular-nums text-white/85">
        {Math.round(clip.size * 100)}
        {Math.abs(tall - clip.size) > 0.005 ? ` × ${Math.round(tall * 100)}` : ''}%
      </span>
    </div>
  )
}
