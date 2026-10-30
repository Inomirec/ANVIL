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
  /**
   * Ползунок, выбор цвета, галочка (1 — включено, 0 — нет), выбор из
   * нескольких или файл на диске (путь строкой).
   */
  kind?: 'slider' | 'color' | 'check' | 'choice' | 'file'
  /** Видна, только когда у другой настройки такое значение. */
  showIf?: { key: string; value: string }
  /** Какие файлы предлагать в окне выбора: «LUT (*.cube)». */
  fileTypes?: string[]
  /** Варианты для выбора из нескольких. */
  options?: { value: string; label: string; hint?: string }[]
  /** Пояснение при наведении. */
  hint?: string
  min?: number
  max?: number
  step?: number
  unit?: string
  default: number | string
  /**
   * Рекомендованные значения — подписи под шкалой. Буквами, как в ручных
   * настройках (L/M/H, S/M/L, X — нет), слово — в подсказке: словами
   * подписи шли лесенкой в два ряда и занимали вдвое больше места.
   */
  marks?: { value: number; label: string; hint?: string }[]
  /** Может меняться по ключам — рядом с ползунком часики. Тот же список на
   *  сервере (``ANIMATABLE`` в ``core/effects.py``). */
  animatable?: boolean
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
      { animatable: true, key: 'brightness', label: 'Яркость', min: -100, max: 100, default: 0, marks: [{ value: -40, label: 'L', hint: 'темнее' }, { value: 0, label: 'X', hint: 'как есть' }, { value: 40, label: 'H', hint: 'светлее' }] },
      { animatable: true, key: 'contrast', label: 'Контраст', min: -100, max: 100, default: 0, marks: [{ value: -40, label: 'L', hint: 'мягче' }, { value: 0, label: 'X', hint: 'как есть' }, { value: 30, label: 'H', hint: 'сочнее' }] },
      { animatable: true, key: 'saturation', label: 'Насыщенность', min: -100, max: 100, default: 0, marks: [{ value: -60, label: 'L', hint: 'бледнее' }, { value: 0, label: 'X', hint: 'как есть' }, { value: 40, label: 'H', hint: 'ярче' }] },
      { animatable: true, key: 'temperature', label: 'Теплее / холоднее', min: -100, max: 100, default: 0, marks: [{ value: -40, label: 'L', hint: 'холоднее' }, { value: 0, label: 'X', hint: 'как есть' }, { value: 40, label: 'H', hint: 'теплее' }] },
    ],
  },
  {
    type: 'lut',
    name: 'LUT (цветовой образ)',
    target: 'video',
    hint: 'Готовый цветокор одним махом: тёплый, холодный, «кино» — или свой файл .cube',
    params: [
      {
        key: 'look',
        label: 'Образ',
        kind: 'choice',
        default: 'warm',
        options: [
          { value: 'warm', label: 'Тёплый', hint: 'Чуть желтее и уютнее' },
          { value: 'cold', label: 'Холодный', hint: 'Синеватый, строгий' },
          { value: 'cinema', label: 'Кино', hint: 'Тени в бирюзу, света в оранжевый' },
          { value: 'faded', label: 'Плёнка', hint: 'Приподнятые тени, приглушённый цвет' },
          { value: 'vivid', label: 'Сочный', hint: 'Ярче цвет и чуть больше контраста' },
          { value: 'noir', label: 'Нуар', hint: 'Контрастное чёрно-белое' },
          { value: 'file', label: 'Свой файл', hint: 'LUT в формате .cube — их выкладывают для цветокора' },
        ],
      },
      {
        key: 'file',
        label: 'Файл LUT',
        kind: 'file',
        default: '',
        showIf: { key: 'look', value: 'file' },
        fileTypes: ['LUT (*.cube)'],
        hint: 'Трёхмерный LUT в формате .cube',
      },
      { key: 'strength', label: 'Сила', min: 0, max: 100, unit: '%', default: 100, marks: [{ value: 50, label: 'M', hint: 'наполовину' }, { value: 100, label: 'H', hint: 'полностью' }] },
    ],
  },
  {
    type: 'mono',
    name: 'Чёрно-белое',
    target: 'video',
    hint: 'Убрать цвет — целиком или частично',
    params: [{ animatable: true, key: 'strength', label: 'Сила', min: 0, max: 100, unit: '%', default: 100, marks: [{ value: 50, label: 'M', hint: 'наполовину' }, { value: 100, label: 'H', hint: 'полностью' }] }],
  },
  {
    type: 'blur',
    name: 'Размытие',
    target: 'video',
    hint: 'Размыть весь клип целиком',
    params: [{ animatable: true, key: 'strength', label: 'Сила', min: 1, max: 80, default: 10, marks: [{ value: 5, label: 'L', hint: 'чуть' }, { value: 22, label: 'M', hint: 'заметно' }, { value: 50, label: 'H', hint: 'сильно' }] }],
  },
  {
    type: 'denoise',
    name: 'Шумоподавление',
    target: 'video',
    hint: 'Убрать зерно с тёмной съёмки. Сильное — замыливает мелкие детали',
    params: [{ key: 'strength', label: 'Сила', min: 1, max: 12, step: 0.5, default: 5, marks: [{ value: 2.5, label: 'L', hint: 'слабо' }, { value: 5, label: 'M', hint: 'обычно' }, { value: 9, label: 'H', hint: 'сильно' }] }],
  },
  {
    type: 'pixelate',
    name: 'Пикселизация',
    target: 'video',
    hint: 'Крупные квадраты вместо картинки',
    params: [{ animatable: true, key: 'size', label: 'Размер квадрата', min: 2, max: 80, unit: 'px', default: 30, marks: [{ value: 6, label: 'S', hint: 'мелко' }, { value: 30, label: 'M', hint: 'обычно' }, { value: 70, label: 'L', hint: 'крупно' }] }],
  },
  {
    type: 'chromakey',
    name: 'Хромакей',
    target: 'video',
    hint: 'Сделать прозрачным фон одного цвета — зелёный или синий экран',
    params: [
      { key: 'color', label: 'Цвет фона', kind: 'color', default: '#00ff00' },
      { key: 'similarity', label: 'Насколько похожий цвет убирать', min: 1, max: 60, default: 20, marks: [{ value: 6, label: 'L', hint: 'строго' }, { value: 20, label: 'M', hint: 'обычно' }, { value: 40, label: 'H', hint: 'широко' }] },
      { key: 'blend', label: 'Мягкость края', min: 0, max: 40, default: 5, marks: [{ value: 0, label: 'X', hint: 'резко' }, { value: 12, label: 'M', hint: 'мягко' }, { value: 30, label: 'H', hint: 'размыто' }] },
    ],
  },
  {
    type: 'blurfill',
    name: 'Размытый фон',
    target: 'video',
    hint: 'Вместо чёрных полос по бокам — та же картинка, растянутая и размытая',
    params: [
      { key: 'strength', label: 'Размытие', min: 5, max: 80, default: 32, marks: [{ value: 12, label: 'L', hint: 'легко' }, { value: 32, label: 'M', hint: 'обычно' }, { value: 60, label: 'H', hint: 'сильно' }] },
      { key: 'dim', label: 'Затемнение', min: 0, max: 80, unit: '%', default: 20, marks: [{ value: 0, label: 'X', hint: 'нет' }, { value: 20, label: 'M', hint: 'обычно' }, { value: 50, label: 'H', hint: 'сильно' }] },
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
        marks: [{ value: 2, label: 'L', hint: 'чуть' }, { value: 5, label: 'M', hint: 'средне' }, { value: 8, label: 'H', hint: 'обычно' }, { value: 10, label: 'H+', hint: 'очень' }],
      },
      {
        key: 'smoothing',
        label: 'Плавность',
        min: 3,
        max: 60,
        default: 18,
        hint: 'Сколько кадров сглаживать. Мало — камера двигается как была, только без мелкой дрожи; много — плывёт плавно',
        marks: [{ value: 5, label: 'L', hint: 'слабо' }, { value: 18, label: 'M', hint: 'обычно' }, { value: 35, label: 'H', hint: 'плавно' }, { value: 55, label: 'H+', hint: 'очень' }],
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
        marks: [{ value: 0, label: 'X', hint: 'нет' }, { value: 5, label: 'M', hint: '+5%' }, { value: 15, label: 'H', hint: '+15%' }],
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
        marks: [{ value: 0, label: 'X', hint: 'не наклонять' }, { value: 3, label: 'M', hint: 'обычно' }, { value: 15, label: 'H', hint: 'без предела' }],
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
    type: 'gain',
    name: 'Усиление громкости',
    target: 'audio',
    hint: 'Сделать этот клип громче. Шторка на клипе только приглушает, а усиление всей дорожки задевает и остальные клипы на ней',
    params: [{ key: 'db', label: 'Насколько громче', min: 0, max: 20, step: 0.5, unit: 'дБ', default: 6, marks: [{ value: 3, label: 'L', hint: 'чуть' }, { value: 6, label: 'M', hint: 'заметно' }, { value: 12, label: 'H', hint: 'сильно' }] }],
  },
  {
    type: 'voice_denoise',
    name: 'Шумоподавление голоса',
    target: 'audio',
    hint: 'Убрать гул и шипение из записи с микрофона',
    params: [{ key: 'strength', label: 'Сила', min: 1, max: 40, unit: 'дБ', default: 15, marks: [{ value: 5, label: 'L', hint: 'слабо' }, { value: 15, label: 'M', hint: 'обычно' }, { value: 30, label: 'H', hint: 'сильно' }] }],
  },
  {
    type: 'leveler',
    name: 'Выравнивание громкости',
    target: 'audio',
    hint: 'Тихие места громче, громкие тише — внутри этого клипа',
    params: [{ key: 'strength', label: 'Насколько подтягивать тихое', min: 1, max: 30, default: 12, marks: [{ value: 4, label: 'L', hint: 'слегка' }, { value: 12, label: 'M', hint: 'обычно' }, { value: 22, label: 'H', hint: 'сильно' }] }],
  },
  {
    type: 'echo',
    name: 'Эхо',
    target: 'audio',
    hint: 'Повтор звука с задержкой',
    params: [
      { key: 'delay', label: 'Задержка', min: 20, max: 1500, step: 10, unit: 'мс', default: 300, marks: [{ value: 150, label: 'S', hint: 'комната' }, { value: 500, label: 'M', hint: 'зал' }, { value: 1100, label: 'L', hint: 'горы' }] },
      { key: 'decay', label: 'Громкость повтора', min: 5, max: 90, unit: '%', default: 40, marks: [{ value: 20, label: 'L', hint: 'тихо' }, { value: 40, label: 'M', hint: 'обычно' }, { value: 70, label: 'H', hint: 'громко' }] },
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
