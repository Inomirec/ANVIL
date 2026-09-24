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
  /** Ползунок, выбор цвета, галочка (1 — включено, 0 — нет) или выбор из нескольких. */
  kind?: 'slider' | 'color' | 'check' | 'choice'
  /** Варианты для выбора из нескольких. */
  options?: { value: string; label: string; hint?: string }[]
  /** Пояснение при наведении. */
  hint?: string
  min?: number
  max?: number
  step?: number
  unit?: string
  default: number | string
  /** Рекомендованные значения — подписи под шкалой. */
  marks?: { value: number; label: string }[]
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
      { key: 'brightness', label: 'Яркость', min: -100, max: 100, default: 0, marks: [{ value: -40, label: 'темнее' }, { value: 0, label: '0' }, { value: 40, label: 'светлее' }] },
      { key: 'contrast', label: 'Контраст', min: -100, max: 100, default: 0, marks: [{ value: -40, label: 'мягче' }, { value: 0, label: '0' }, { value: 30, label: 'сочнее' }] },
      { key: 'saturation', label: 'Насыщенность', min: -100, max: 100, default: 0, marks: [{ value: -60, label: 'бледнее' }, { value: 0, label: '0' }, { value: 40, label: 'ярче' }] },
      { key: 'temperature', label: 'Теплее / холоднее', min: -100, max: 100, default: 0, marks: [{ value: -40, label: 'холоднее' }, { value: 0, label: '0' }, { value: 40, label: 'теплее' }] },
    ],
  },
  {
    type: 'mono',
    name: 'Чёрно-белое',
    target: 'video',
    hint: 'Убрать цвет — целиком или частично',
    params: [{ key: 'strength', label: 'Сила', min: 0, max: 100, unit: '%', default: 100, marks: [{ value: 50, label: 'наполовину' }, { value: 100, label: 'полностью' }] }],
  },
  {
    type: 'blur',
    name: 'Размытие',
    target: 'video',
    hint: 'Размыть весь клип целиком',
    params: [{ key: 'strength', label: 'Сила', min: 1, max: 80, default: 10, marks: [{ value: 5, label: 'чуть' }, { value: 22, label: 'заметно' }, { value: 50, label: 'сильно' }] }],
  },
  {
    type: 'denoise',
    name: 'Шумоподавление',
    target: 'video',
    hint: 'Убрать зерно с тёмной съёмки. Сильное — замыливает мелкие детали',
    params: [{ key: 'strength', label: 'Сила', min: 1, max: 12, step: 0.5, default: 5, marks: [{ value: 2.5, label: 'слабо' }, { value: 5, label: 'обычно' }, { value: 9, label: 'сильно' }] }],
  },
  {
    type: 'pixelate',
    name: 'Пикселизация',
    target: 'video',
    hint: 'Крупные квадраты вместо картинки',
    params: [{ key: 'size', label: 'Размер квадрата', min: 2, max: 80, unit: 'px', default: 30, marks: [{ value: 6, label: 'мелко' }, { value: 30, label: 'обычно' }, { value: 70, label: 'крупно' }] }],
  },
  {
    type: 'chromakey',
    name: 'Хромакей',
    target: 'video',
    hint: 'Сделать прозрачным фон одного цвета — зелёный или синий экран',
    params: [
      { key: 'color', label: 'Цвет фона', kind: 'color', default: '#00ff00' },
      { key: 'similarity', label: 'Насколько похожий цвет убирать', min: 1, max: 60, default: 20, marks: [{ value: 6, label: 'строго' }, { value: 20, label: 'обычно' }, { value: 40, label: 'широко' }] },
      { key: 'blend', label: 'Мягкость края', min: 0, max: 40, default: 5, marks: [{ value: 0, label: 'резко' }, { value: 12, label: 'мягко' }, { value: 30, label: 'размыто' }] },
    ],
  },
  {
    type: 'blurfill',
    name: 'Размытый фон',
    target: 'video',
    hint: 'Вместо чёрных полос по бокам — та же картинка, растянутая и размытая',
    params: [
      { key: 'strength', label: 'Размытие', min: 5, max: 80, default: 32, marks: [{ value: 12, label: 'легко' }, { value: 32, label: 'обычно' }, { value: 60, label: 'сильно' }] },
      { key: 'dim', label: 'Затемнение', min: 0, max: 80, unit: '%', default: 20, marks: [{ value: 0, label: 'нет' }, { value: 20, label: 'обычно' }, { value: 50, label: 'сильно' }] },
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
      {
        key: 'shakiness',
        label: 'Насколько сильно трясёт',
        min: 1,
        max: 10,
        default: 8,
        hint: 'Чем выше, тем резче тряска, которую программа ищет. Меняется долго: ролик изучается заново',
        marks: [{ value: 2, label: 'чуть' }, { value: 5, label: 'средне' }, { value: 8, label: 'обычно' }, { value: 10, label: 'очень' }],
      },
      {
        key: 'smoothing',
        label: 'Плавность',
        min: 3,
        max: 60,
        default: 18,
        hint: 'Сколько кадров сглаживать. Мало — камера двигается как была, только без мелкой дрожи; много — плывёт плавно',
        marks: [{ value: 5, label: 'слабо' }, { value: 18, label: 'обычно' }, { value: 35, label: 'плавно' }, { value: 55, label: 'очень' }],
      },
      {
        key: 'tripod',
        label: 'Как на штативе',
        kind: 'check',
        default: 0,
        hint: 'Камера «замирает» на первом кадре — для съёмки с одного места. Плавность тогда не действует',
      },
      {
        key: 'zoom',
        label: 'Приблизить, чтобы спрятать края',
        kind: 'choice',
        default: 'static',
        options: [
          { value: 'off', label: 'Нет', hint: 'Без приближения: по краям видны чёрные полосы' },
          { value: 'static', label: 'Постоянно', hint: 'Одно приближение на весь ролик — ровно столько, чтобы края не показывались' },
          { value: 'adaptive', label: 'Плавно', hint: 'Приближение подстраивается по ходу ролика: где тряска слабее, кадр шире' },
        ],
      },
      {
        key: 'extraZoom',
        label: 'Приблизить ещё',
        min: 0,
        max: 40,
        unit: '%',
        default: 0,
        hint: 'Дополнительно к приближению выше — если по краям всё ещё что-то видно',
        marks: [{ value: 0, label: 'нет' }, { value: 5, label: '+5%' }, { value: 15, label: '+15%' }],
      },
      {
        key: 'maxAngle',
        label: 'Предел наклона',
        min: 0,
        max: 15,
        step: 0.5,
        unit: '°',
        default: 3,
        hint: 'Насколько можно наклонять кадр, выравнивая его. Если картинку «водит» и гнёт — уменьшите',
        marks: [{ value: 0, label: 'не наклонять' }, { value: 3, label: 'обычно' }, { value: 15, label: 'без предела' }],
      },
      {
        key: 'keepEdges',
        label: 'Заполнять края прошлыми кадрами',
        kind: 'check',
        default: 0,
        hint: 'Вместо чёрного по краям — кусок предыдущих кадров. Бывает незаметнее, бывает смазывается',
      },
    ],
  },
  {
    type: 'voice_denoise',
    name: 'Шумоподавление голоса',
    target: 'audio',
    hint: 'Убрать гул и шипение из записи с микрофона',
    params: [{ key: 'strength', label: 'Сила', min: 1, max: 40, unit: 'дБ', default: 15, marks: [{ value: 5, label: 'слабо' }, { value: 15, label: 'обычно' }, { value: 30, label: 'сильно' }] }],
  },
  {
    type: 'leveler',
    name: 'Выравнивание громкости',
    target: 'audio',
    hint: 'Тихие места громче, громкие тише — внутри этого клипа',
    params: [{ key: 'strength', label: 'Насколько подтягивать тихое', min: 1, max: 30, default: 12, marks: [{ value: 4, label: 'слегка' }, { value: 12, label: 'обычно' }, { value: 22, label: 'сильно' }] }],
  },
  {
    type: 'echo',
    name: 'Эхо',
    target: 'audio',
    hint: 'Повтор звука с задержкой',
    params: [
      { key: 'delay', label: 'Задержка', min: 20, max: 1500, step: 10, unit: 'мс', default: 300, marks: [{ value: 150, label: 'комната' }, { value: 500, label: 'зал' }, { value: 1100, label: 'горы' }] },
      { key: 'decay', label: 'Громкость повтора', min: 5, max: 90, unit: '%', default: 40, marks: [{ value: 20, label: 'тихо' }, { value: 40, label: 'обычно' }, { value: 70, label: 'громко' }] },
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
