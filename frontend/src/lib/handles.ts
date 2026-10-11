import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

/** Сторона ручки на экране, в точках. */
const SIZE = 12

/**
 * Ручки рамок в окне просмотра — одного размера на экране при любом
 * приближении кадра и любом размере рамки.
 *
 * Рамки лежат внутри увеличенного кадра и увеличивались вместе с ним: у
 * мелкой заливки на приближении ручки становились огромными и налезали друг
 * на друга. Поэтому здесь меряем, во сколько раз рамка увеличена на экране,
 * и делим на это размер ручек и подписи.
 *
 * У мелкой рамки ручки внутри не помещаются — они выходят наружу, за её
 * края, и не закрывают того, что тянут. Средние ручки сторон прячутся, если
 * между угловыми им нет места.
 */
export function useHandles(ref: RefObject<HTMLElement | null>) {
  const [fit, setFit] = useState({ scale: 1, w: 1000, h: 1000 })
  // Меряем после каждой отрисовки: рамка меняется и от правки клипа, и от
  // приближения кадра, а о втором ей никто не сообщает.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !element.offsetWidth) return
    const rect = element.getBoundingClientRect()
    const next = { scale: rect.width / element.offsetWidth, w: rect.width, h: rect.height }
    if (
      Math.abs(next.scale - fit.scale) > 1e-3 ||
      Math.abs(next.w - fit.w) > 0.5 ||
      Math.abs(next.h - fit.h) > 0.5
    ) {
      setFit(next)
    }
  })
  const unit = 1 / (fit.scale || 1)
  const outside = fit.w < SIZE * 3.5 || fit.h < SIZE * 3.5
  const inset = 2 * unit
  return {
    /** Во сколько раз точка экрана меньше точки рамки. */
    unit,
    /**
     * Ширина, высота и тёмная обводка ручки. Обводка — тенью: граница тоньше
     * точки округляется вверх и на приближении закрывала бы цвет ручки.
     */
    size: {
      width: SIZE * unit,
      height: SIZE * unit,
      boxShadow: `inset 0 0 0 ${unit}px var(--color-base)`,
    } as CSSProperties,
    /** Обводка точки своей формы маски — тоже в точку экрана. */
    ring: { boxShadow: `inset 0 0 0 ${unit}px var(--color-base)` } as CSSProperties,
    /** Ручки за краями рамки, а не внутри. */
    outside,
    /** Есть ли место средним ручкам верхней и нижней стороны. */
    midX: fit.w >= SIZE * 3,
    /** Есть ли место средним ручкам левой и правой стороны. */
    midY: fit.h >= SIZE * 3,
    /**
     * Где стоит ручка по одной оси: доля стороны (0, 0.5, 1) — место и сдвиг.
     * Внутри — прижата к краю изнутри (или посередине линии, ``centered``),
     * снаружи — вынесена за край.
     */
    along(share: number, centered = false): { pos: string; shift: string } {
      if (share === 0.5 || (centered && !outside)) return { pos: `${share * 100}%`, shift: '-50%' }
      if (share === 0) return { pos: '0%', shift: outside ? `calc(-100% - ${inset}px)` : `${inset}px` }
      if (share === 1) return { pos: '100%', shift: outside ? `${inset}px` : `calc(-100% - ${inset}px)` }
      return { pos: '50%', shift: '-50%' }
    },
    /** Подпись над рамкой — обычного размера, как бы ни был приближен кадр. */
    label: {
      bottom: '100%',
      marginBottom: 5 * unit,
      transform: `scale(${unit})`,
      transformOrigin: 'bottom left',
    } as CSSProperties,
  }
}
