import type { DragEvent, MouseEvent } from 'react'

/**
 * Защита окон, где работают мышью, от случайного выделения.
 *
 * Браузер выделяет всё, по чему провели с зажатой кнопкой: подпись, картинку
 * кадра, пустой служебный блок. Выделение почти не видно, а следующее нажатие
 * по нему начинает не правку, а перетаскивание самого выделения — окно
 * перестаёт получать движения мыши, и рамка или маска сдвигается на пиксель
 * вместо того, чтобы ехать за курсором.
 *
 * Поэтому в таких окнах выделения нет вовсе (класс `select-none`), старое
 * снимается при каждом нажатии, а перетаскивание картинок браузером
 * отключено. Поле, в котором печатают, не трогаем: там выделение — это
 * выделение текста.
 */
function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return Boolean(
    element &&
      (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)),
  )
}

export const noStraySelection = {
  className: 'select-none',
  onMouseDownCapture(event: MouseEvent) {
    if (typing(event.target)) return
    window.getSelection()?.removeAllRanges()
  },
  onDragStart(event: DragEvent) {
    if (typing(event.target)) return
    event.preventDefault()
  },
}

/**
 * Ползунки по всей программе. Если на странице уже что-то выделено (двойное
 * нажатие по подписи рядом), нажатие по ползунку браузер принимает за начало
 * перетаскивания этого выделения: ползунок не едет, а курсор становится
 * перечёркнутым кругом. Поэтому перед нажатием на ползунок выделение
 * снимаем, а перетаскивание, начатое с ползунка, отменяем.
 */
export function guardSliders(): void {
  const isSlider = (target: EventTarget | null) =>
    target instanceof HTMLInputElement && target.type === 'range'
  document.addEventListener(
    'mousedown',
    (event) => {
      if (isSlider(event.target)) window.getSelection()?.removeAllRanges()
    },
    true,
  )
  document.addEventListener(
    'dragstart',
    (event) => {
      if (isSlider(event.target)) event.preventDefault()
    },
    true,
  )
}
