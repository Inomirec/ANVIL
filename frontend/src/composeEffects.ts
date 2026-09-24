/**
 * Эффекты клипа: что есть в списке и какие у каждого ползунки.
 *
 * Числа — в шкале, понятной человеку («теплее на 30», «размытие 12»); в
 * числа ffmpeg их переводит сервер (`core/effects.py`). Умолчания здесь и там
 * одни и те же: двойное нажатие по ползунку возвращает к ним.
 *
 * Отражение, поворот и «задом наперёд» сюда не входят: это не настройка, а
 * действие, и живут они в меню по правой кнопке.
 */

export type EffectTarget = 'video' | 'audio'

export interface EffectParam {
  key: string
  label: string
  /** Ползунок, выбор цвета или галочка (1 — включено, 0 — нет). */
  kind?: 'slider' | 'color' | 'check'
  min?: number
  max?: number
  step?: number
  unit?: string
  default: number | string
}

export interface EffectKind {
  type: string
  name: string
  /** К чему применяется: к картинке (видео, фото) или к звуку. */
  target: EffectTarget
  /** Одной строкой — в окне выбора и при наведении. */
  hint: string
  params: EffectParam[]
}

export const EFFECTS: EffectKind[] = [
  {
    type: 'color',
    name: 'Цветокоррекция',
    target: 'video',
    hint: 'Яркость, контраст, насыщенность и теплота цвета',
    params: [
      { key: 'brightness', label: 'Яркость', min: -100, max: 100, default: 0 },
      { key: 'contrast', label: 'Контраст', min: -100, max: 100, default: 0 },
      { key: 'saturation', label: 'Насыщенность', min: -100, max: 100, default: 0 },
      { key: 'temperature', label: 'Теплее / холоднее', min: -100, max: 100, default: 0 },
    ],
  },
  {
    type: 'mono',
    name: 'Чёрно-белое',
    target: 'video',
    hint: 'Убрать цвет — целиком или частично',
    params: [{ key: 'strength', label: 'Сила', min: 0, max: 100, unit: '%', default: 100 }],
  },
  {
    type: 'blur',
    name: 'Размытие',
    target: 'video',
    hint: 'Размыть весь клип целиком',
    params: [{ key: 'strength', label: 'Сила', min: 1, max: 80, default: 10 }],
  },
  {
    type: 'denoise',
    name: 'Шумоподавление',
    target: 'video',
    hint: 'Убрать зерно с тёмной съёмки. Сильное — замыливает мелкие детали',
    params: [{ key: 'strength', label: 'Сила', min: 1, max: 12, step: 0.5, default: 4 }],
  },
  {
    type: 'pixelate',
    name: 'Пикселизация',
    target: 'video',
    hint: 'Крупные квадраты вместо картинки',
    params: [{ key: 'size', label: 'Размер квадрата', min: 2, max: 120, unit: 'px', default: 16 }],
  },
  {
    type: 'chromakey',
    name: 'Хромакей',
    target: 'video',
    hint: 'Сделать прозрачным фон одного цвета — зелёный или синий экран',
    params: [
      { key: 'color', label: 'Цвет фона', kind: 'color', default: '#00ff00' },
      { key: 'similarity', label: 'Насколько похожий цвет убирать', min: 1, max: 60, default: 15 },
      { key: 'blend', label: 'Мягкость края', min: 0, max: 40, default: 5 },
    ],
  },
  {
    type: 'blurfill',
    name: 'Размытый фон',
    target: 'video',
    hint: 'Вместо чёрных полос по бокам — та же картинка, растянутая и размытая',
    params: [
      { key: 'strength', label: 'Размытие', min: 5, max: 80, default: 30 },
      { key: 'dim', label: 'Затемнение', min: 0, max: 80, unit: '%', default: 20 },
    ],
  },
  {
    type: 'delogo',
    name: 'Убрать водяной знак',
    target: 'video',
    hint: 'Закрасить прямоугольник цветом от его краёв. Лучше всего выходит на спокойном фоне',
    params: [
      { key: 'show', label: 'Показать область рамкой (только в окне просмотра)', kind: 'check', default: 1 },
      { key: 'left', label: 'Слева', min: 0, max: 100, step: 0.5, unit: '%', default: 75 },
      { key: 'top', label: 'Сверху', min: 0, max: 100, step: 0.5, unit: '%', default: 5 },
      { key: 'width', label: 'Ширина', min: 1, max: 100, step: 0.5, unit: '%', default: 20 },
      { key: 'height', label: 'Высота', min: 1, max: 100, step: 0.5, unit: '%', default: 12 },
    ],
  },
  {
    type: 'stabilize',
    name: 'Стабилизатор',
    target: 'video',
    hint: 'Убрать тряску камеры. Ролик один раз обсчитывается в фоне — это занимает время',
    params: [
      { key: 'smoothing', label: 'Плавность', min: 3, max: 60, default: 15 },
      { key: 'crop', label: 'Приблизить, чтобы спрятать края', kind: 'check', default: 1 },
    ],
  },
  {
    type: 'voice_denoise',
    name: 'Шумоподавление голоса',
    target: 'audio',
    hint: 'Убрать гул и шипение из записи с микрофона',
    params: [{ key: 'strength', label: 'Сила', min: 1, max: 40, unit: 'дБ', default: 12 }],
  },
  {
    type: 'leveler',
    name: 'Выравнивание громкости',
    target: 'audio',
    hint: 'Тихие места громче, громкие тише — внутри этого клипа',
    params: [{ key: 'strength', label: 'Насколько подтягивать тихое', min: 1, max: 30, default: 10 }],
  },
  {
    type: 'echo',
    name: 'Эхо',
    target: 'audio',
    hint: 'Повтор звука с задержкой',
    params: [
      { key: 'delay', label: 'Задержка', min: 20, max: 1500, step: 10, unit: 'мс', default: 300 },
      { key: 'decay', label: 'Громкость повтора', min: 5, max: 90, unit: '%', default: 40 },
    ],
  },
]

export function effectKind(type: string): EffectKind | undefined {
  return EFFECTS.find((item) => item.type === type)
}

/** К чему применяются эффекты этого клипа: у звука — звуковые, у остальных — картинка. */
export function targetOf(kind: string): EffectTarget | null {
  if (kind === 'audio') return 'audio'
  if (kind === 'video' || kind === 'image') return 'video'
  return null
}

/** Настройки эффекта по умолчанию. */
export function effectParams(type: string): Record<string, number | string> {
  const kind = effectKind(type)
  return Object.fromEntries((kind?.params ?? []).map((param) => [param.key, param.default]))
}
