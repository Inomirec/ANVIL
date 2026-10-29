/**
 * Поворот и отражение картинки в редакторе.
 *
 * Правки рисуют на картинке как она есть, а поворачивает и отражает её
 * сервер уже после них (`images._orient_filters`). В окне так же: картинка со
 * всеми правками повёрнута одним CSS-преобразованием, а мышь пересчитывается
 * обратно в пиксели оригинала.
 */
export interface Orient {
  /** По часовой стрелке. */
  rotate: 0 | 90 | 180 | 270
  /** Отражение по горизонтали — после поворота. */
  flipH: boolean
}

export const NO_ORIENT: Orient = { rotate: 0, flipH: false }

/** Повёрнута ли картинка боком: тогда ширина и высота меняются местами. */
export const sideways = (orient: Orient) => orient.rotate === 90 || orient.rotate === 270

/** То же, что сделает сервер: сначала поворот, потом отражение. */
export function orientTransform(orient: Orient): string {
  return `${orient.flipH ? 'scaleX(-1) ' : ''}rotate(${orient.rotate}deg)`
}

/**
 * Точка окна → доли элемента (0..1 по ширине и высоте) у элемента, которого
 * повернули, отразили и увеличили CSS-преобразованием.
 *
 * У поворотов на прямой угол рамка элемента на экране — ровно его повёрнутый
 * прямоугольник, поэтому середина рамки и есть середина элемента, а масштаб
 * виден по её ширине. Остаётся снять отражение и повернуть обратно.
 */
export function clientToShare(
  element: HTMLElement,
  clientX: number,
  clientY: number,
  orient: Orient,
): { u: number; v: number } | null {
  const rect = element.getBoundingClientRect()
  const width = element.offsetWidth
  const height = element.offsetHeight
  if (!rect.width || !width || !height) return null
  const scale = rect.width / (sideways(orient) ? height : width)
  let dx = (clientX - (rect.left + rect.width / 2)) / scale
  const dy = (clientY - (rect.top + rect.height / 2)) / scale
  if (orient.flipH) dx = -dx
  // Обратный поворот. Синус и косинус прямого угла — ровно 0 и ±1: без
  // округления точка уезжала бы на долю пикселя.
  const turn = ((360 - orient.rotate) % 360) / 90
  const cos = [1, 0, -1, 0][turn]
  const sin = [0, 1, 0, -1][turn]
  const x = dx * cos - dy * sin
  const y = dx * sin + dy * cos
  return { u: x / width + 0.5, v: y / height + 0.5 }
}
