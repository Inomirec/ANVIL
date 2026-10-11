/**
 * Линия рамки в окне просмотра — одной толщины на экране при любом
 * приближении кадра.
 *
 * Обычная граница увеличивалась вместе с кадром: на сильном приближении она
 * толстела в разы, а ручки, которые встают от её внутреннего края, съезжали
 * внутрь рамки. Тоньше точки граница не бывает — браузер её округляет.
 * Линия SVG тоньше точки бывает и места в рамке не занимает. Растяжку самой
 * картинки снимает `non-scaling-stroke`, а приближение кадра (CSS) — ``unit``:
 * во сколько раз точка экрана меньше точки рамки (`useHandles`).
 */
export function BoxOutline({
  color,
  width = 1,
  dashed = false,
  ellipse = false,
  unit = 1,
}: {
  color: string
  width?: number
  dashed?: boolean
  ellipse?: boolean
  unit?: number
}) {
  const line = {
    fill: 'none',
    stroke: color,
    strokeWidth: width * unit,
    strokeDasharray: dashed ? `${4 * unit} ${3 * unit}` : undefined,
    vectorEffect: 'non-scaling-stroke' as const,
  }
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      {ellipse ? <ellipse cx="50" cy="50" rx="50" ry="50" {...line} /> : <rect x="0" y="0" width="100" height="100" {...line} />}
    </svg>
  )
}
