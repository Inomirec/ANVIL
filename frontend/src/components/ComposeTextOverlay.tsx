import { useEffect, useRef, useState } from 'react'
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
      useCompose.getState().updateClip(clip.id, {
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
        className={`min-w-[1ch] whitespace-pre outline-none ${focused ? 'cursor-text' : 'cursor-move'}`}
        style={{
          fontFamily: `"${v.font}", Arial, sans-serif`,
          fontWeight: v.bold ? 700 : 400,
          fontStyle: v.italic ? 'italic' : 'normal',
          fontSize: share(v.fontSize),
          lineHeight: 1.35,
          color: v.textColor,
          textAlign: v.align,
          // Обводка у программы ложится снаружи букв. Здесь её рисуют по
          // контуру пополам, поэтому толщину удваиваем и кладём заливку
          // поверх: снаружи остаётся ровно столько, сколько задано.
          WebkitTextStroke: stroke ? `${share(v.stroke * 2)} ${v.strokeColor}` : undefined,
          paintOrder: 'stroke fill',
          textShadow: shadow
            ? `${share(v.shadowX)} ${share(v.shadowY)} 0 ${withAlpha(v.shadowColor, v.shadowAlpha)}`
            : undefined,
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
