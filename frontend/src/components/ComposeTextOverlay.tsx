import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { TEXT_DEFAULTS, useCompose, type ComposeClip } from '../composeStore'
import { guidesOf, stick, type GridKind } from './ComposeFrameBox'

/**
 * Надпись прямо на экране просмотра: её печатают и двигают на месте.
 *
 * Кадр под иглой собирает программа, и на каждое изменение уходит запрос —
 * пока он идёт, надпись стояла бы на старом месте со старым текстом. Поэтому,
 * пока надпись выделена, программа рисует её сама, обычным текстом поверх
 * кадра, а из собранного кадра её убирает. Так видно каждую букву и каждый
 * сдвиг сразу, а не когда отпустили мышь. Сняли выделение — надпись снова
 * рисует программа, ровно так, как она ляжет в файл.
 *
 * Размеры — в долях высоты кадра через `cqh`: кадр объявлен контейнером, и
 * надпись растёт и сжимается вместе с ним так же, как в готовом файле.
 */

/** Насколько надо сдвинуть мышь, чтобы нажатие стало перетаскиванием. */
const DRAG_START = 3

/** Цвет #rrggbb с прозрачностью — для тени и подложки. */
function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** Место в долях кадра: как у программы, в долях высоты, но через `cqh`. */
const share = (value: number) => `calc(${value} * 100cqh)`

/** Сколько теней кладём по кругу, чтобы из них сложилась обводка. */
const RING = 24

/**
 * Обводка из теней, разложенных по кругу.
 *
 * Обычная обводка текста в браузере строит контур с острыми стыками, и на
 * толстой обводке у острых углов букв торчали пики. Программа же обводит
 * скруглённо. Тени одного цвета, разложенные кольцом на толщину обводки, дают
 * ровно такой скруглённый край — и снаружи букв, как у программы.
 */
function ringStroke(width: number, colour: string): string[] {
  const shadows: string[] = []
  for (let step = 0; step < RING; step += 1) {
    const angle = (step / RING) * Math.PI * 2
    shadows.push(
      `${share(Math.cos(angle) * width)} ${share(Math.sin(angle) * width)} 0 ${colour}`,
    )
  }
  return shadows
}

/** Шрифт, загруженный из того же файла, что берёт сборка. */
interface LoadedFace {
  family: string
  lineHeight: number
}

/** Уже загруженные файлы шрифтов: один файл грузится один раз. */
const faces = new Map<string, Promise<LoadedFace>>()

function loadFace(name: string, bold: boolean, italic: boolean): Promise<LoadedFace> {
  const wanted = `${name}|${bold}|${italic}`
  const known = faces.get(wanted)
  if (known) return known
  const promise = api.fontFace(name, bold, italic).then(async (face) => {
    const family = `sgh-font-${face.key}`
    if (![...document.fonts].some((item) => item.family === family)) {
      const loaded = await new FontFace(family, `url(${face.url})`).load()
      document.fonts.add(loaded)
    }
    return { family, lineHeight: face.lineHeight }
  })
  // Не вышло — забываем, чтобы при следующей попытке спросить заново.
  promise.catch(() => faces.delete(wanted))
  faces.set(wanted, promise)
  return promise
}

/**
 * Файл шрифта для живой надписи.
 *
 * По имени браузер находит не всякий шрифт: «Pribambas-Regular» он не знал и
 * молча рисовал Arial, хотя в файл надпись уходила нужным шрифтом. Поэтому
 * окно берёт тот же файл, что и сборка, и из него же — шаг строк: иначе
 * строки в окне и в файле стояли бы на разной высоте.
 */
function useFace(name: string, bold: boolean, italic: boolean): LoadedFace | null {
  const [face, setFace] = useState<LoadedFace | null>(null)
  useEffect(() => {
    let alive = true
    loadFace(name, bold, italic)
      .then((loaded) => {
        if (alive) setFace(loaded)
      })
      .catch(() => {
        if (alive) setFace(null)
      })
    return () => {
      alive = false
    }
  }, [name, bold, italic])
  return face
}

export function ComposeTextOverlay({ clip, grid }: { clip: ComposeClip; grid: GridKind }) {
  const box = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  // Нажатие по ещё не редактируемой надписи: станет перетаскиванием, если
  // мышь поедет, и началом правки, если отпустят на месте.
  const press = useRef<{
    fromX: number
    fromY: number
    x: number
    y: number
    moving: boolean
  } | null>(null)

  const v = { ...TEXT_DEFAULTS, ...clip }
  const face = useFace(v.font, v.bold, v.italic)

  // Текст в поле ставим сами и только когда он пришёл снаружи: сменили клип,
  // отменили правку. Перезаписывать поле на каждую набранную букву нельзя —
  // курсор прыгал бы в начало строки.
  useEffect(() => {
    const node = field.current
    if (!node) return
    if (document.activeElement === node) return
    if (node.innerText !== v.text) node.innerText = v.text
  }, [clip.id, v.text])

  // Обработчики висят на окне, поэтому клип берут из хранилища сами: иначе
  // они запомнили бы снимок из прошлой отрисовки, и надпись прыгала бы.
  useEffect(() => {
    const move = (event: MouseEvent) => {
      const held = press.current
      const node = box.current
      const frame = node?.parentElement
      if (!held || !node || !frame) return
      if (!held.moving) {
        const far = Math.hypot(event.clientX - held.fromX, event.clientY - held.fromY)
        if (far < DRAG_START) return
        held.moving = true
        useCompose.getState().mark()
      }
      const area = frame.getBoundingClientRect()
      const width = node.offsetWidth / frame.offsetWidth
      const height = node.offsetHeight / frame.offsetHeight
      const align = v.align
      // Прилипают и края надписи, и её середина — как у картинок.
      const across =
        align === 'left'
          ? [held.x, held.x + width / 2, held.x + width]
          : align === 'right'
            ? [held.x - width, held.x - width / 2, held.x]
            : [held.x - width / 2, held.x, held.x + width / 2]
      const guides = guidesOf(grid)
      const shiftX = stick(across, (event.clientX - held.fromX) / area.width, guides)
      const shiftY = stick(
        [held.y - height / 2, held.y, held.y + height / 2],
        (event.clientY - held.fromY) / area.height,
        guides,
      )
      // Через ключи: у надписи с часиками положения правка ляжет в ключ
      // под иглой.
      useCompose.getState().applyValues(clip.id, {
        x: Math.min(2, Math.max(-1, held.x + shiftX)),
        y: Math.min(2, Math.max(-1, held.y + shiftY)),
      })
    }
    const drop = (event: MouseEvent) => {
      const held = press.current
      press.current = null
      if (!held || held.moving) return
      // Отпустили на месте — значит, хотели писать: ставим курсор туда, куда
      // нажали, а не в начало строки.
      const node = field.current
      if (!node) return
      node.focus()
      const spot = document.caretRangeFromPoint?.(event.clientX, event.clientY)
      if (spot && node.contains(spot.startContainer)) {
        const range = window.getSelection()
        range?.removeAllRanges()
        range?.addRange(spot)
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', drop)
    }
  }, [clip.id, grid, v.align])

  const begin = (event: React.MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    press.current = {
      fromX: event.clientX,
      fromY: event.clientY,
      x: v.x,
      y: v.y,
      moving: false,
    }
  }

  // Выравнивание у программы задаёт, какая точка надписи стоит в x: левый
  // край, середина или правый край. Здесь то же самое.
  const shiftX = v.align === 'left' ? '0%' : v.align === 'right' ? '-100%' : '-50%'

  const stroke = v.strokeOn && v.stroke > 0
  const shadow = v.shadowOn && v.shadowAlpha > 0

  return (
    <div
      ref={box}
      className={`absolute z-10 cursor-move border border-dashed ${
        focused ? 'border-accent' : 'border-accent/70'
      }`}
      style={{
        left: `${v.x * 100}%`,
        top: `${v.y * 100}%`,
        transform: `translate(${shiftX}, -50%)`,
        // Рамка чуть шире букв: за неё надпись и таскают, когда в неё уже
        // пишут и нажатие внутри ставит курсор.
        padding: 5,
      }}
      title="Потяните за рамку, чтобы подвинуть. Нажмите на текст, чтобы писать"
      onMouseDown={(event) => {
        if (event.target === box.current) begin(event)
      }}
    >
      <div
        ref={field}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck={false}
        className={`min-w-[1ch] select-text whitespace-pre outline-none ${focused ? 'cursor-text' : 'cursor-move'}`}
        style={{
          // Пока файл шрифта не пришёл — по имени, как получится. Пришёл —
          // ровно им. Жирность и наклон тогда уже в самом файле: добавлять их
          // поверх значило бы нарисовать жирнее, чем в готовом видео.
          fontFamily: face ? `"${face.family}"` : `"${v.font}", Arial, sans-serif`,
          fontWeight: face ? 400 : v.bold ? 700 : 400,
          fontStyle: face ? 'normal' : v.italic ? 'italic' : 'normal',
          fontSize: share(v.fontSize),
          lineHeight: face?.lineHeight ?? 1.2,
          color: v.textColor,
          textAlign: v.align,
          // Обводка и тень — одним списком теней: сначала кольцо обводки,
          // под ним тень. Порядок важен, первая в списке лежит сверху.
          textShadow:
            [
              ...(stroke ? ringStroke(v.stroke, v.strokeColor) : []),
              ...(shadow
                ? [`${share(v.shadowX)} ${share(v.shadowY)} 0 ${withAlpha(v.shadowColor, v.shadowAlpha)}`]
                : []),
            ].join(', ') || undefined,
          background: v.box ? withAlpha(v.boxColor, v.boxAlpha) : undefined,
          padding: v.box ? share(v.boxPad) : undefined,
        }}
        onMouseDown={(event) => {
          // В редактируемой надписи нажатие ставит курсор и выделяет слова,
          // а в ещё не редактируемой — может оказаться перетаскиванием.
          if (!focused) begin(event)
        }}
        onFocus={() => {
          setFocused(true)
          // Весь сеанс набора — одно действие: Ctrl+Z после него вернёт
          // надпись целиком, а не по букве.
          useCompose.getState().mark()
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') (event.target as HTMLElement).blur()
        }}
        onInput={(event) => {
          const text = (event.currentTarget as HTMLDivElement).innerText
          useCompose.getState().updateClip(clip.id, {
            text,
            // Подпись на таймлайне — первая строка надписи.
            name: text.split('\n')[0] || 'Текст',
          })
        }}
      />
    </div>
  )
}
