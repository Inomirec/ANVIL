/**
 * Формы появления и ухода — те же формулы, что у сервера (`core/fades.py`).
 *
 * Форма задаётся для появления; уход — её зеркало: «быстрый» уход быстро
 * гаснет в начале. Пустая форма — как было до выбора форм: картинка
 * линейно, звук по четверти синуса.
 */

export type FadeCurve = '' | 'linear' | 'fast' | 'slow' | 'smooth' | 'sharp'

export const FADE_CURVES: { id: Exclude<FadeCurve, ''>; label: string }[] = [
  { id: 'fast', label: 'Быстрая' },
  { id: 'linear', label: 'Линейная' },
  { id: 'slow', label: 'Медленная' },
  { id: 'smooth', label: 'Плавная' },
  { id: 'sharp', label: 'Резкая' },
]

/** Сила появления на доле ``share`` его длины. ``sound`` — для пустой формы звука. */
export function fadeShape(curve: FadeCurve, share: number, sound = false): number {
  const s = Math.min(1, Math.max(0, share))
  switch (curve) {
    case 'fast':
      return 1 - (1 - s) ** 2
    case 'slow':
      return s * s
    case 'smooth':
      return (1 - Math.cos(Math.PI * s)) / 2
    case 'sharp':
      return Math.acos(1 - 2 * s) / Math.PI
    case 'linear':
      return s
    default:
      return sound ? Math.sin((Math.PI / 2) * s) : s
  }
}

/** Видимость при появлении: ``share`` — пройденная доля. */
export function fadeInGain(curve: FadeCurve, share: number, sound = false): number {
  return fadeShape(curve, share, sound)
}

/**
 * Видимость при уходе: ``left`` — оставшаяся доля (1 в начале ухода).
 * Пустая форма звука — четверть синуса и при уходе, как у `afade`.
 */
export function fadeOutGain(curve: FadeCurve, left: number, sound = false): number {
  if (!curve && sound) return Math.sin((Math.PI / 2) * Math.min(1, Math.max(0, left)))
  return 1 - fadeShape(curve, 1 - left, sound)
}

/** Какая форма отмечена в меню: у пустой — та, на которую она похожа. */
export function shownCurve(curve: FadeCurve | undefined, side: 'in' | 'out', sound: boolean): Exclude<FadeCurve, ''> {
  if (curve) return curve
  if (!sound) return 'linear'
  return side === 'in' ? 'fast' : 'slow'
}

/**
 * Затемнённая часть над кривой — `clip-path` для треугольника затухания.
 * Сверху — то, что ещё не видно (или уже не видно), снизу — видимое.
 */
export function fadeClip(curve: FadeCurve | undefined, side: 'in' | 'out', sound = false): string {
  const points: string[] = []
  const steps = 16
  for (let index = 0; index <= steps; index++) {
    const x = index / steps
    const gain = side === 'in' ? fadeInGain(curve ?? '', x, sound) : fadeOutGain(curve ?? '', 1 - x, sound)
    points.push(`${(x * 100).toFixed(2)}% ${((1 - gain) * 100).toFixed(2)}%`)
  }
  // Замыкаем по верхнему краю.
  return `polygon(${points.join(', ')}, 100% 0, 0 0)`
}

/** Линия кривой для значка: точки в квадрате 0…100, сверху — полная сила. */
export function fadeLine(curve: FadeCurve, side: 'in' | 'out'): string {
  const points: string[] = []
  for (let index = 0; index <= 20; index++) {
    const x = index / 20
    const gain = side === 'in' ? fadeInGain(curve, x) : fadeOutGain(curve, 1 - x)
    points.push(`${(x * 100).toFixed(1)},${((1 - gain) * 100).toFixed(1)}`)
  }
  return points.join(' ')
}
