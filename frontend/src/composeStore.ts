import { create } from 'zustand'
import { effectKind } from './composeEffects'
import {
  CROP_FIELDS,
  groupOf,
  groupValues,
  hasKeys,
  KEY_NEAR,
  MASK_FIELDS,
  rekey,
  shownAt,
  withKey,
  withoutGroup,
  withoutKey,
  withoutPrefix,
  withValues,
  keyTimes,
  POINTS,
  type Anim,
  type AnimKey,
  type AnimValue,
} from './composeAnim'

export { KEY_NEAR, shownAt } from './composeAnim'

/**
 * Состояние вкладки «Монтаж».
 *
 * Отдельное хранилище, а не часть общего: монтаж ничего не знает про
 * медиатеку и очередь, кроме того, что оттуда приходят файлы. Если вкладка
 * не приживётся, её можно убрать целиком, не трогая остальную программу.
 *
 * Время везде в секундах, положение клипа — от начала таймлайна.
 */

export type ClipKind = 'video' | 'image' | 'audio' | 'color' | 'text'

/**
 * Маска клипа: где он виден или где действуют его эффекты.
 *
 * Место — в долях картинки клипа: середина ``x``/``y``, размер ``w``/``h``.
 * ``feather`` — мягкость края, доля меньшей стороны маски.
 */
export interface ClipMask {
  /** Овал, прямоугольник или своя форма — точки ``points``. */
  shape: 'rect' | 'ellipse' | 'custom'
  x: number
  y: number
  w: number
  h: number
  /** Своя форма: точки в долях прямоугольника маски, по порядку обхода. */
  points?: [number, number][]
  feather: number
  /** Что видно: то, что внутри маски, и то, что снаружи. */
  showInside: boolean
  showOutside: boolean
  /** Где действуют эффекты клипа: везде, только внутри или только снаружи. */
  effectsArea: 'all' | 'inside' | 'outside'
  on: boolean
}

/** Эффект клипа: какой, включён ли, свёрнут ли в колонке и его настройки. */
export interface ClipEffect {
  id: string
  type: string
  on: boolean
  /** Свёрнут в правой колонке — видно только название. */
  folded?: boolean
  params: Record<string, number | string>
}

export interface ComposeClip {
  id: string
  /** Путь к файлу на диске. */
  source: string
  /** Имя файла — подпись на клипе. */
  name: string
  kind: ClipKind
  /** Где стоит на таймлайне. */
  start: number
  /** Сколько занимает на таймлайне. */
  duration: number
  /** С какой секунды самого файла берём. */
  sourceIn: number
  /** Длительность файла. У картинок 0 — их можно тянуть сколько угодно. */
  sourceDuration: number
  hasAudio: boolean
  /** Громкость: 1 — как есть, 0 — тишина. */
  volume: number
  /** Плавное появление и уход звука, в секундах. */
  fadeIn: number
  fadeOut: number
  /** Выбросить звук клипа. */
  muted: boolean
  /**
   * Группа. Клипы одной группы двигаются, режутся и удаляются вместе.
   *
   * Ролик со звуком попадает в группу сам: картинка на верхней дорожке и его
   * звук под ней — иначе они разъедутся при первой же правке. Свою группу
   * человек собирает клавишей G, разбирает — U.
   */
  groupId?: string
  /** Эффекты по порядку: цветокоррекция, размытие, шумоподавление голоса… */
  effects?: ClipEffect[]
  /** Отражение по горизонтали и вертикали. */
  flipH?: boolean
  flipV?: boolean
  /** Поворот по часовой стрелке: 0, 90, 180, 270. */
  rotate?: number
  /** Играть задом наперёд. */
  reverse?: boolean
  /** Маска — прямоугольник или овал. */
  mask?: ClipMask | null
  /** Ключи анимации по показателям (см. ``composeAnim.ts``). */
  anim?: Anim
  /** Обрезка — сколько отрезать с каждой стороны, в долях картинки. Отрезанное
   *  прозрачно, оставшееся стоит на своём месте. */
  cropLeft?: number
  cropTop?: number
  cropRight?: number
  cropBottom?: number
  /** Скорость: 2 — вдвое быстрее, 0.5 — вдвое медленнее. Из файла берётся
   *  ``duration * speed`` секунд. */
  speed?: number
  /** Непрозрачность картинки: 1 — как есть, 0 — совсем не видно. */
  opacity: number
  /** Приближение внутри кадра: 1 — вписано целиком. */
  zoom: number
  /**
   * Цвет сплошной заливки — только у клипов вида ``color``. Файла у такого
   * клипа нет: картинку рисует сам ffmpeg. Нужен, чтобы подложить фон под
   * картинки с полями или сделать заставку.
   */
  color?: string
  /**
   * Размер клипа в кадре: 1 — вписан целиком, 0.5 — вчетверо меньше, 2 —
   * вдвое крупнее кадра. Так делают «картинку в картинке» и наезды.
   */
  size: number
  /**
   * Высота клипа в долях кадра, если её задали отдельно от ширины. Ноль —
   * «как ширина»: клип сохраняет свою форму. Нужно, чтобы растянуть заливку
   * полосой или прямоугольником любой формы.
   */
  sizeY?: number
  /**
   * Форма исходника: ширина, делённая на высоту. Ноль — неизвестна. По ней
   * считается высота рамки, когда её не задавали отдельно, — тогда рамка
   * совпадает с самой картинкой.
   */
  ratio?: number
  /**
   * Где стоит середина клипа, в долях кадра: 0.5 — посередине. Значения за
   * пределами 0..1 допустимы: клип можно увести за край частично.
   */
  x: number
  y: number

  /* --- надпись: только у клипов вида text ------------------------------ */
  /** Что написано. Переводы строк сохраняются: субтитры часто в две строки. */
  text?: string
  /** Семейство шрифта, как его зовут в Windows: «Arial», «Segoe UI». */
  font?: string
  bold?: boolean
  italic?: boolean
  /** Высота букв в долях высоты кадра: не зависит от разрешения проекта. */
  fontSize?: number
  textColor?: string
  /** Обводка: включена ли, толщина в долях высоты кадра и цвет. */
  strokeOn?: boolean
  stroke?: number
  strokeColor?: string
  /** Тень: включена ли, сдвиг в долях высоты кадра, цвет и видимость. */
  shadowOn?: boolean
  shadowX?: number
  shadowY?: number
  shadowColor?: string
  shadowAlpha?: number
  /** Подложка под буквами — когда кадр пёстрый и обводки мало. */
  box?: boolean
  boxColor?: string
  boxAlpha?: number
  boxPad?: number
  align?: 'left' | 'center' | 'right'

  /* --- заливка: только у клипов вида color ---------------------------- */
  /** Скругление углов в долях высоты кадра. Рамка и тень — те же поля, что у надписи. */
  radius?: number
}

/**
 * Значения эффектов по умолчанию — в пикселях кадра проекта, как их видит
 * человек. Внутри клипа они хранятся долями высоты кадра, поэтому переводятся
 * по нынешней высоте проекта: «2 px тени» остаются двумя пикселями и в 720p,
 * и в 1080p. Этими же числами ползунки возвращаются на место двойным нажатием.
 */
export const EFFECT_PIXELS = {
  stroke: 2,
  shadowX: 2,
  shadowY: 2,
  boxPad: 8,
  radius: 0,
}

/** Эффекты по умолчанию в долях высоты кадра — для новой надписи и заливки. */
export function effectDefaults(height: number) {
  return {
    stroke: EFFECT_PIXELS.stroke / height,
    shadowX: EFFECT_PIXELS.shadowX / height,
    shadowY: EFFECT_PIXELS.shadowY / height,
    shadowAlpha: 0.75,
    boxPad: EFFECT_PIXELS.boxPad / height,
  }
}

/**
 * Каким рождается текстовый клип: белые буквы, без обводки, тени и подложки.
 *
 * Сами настройки эффектов у них уже заданы: галочка включает эффект сразу в
 * пригодном виде, и крутить ползунки с нуля, чтобы что-то увидеть, не надо.
 */
export const TEXT_DEFAULTS = {
  text: 'Текст',
  font: 'Arial',
  bold: false,
  italic: false,
  fontSize: 0.07,
  textColor: '#ffffff',
  strokeOn: false,
  stroke: 0.004,
  strokeColor: '#000000',
  shadowOn: false,
  shadowX: 0.004,
  shadowY: 0.004,
  shadowColor: '#000000',
  shadowAlpha: 0.75,
  box: false,
  boxColor: '#000000',
  boxAlpha: 0.5,
  boxPad: 0.02,
  align: 'center' as const,
}

export interface ComposeTrack {
  id: string
  kind: 'video' | 'audio'
  clips: ComposeClip[]
  /** Название дорожки. Пустое — значит человек его не задавал. */
  name?: string
  /**
   * Уровень всей дорожки: у звука это громкость, у видео — насколько видно
   * то, что на ней лежит. Умножается на то же самое у каждого клипа.
   */
  level: number
  /** Своя высота дорожки в пикселях; нет — обычная. У каждой своя: звуку
   *  хочется видеть волну подробно, видео — кадры покрупнее. */
  height?: number
}

/**
 * Цвета дорожек.
 *
 * Видеодорожкам — мягкие тёплые, звуковым — холодные: с одного взгляда видно,
 * где что, и дорожки не сливаются в одну кашу, когда их много.
 */
export const VIDEO_COLORS = ['#8b7bd8', '#c97fa8', '#d69a6a', '#7fa86b']
export const AUDIO_COLORS = ['#5f9ea0', '#5f86bd', '#6fa8a0', '#7b8fc4']

/** Цвет дорожки по её месту среди дорожек своего вида. */
export function trackColor(tracks: ComposeTrack[], id: string): string {
  const track = tracks.find((item) => item.id === id)
  if (!track) return VIDEO_COLORS[0]
  const among = tracks.filter((item) => item.kind === track.kind)
  const place = among.findIndex((item) => item.id === id)
  const palette = track.kind === 'audio' ? AUDIO_COLORS : VIDEO_COLORS
  return palette[Math.max(0, place) % palette.length]
}

/** Номер дорожки среди своих: он и подписан слева, как в монтажных программах. */
export function trackNumber(tracks: ComposeTrack[], id: string): number {
  return tracks.findIndex((item) => item.id === id) + 1
}

/** Больше дорожек человеку не нужно, а таймлайн перестаёт помещаться. */
export const MAX_TRACKS = 6

/** Пределы размера клипа в кадре и его места. */
export const MIN_SIZE = 0.05
export const MAX_SIZE = 4
export const MIN_PLACE = -1
export const MAX_PLACE = 2

/**
 * Где на кадре лежит сама картинка клипа — доли кадра.
 *
 * Клипу отведён прямоугольник ``size`` на ``sizeY`` (а если высоту не задавали,
 * то ``size`` на ``size``), и картинка вписывается внутрь, сохраняя свою форму.
 * Рамка в окне просмотра рисуется по самой картинке, а не по отведённому
 * месту: у вертикального ролика место шире картинки втрое, и тянуть было бы
 * не за что.
 */
export function clipRect(
  clip: ComposeClip,
  frameW: number,
  frameH: number,
): { w: number; h: number } {
  const boxW = clip.size
  const boxH = clip.sizeY && clip.sizeY > 0 ? clip.sizeY : clip.size
  // У заливки формы нет — она занимает отведённое место целиком.
  if (!clip.ratio || clip.ratio <= 0 || clip.kind === 'color') return { w: boxW, h: boxH }
  // Вписываем прямоугольник формы ratio в отведённое место.
  const wide = (boxH * frameH * clip.ratio) / frameW
  const w = Math.min(boxW, wide)
  return { w, h: (w * frameW) / clip.ratio / frameH }
}

/**
 * Обратный счёт: какое место отвести, чтобы картинка вышла нужного размера.
 *
 * Картинка касается той стороны отведённого места, которая её и ограничила,
 * поэтому место — это большая из двух сторон.
 */
export function rectToSize(w: number, h: number): number {
  return Math.max(w, h)
}

/** Не даёт увести клип совсем за пределы разумного. */
export function clampPlace(patch: Partial<ComposeClip>): Partial<ComposeClip> {
  const fixed = { ...patch }
  for (const side of ['size', 'sizeY'] as const) {
    if (fixed[side] !== undefined && (fixed[side] as number) > 0) {
      fixed[side] = Math.min(MAX_SIZE, Math.max(MIN_SIZE, fixed[side] as number))
    }
  }
  for (const side of ['x', 'y'] as const) {
    if (fixed[side] !== undefined) {
      fixed[side] = Math.min(MAX_PLACE, Math.max(MIN_PLACE, fixed[side] as number))
    }
  }
  return fixed
}

/**
 * Громкость считается в децибелах, а не в процентах.
 *
 * Проценты годятся для прозрачности, а звук все меряют децибелами: «-6 дБ»
 * говорит человеку куда больше, чем «50%». Внутри громкость по-прежнему
 * множитель (1 — как есть), потому что именно его понимает ffmpeg.
 *
 * Усиливать звук тоже надо — тихую запись иначе не вытянуть, — поэтому потолок
 * поднят до +12 дБ. У самого низа шкалы громкость ровно ноль: это не «очень
 * тихо», а «дорожки в файле не будет вовсе».
 */
export const MAX_DB = 12
export const MIN_DB = -60
export const MAX_GAIN = 4

export function gainToDb(gain: number): number {
  return gain <= 0 ? MIN_DB : Math.max(MIN_DB, 20 * Math.log10(gain))
}

export function dbToGain(db: number): number {
  return db <= MIN_DB ? 0 : Math.pow(10, db / 20)
}

/**
 * Положение на шторке клипа, 0..1: снизу тишина, сверху обычная громкость.
 *
 * Усиливать шторкой нельзя: её тянут на глаз, мимоходом, и случайно поднять
 * громкость выше исходной куда проще, чем заметить это потом. Усиление живёт
 * на дорожке, где у него есть число и подпись.
 */
export function volumeShare(gain: number): number {
  return Math.min(1, Math.max(0, (gainToDb(Math.min(gain, 1)) - MIN_DB) / -MIN_DB))
}

export function shareToVolume(share: number): number {
  const db = MIN_DB + Math.min(1, Math.max(0, share)) * -MIN_DB
  return dbToGain(db)
}

/** Подпись громкости так, как её пишут в монтажных программах. */
export function volumeLabel(gain: number): string {
  if (gain <= 0) return '−∞'
  const db = gainToDb(gain)
  return `${db > 0 ? '+' : ''}${db.toFixed(1).replace('.', ',')} дБ`
}

/** Сколько висит картинка, если не трогать её длину. */
export const DEFAULT_IMAGE_SECONDS = 3
//: Сколько по умолчанию висит надпись — обычная длина субтитра.
export const DEFAULT_TEXT_SECONDS = 3
/** Короче этого клип не тянется — иначе он исчезает под курсором. */
export const MIN_CLIP_SECONDS = 0.2

/**
 * Качество и форма кадра — две разные настройки.
 *
 * Качество (480/720/1080) задаёт **короткую** сторону: «1080p» у вертикального
 * видео означает 1080 в ширину, а не в высоту. Форма задаёт пропорции, а
 * галочка «повернуть» меняет их местами — из 16:9 получается 9:16.
 */
//: Больше трёх вариантов в строку не помещается, а 1440p и 2160p для
//: монтажа почти не нужны: кому надо — задаст размер вручную.
export const FRAME_QUALITY = [480, 720, 1080]

export const FRAME_SHAPES = [
  { value: '16:9', label: '16:9', hint: 'Обычное широкое видео' },
  { value: '4:3', label: '4:3', hint: 'Старое телевидение' },
  { value: '1:1', label: '1:1', hint: 'Квадрат' },
  { value: '2:3', label: '2:3', hint: 'Как фотография' },
]

/** Считает размер кадра из качества, формы и поворота. */
export function frameSize(
  quality: number,
  shape: string,
  turned: boolean,
): { width: number; height: number } {
  const parts = shape.split(':').map(Number)
  let [across, along] = parts.length === 2 && parts.every(Boolean) ? parts : [16, 9]
  if (turned) [across, along] = [along, across]
  // Короткая сторона — это и есть выбранное качество.
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)
  return across >= along
    ? { width: even((quality * across) / along), height: even(quality) }
    : { width: even(quality), height: even((quality * along) / across) }
}

/** Длинная сторона кадра «как у файла» — не больше 4K. */
export const SOURCE_SIZE_LIMIT = 3840

/**
 * Размер кадра под файл: его же ширина и высота, чётные.
 *
 * Фотография с телефона бывает 8000 точек в ширину — собирать такое видео
 * никто не станет, поэтому крупнее 4K уменьшаем, сохраняя форму.
 */
export function sourceFrame(width: number, height: number): { width: number; height: number } {
  const shrink = Math.min(1, SOURCE_SIZE_LIMIT / Math.max(width, height))
  const even = (value: number) => Math.max(16, Math.round((value * shrink) / 2) * 2)
  return { width: even(width), height: even(height) }
}

/**
 * Отрезок сборки по меткам I и O.
 *
 * Метки нужны только готовому файлу: ими выбирают, что в него попадёт. На
 * просмотр они не влияют — играет то, что под иглой. Без меток собирается всё
 * от нуля до конца последнего клипа.
 */
export function renderSpan(state: {
  renderIn: number | null
  renderOut: number | null
  duration: () => number
}): { from: number; to: number } {
  return { from: state.renderIn ?? 0, to: state.renderOut ?? state.duration() }
}

/** Есть ли в отрезке хоть один клип: пустой отрезок дал бы чёрный экран. */
export function hasClipsIn(tracks: ComposeTrack[], from: number, to: number): boolean {
  return tracks.some((track) =>
    track.clips.some((clip) => clip.start < to && clip.start + clip.duration > from),
  )
}

/**
 * Последний размер «Свой».
 *
 * Переключились на 720p и обратно — «Свой» должен вернуть то, что вводили, а
 * не размер только что выбранного набора. Живёт отдельно от проекта: это
 * привычка человека, а не часть монтажа.
 */
const CUSTOM_KEY = 'sgh.composeCustomSize'

function rememberCustom(size: { width: number; height: number }) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(size))
  } catch {
    /* не запомнилось — вернётся размер набора, не беда */
  }
}

function recallCustom(): { width: number; height: number } | null {
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? 'null')
    if (saved && saved.width >= 16 && saved.height >= 16) {
      return { width: Number(saved.width), height: Number(saved.height) }
    }
  } catch {
    /* испорченная запись — как будто её нет */
  }
  return null
}

/** Скорость клипа: у картинок, надписей и заливок её нет. */
export function speedOf(clip: ComposeClip): number {
  return clip.kind === 'video' || clip.kind === 'audio' ? clip.speed ?? 1 : 1
}

/** Пределы скорости — как у сервера. */
/**
 * Самое сильное приближение таймлайна, пикселей на секунду. При 30 кадрах в
 * секунду это полсотни пикселей на кадр — по кадру можно попасть мышью.
 */
export const MAX_SCALE = 1500

/** Маска по умолчанию — посередине, в половину картинки. */
export function newMask(clip: ComposeClip): ClipMask {
  const effects = (clip.effects ?? []).some((effect) => effect.on)
  return {
    shape: 'ellipse',
    x: 0.5,
    y: 0.5,
    w: 0.4,
    h: 0.4,
    points: [],
    feather: 0.15,
    // Есть эффекты — маску, скорее всего, кладут, чтобы размыть или
    // запикселить кусок: видно всё, эффекты — внутри. Нет — чтобы показать
    // только часть картинки.
    showInside: true,
    showOutside: effects,
    effectsArea: effects ? 'inside' : 'all',
    on: true,
  }
}

/** Маска прежних версий: режим и «перевернуть» — в нынешние переключатели. */
function migrateMask(mask: ClipMask | null | undefined): ClipMask | null | undefined {
  if (!mask) return mask
  const old = mask as ClipMask & { mode?: 'show' | 'effects'; invert?: boolean }
  if (old.showInside !== undefined) return { ...mask, points: mask.points ?? [] }
  const effects = old.mode === 'effects'
  return {
    shape: mask.shape,
    x: mask.x,
    y: mask.y,
    w: mask.w,
    h: mask.h,
    points: [],
    feather: mask.feather,
    showInside: effects ? true : !old.invert,
    showOutside: effects ? true : Boolean(old.invert),
    effectsArea: effects ? (old.invert ? 'outside' : 'inside') : 'all',
    on: mask.on,
  }
}

/** Ключи прежних версий — один список на место и размер сразу. */
function migrateKeys(clip: ComposeClip): Anim | undefined {
  const old = (clip as ComposeClip & { keys?: { t: number; x: number; y: number; size: number; sizeY: number }[] }).keys
  if (!old?.length) return clip.anim
  const anim: Anim = { ...(clip.anim ?? {}) }
  for (const field of ['x', 'y', 'size', 'sizeY'] as const) {
    anim[field] = old.map((key) => ({ t: key.t, v: key[field] }))
  }
  return anim
}

/** Обрезан ли клип хоть с одной стороны — хоть в одном ключе. */
export function isCropped(clip: ComposeClip): boolean {
  const cut = (field: string) =>
    ((clip as unknown as Record<string, number>)[field] ?? 0) > 1e-3 ||
    (clip.anim?.[field] ?? []).some((key) => key.v > 1e-3)
  return CROP_FIELDS.some(cut)
}

/** Есть ли у обрезки ключи — тогда крестик убирает и их. */
export function cropFields(): string[] {
  return CROP_FIELDS
}

export const MIN_SPEED = 0.25
export const MAX_SPEED = 4

const STORAGE_KEY = 'sgh.compose'

interface Saved {
  width: number
  height: number
  fps: number
  /** Короткая сторона кадра: 480, 720, 1080… */
  quality: number
  /** Пропорции вида «16:9». */
  shape: string
  /** Повернуть кадр: из 16:9 получится 9:16. */
  turned: boolean
  /** Размер задан вручную — качество и форма тогда не применяются. */
  custom: boolean
  tracks: ComposeTrack[]
  /** Метки отрезка сборки. ``null`` = собрать всё. */
  renderIn: number | null
  renderOut: number | null
  /** Громкость всего монтажа — фейдер мастер-шины. Уходит в готовый файл. */
  masterVolume: number
  /** Выровнять громкость готового файла, как при обычной обработке. */
  loudnorm: boolean
}

interface State extends Saved {
  playhead: number
  /** Выбранные клипы. Несколько — когда обвели рамкой. */
  selected: string[]
  /** Что человек выбрал сам, до того как выделение разошлось по группам. */
  picked: string[]
  /** Растёт, когда кадр надо собрать заново без правки монтажа: например,
   *  досчиталась ровная копия после стабилизатора. */
  refresh: number
  bumpRefresh: () => void
  /** Клип, у которого сейчас двигают маску в окне просмотра, или ``null``. */
  masking: string | null
  setMasking: (id: string | null) => void
  /** Клип, который сейчас обрезают в окне просмотра, или ``null``. */
  cropping: string | null
  setCropping: (id: string | null) => void
  /** Файлы монтажа, которых нет на месте: такие клипы помечены на дорожке. */
  missing: string[]
  setMissing: (paths: string[]) => void
  /** Кадр или просмотр сообщили о пропавших файлах. Новые — повод открыть
   *  окно пропавших снова (`missingAlert` растёт). */
  reportMissing: (paths: string[]) => void
  missingAlert: number
  /** Подставляет новый путь вместо пропавшего во всех клипах с этим файлом. */
  relink: (from: string, to: string) => void
  /** Растёт при каждом открытии проекта: окно просмотра по нему сбрасывает
   *  кадр прежнего проекта и заново проверяет файлы. */
  opened: number
  /** Под каким именем открыт проект — чтобы сохранять поверх него. */
  projectName: string
  setProjectName: (name: string) => void
  /** Пикселей в секунде: масштаб таймлайна. */
  scale: number
  /** Сжатые дорожки: когда их много, а места мало. */
  compact: boolean
  /** Ширина колонки с названиями дорожек. */
  headWidth: number

  setQuality: (quality: number) => void
  setShape: (shape: string) => void
  setTurned: (turned: boolean) => void
  setCustomSize: (width: number, height: number) => void
  useCustom: (custom: boolean) => void
  /** Кадр как у файла: готовым набором, если такой есть, иначе своим. */
  fitToSource: (width: number, height: number) => void
  setFps: (fps: number) => void
  setPlayhead: (at: number) => void
  setScale: (scale: number) => void
  setCompact: (compact: boolean) => void
  /** Запомнить нынешнее состояние перед действием — для отмены. */
  mark: () => void
  /** Вернуть монтаж к тому, что было до последнего действия. */
  undo: () => void
  /** Есть ли что отменять. */
  canUndo: () => boolean
  /** Выделить все клипы монтажа. */
  selectAll: () => void
  setHeadWidth: (width: number) => void
  select: (ids: string[]) => void

  setMasterVolume: (value: number) => void
  setLoudnorm: (value: boolean) => void
  markIn: () => void
  markOut: () => void
  clearMarks: () => void

  /**
   * Поставить клип в кадре. Если у места или размера есть ключи, правка
   * ложится в ключ под иглой — новый или тот, что уже там, — а не в сам клип.
   */
  placeClip: (id: string, patch: Partial<ComposeClip>) => void
  /**
   * Записать значения показателей (``x``, ``cropLeft``, ``mask.w``,
   * ``fx.<id>.<настройка>``). У группы с ключами — в ключ под иглой, у
   * обрезки и маски ключ появляется сам при первой правке.
   */
  applyValues: (id: string, values: Record<string, AnimValue>) => void
  /** Группа, чьи ключи сейчас видны на таймлайне и ставятся кнопками. */
  animFocus: string | null
  setAnimFocus: (group: string | null) => void
  /** Часики группы: включить ключи (первый — под иглой) или выключить. */
  toggleAnim: (id: string, group: string) => void
  /** Поставить ключ группы под иглой с тем, что сейчас в кадре. */
  keyHere: (id: string, group: string) => void
  /** Выбранные ключи на таймлайне: у какого клипа, какой группы, какие времена. */
  selectedKeys: { clipId: string; group: string; times: number[] } | null
  selectKeys: (selection: { clipId: string; group: string; times: number[] } | null) => void
  /** Сдвинуть ключи группы, стоящие в ``times``, на ``delta`` секунд. */
  moveKeys: (id: string, group: string, times: number[], delta: number) => void
  /** Удалить выбранные ключи. */
  deleteKeys: () => void
  /** Скопировать выбранные ключи; вернёт, сколько скопировано. */
  copyKeys: () => number
  hasKeyCopy: () => boolean
  /** Вставить скопированные ключи от иглы в выбранную настройку. */
  pasteKeys: () => boolean
  /** Убрать ключ группы под иглой. */
  unkeyHere: (id: string, group: string) => void
  /** Вернуть клип в исходную позицию: во весь кадр, посередине, без ключей. */
  resetPlace: (id: string) => void
  /** Убрать маску вместе с её ключами. */
  removeMask: (id: string) => void
  /** Убрать обрезку вместе с её ключами. */
  removeCrop: (id: string) => void
  /** Поставить ключ группы под иглой, если ключей у неё ещё нет. */
  ensureKey: (id: string, group: string) => void
  /** Родная половина ролика: картинка для звука и звук для картинки. */
  partnerOf: (clipId: string) => ComposeClip | null
  addEffect: (clipId: string, type: string, params: Record<string, number | string>) => void
  /** Скопировать эффекты клипа (и его половины у ролика); вернёт, сколько. */
  copyEffects: (clipId: string) => number
  hasEffectCopy: () => boolean
  /** Вставить скопированные эффекты в клипы: картинке — картинкины, звуку — звуковые. */
  pasteEffects: (ids: string[]) => void
  updateEffect: (clipId: string, effectId: string, patch: Partial<ClipEffect>) => void
  removeEffect: (clipId: string, effectId: string) => void
  /** Отразить по горизонтали или вертикали. */
  flipClips: (ids: string[], axis: 'h' | 'v') => void
  /** Повернуть на 90° по часовой стрелке. */
  rotateClips: (ids: string[]) => void
  /** Вернуть обычную скорость: отрезок файла тот же, клип снова своей длины. */
  resetSpeed: (id: string) => void
  /** Задом наперёд — и картинку, и родной звук ролика. */
  reverseClips: (ids: string[]) => void
  addClip: (clip: Omit<ComposeClip, 'id'>, trackId?: string) => string
  /** Кладёт заливку под иглу — файла для этого не нужно. */
  addColor: (color: string, trackId?: string, at?: number) => string
  /** Кладёт надпись под иглу: свой инструмент, файла ей не нужно. */
  addText: (trackId?: string, at?: number) => string
  addPair: (video: Omit<ComposeClip, 'id'>, trackId?: string) => string
  updateClip: (id: string, patch: Partial<ComposeClip>) => void
  moveClips: (ids: string[], shift: number) => void
  resizeClip: (id: string, start: number, duration: number, sourceIn: number, speed?: number) => void
  splitAtPlayhead: () => void
  removeClips: (ids: string[]) => void
  addTrack: (kind: 'video' | 'audio') => void
  removeTrack: (id: string) => void
  /** Переставляет дорожку выше или ниже соседней того же вида. */
  moveTrack: (id: string, to: number) => void
  renameTrack: (id: string, name: string) => void
  /** Своя высота дорожки; ``undefined`` — вернуть обычную. */
  setTrackHeight: (id: string, height: number | undefined) => void
  setTrackLevel: (id: string, level: number) => void
  /** Переносит клипы на соседние дорожки: ``delta`` — на сколько вниз. */
  shiftTracks: (ids: string[], delta: number) => void
  /** Разводит клипы, если после переноса где-то сошлись больше двух. */
  settleOverlaps: (ids: string[]) => void
  /** Укорачивает растянутый клип, если он накрыл чужой переход. */
  trimOverlaps: (id: string) => void
  groupClips: (ids: string[]) => void
  ungroupClips: (ids: string[]) => void
  /** Запомнить выбранные клипы, чтобы вставить их копию. */
  copyClips: (ids: string[]) => number
  /** Положить запомненные клипы, начиная от иглы. */
  /** Вставить скопированное: от ``at`` или, если не задано, от иглы. */
  pasteClips: (at?: number) => void
  /** Есть ли что вставлять. */
  hasCopy: () => boolean
  clearAll: () => void

  /** Монтаж целиком — для сохранения в файл. */
  snapshot: () => Saved
  /** Открыть сохранённый монтаж вместо нынешнего. */
  loadProject: (data: unknown) => void

  duration: () => number
  findClip: (id: string | null) => { clip: ComposeClip; track: ComposeTrack } | null
}

/** Пустой монтаж — с него начинается и новый проект, и первый запуск. */
function emptyProject(): Saved {
  return {
    width: 1280,
    height: 720,
    fps: 30,
    quality: 720,
    shape: '16:9',
    turned: false,
    custom: false,
    tracks: [
      { id: 'v1', kind: 'video', clips: [], level: 1 },
      { id: 'a1', kind: 'audio', clips: [], level: 1 },
    ],
    renderIn: null,
    renderOut: null,
    masterVolume: 1,
    loudnorm: false,
  }
}

/**
 * Приводит прочитанный монтаж в порядок.
 *
 * Читаем мы и то, что программа сохранила сама, и файл проекта, который мог
 * быть записан прежней версией, — в обоих случаях каких-то полей может не
 * быть. Недостающее подставляем, а совсем непонятное отдаём пустым монтажом:
 * лучше пустой таймлайн, чем окно, которое не открывается.
 */
function normalize(input: unknown): Saved {
  const empty = emptyProject()
  try {
    const data = input as Saved
    if (!data || !Array.isArray(data.tracks) || !data.tracks.length) return empty
    const tracks = data.tracks.map((track) => ({
      ...track,
      // Дорожки прежних версий не знали про свой уровень.
      level: track.level ?? 1,
      // Клипы из прежних версий не знали про громкость и затухания.
      clips: (track.clips ?? []).map((clip) => ({
        ...clip,
        volume: clip.volume ?? 1,
        fadeIn: clip.fadeIn ?? 0,
        fadeOut: clip.fadeOut ?? 0,
        muted: clip.muted ?? false,
        opacity: clip.opacity ?? 1,
        zoom: clip.zoom ?? 1,
        // Монтажи прежних версий не знали про размер и место в кадре.
        size: clip.size ?? 1,
        x: clip.x ?? 0.5,
        y: clip.y ?? 0.5,
        color: clip.color ?? '#000000',
        sizeY: clip.sizeY ?? 0,
        ratio: clip.ratio ?? 0,
        radius: clip.radius ?? 0,
        effects: clip.effects ?? [],
        // Ключи прежних версий — место и размер одним списком.
        anim: migrateKeys(clip) ?? {},
        keys: undefined,
        mask: migrateMask(clip.mask),
        // Заливкам прежних версий добираем цвета рамки и тени: без них колонка
        // показывала бы одно, а программа рисовала бы другое.
        ...(clip.kind === 'color'
          ? {
              strokeColor: clip.strokeColor ?? '#ffffff',
              shadowColor: clip.shadowColor ?? '#000000',
            }
          : {}),
        // Надписям добираем настройки: проект мог быть записан версией, где
        // текста ещё не было, а без них сборка не знала бы ни шрифта, ни
        // цвета. Клипам других видов эти поля не мешают.
        ...(clip.kind === 'text'
          ? {
              ...TEXT_DEFAULTS,
              ...clip,
              // Включателей у первых надписей не было: эффект считался
              // включённым, если у него была толщина или сдвиг.
              strokeOn: clip.strokeOn ?? (clip.stroke ?? 0) > 0,
              shadowOn:
                clip.shadowOn ?? (Math.abs(clip.shadowX ?? 0) + Math.abs(clip.shadowY ?? 0) > 0),
            }
          : {}),
      })),
    }))
    if (!tracks.some((track) => track.kind === 'audio')) {
      tracks.push({ id: 'a1', kind: 'audio', clips: [], level: 1 })
    }
    return { ...empty, ...data, tracks }
  } catch {
    return empty
  }
}

function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return normalize(raw ? JSON.parse(raw) : null)
  } catch {
    return emptyProject()
  }
}

/** Всё, что составляет монтаж: и для автосохранения, и для файла проекта. */
function toSaved(state: State): Saved {
  const {
    width, height, fps, quality, shape, turned, custom, tracks,
    renderIn, renderOut, masterVolume, loudnorm,
  } = state
  return {
    width, height, fps, quality, shape, turned, custom, tracks,
    renderIn, renderOut, masterVolume, loudnorm,
  }
}

/** Монтаж запоминается сам: закрытое окно не должно стоить часа работы. */
function save(state: State): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSaved(state)))
  } catch {
    // Приватный режим браузера — тогда просто не запомним.
  }
}

/**
 * История правок для отмены.
 *
 * Снимок кладётся **до** действия, а не после каждой перерисовки: во время
 * перетаскивания монтаж меняется десятки раз в секунду, и отменять пришлось бы
 * по пикселю. Поэтому программа сама отмечает начало действия — нажатие мыши,
 * разрез, удаление, — и одно нажатие Ctrl+Z возвращает всё действие целиком.
 */
/**
 * Скопированные клипы: сам клип и дорожка, с которой его сняли.
 *
 * Живёт рядом с историей отмены, а не в состоянии окна: перерисовывать
 * таймлайн из-за копирования незачем, да и переживать перезагрузку страницы
 * буферу обмена не положено.
 */
/** Скопированные ключи: вид настройки и ключи по показателям, время — от первого. */
let keyClipboard: { kind: string; fields: Record<string, AnimKey[]> } | null = null

/** Скопированные эффекты вместе с ключами их настроек. */
let effectClipboard: { effects: ClipEffect[]; keys: Record<string, AnimKey[]> } | null = null

/** Вид настройки эффекта по имени группы: «fx.<id>.strength» → «<тип>.strength». */
function effectOf(group: string): string {
  const [, id, param] = group.split('.')
  for (const track of useCompose.getState().tracks) {
    for (const clip of track.clips) {
      const effect = (clip.effects ?? []).find((item) => item.id === id)
      if (effect) return `fx:${effect.type}.${param}`
    }
  }
  return group
}

let clipboard: { clip: ComposeClip; trackId: string }[] = []

const HISTORY_LIMIT = 60
const history: Saved[] = []

let counter = 0
const nextId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`

/** Клипы дорожки по порядку. */
const ordered = (clips: ComposeClip[]) => [...clips].sort((a, b) => a.start - b.start)

/**
 * Клипы на дорожке могут перекрываться.
 *
 * Первый заход расталкивал соседей, чтобы наложений не было вовсе, — и
 * перетаскивание стало мучением: кусок, который на полсекунды больше щели,
 * расталкивал всё вокруг вместо того, чтобы просто лечь внахлёст. Теперь
 * клип ложится ровно туда, куда его принесли.
 *
 * Кто кого перекрывает, решает время: клип, начинающийся позже, лежит выше.
 * Это же даёт перетекание — у верхнего достаточно потянуть уголок появления,
 * и он проступит сквозь нижний. Звук в месте наложения складывается, как в
 * монтажных программах.
 */

/**
 * Подтягивает звук ролика под его картинку.
 *
 * Ведущий в связке — видеоклип: звук ходит за картинкой, а не наоборот. Без
 * этого они разъезжались, стоило вставить что-нибудь между роликами — на
 * видеодорожке соседи расступались, а их звук оставался на прежнем месте.
 */
function syncLinked(tracks: ComposeTrack[]): ComposeTrack[] {
  const leaders = new Map<string, ComposeClip>()
  for (const track of tracks) {
    if (track.kind !== 'video') continue
    for (const clip of track.clips) {
      if (clip.groupId) leaders.set(clip.groupId, clip)
    }
  }
  if (!leaders.size) return tracks

  return tracks.map((track) => {
    if (track.kind === 'video') return track
    let changed = false
    const clips = track.clips.map((clip) => {
      const lead = clip.groupId ? leaders.get(clip.groupId) : undefined
      // Подтягиваем только родную дорожку ролика — тот же самый файл. В
      // группе, собранной руками, у каждого клипа своё место: музыка не
      // должна прыгать под картинку только потому, что они в одной группе.
      if (!lead || lead.source !== clip.source) return clip
      if (
        lead.start === clip.start &&
        lead.duration === clip.duration &&
        lead.sourceIn === clip.sourceIn &&
        (lead.speed ?? 1) === (clip.speed ?? 1)
      ) {
        return clip
      }
      changed = true
      return {
        ...clip,
        start: lead.start,
        duration: lead.duration,
        sourceIn: lead.sourceIn,
        speed: lead.speed,
      }
    })
    return changed ? { ...track, clips } : track
  })
}

/** Раскладка после любой правки: расталкивание плюс связки. */
function settle(tracks: ComposeTrack[]): ComposeTrack[] {
  return syncLinked(tracks)
}

/**
 * Куда сдвинуть клип, чтобы он не лёг поверх чужого перехода.
 *
 * Занятыми считаются только те куски времени, где **уже** лежат два клипа:
 * один сосед — это переход, и наезжать на него можно. Ищем ближайшее место
 * слева или справа, чтобы клип уехал как можно меньше.
 */
function escapeCrowd(clip: ComposeClip, others: ComposeClip[]): number {
  const busy: { from: number; to: number }[] = []
  for (let i = 0; i < others.length; i++) {
    for (let j = i + 1; j < others.length; j++) {
      const from = Math.max(others[i].start, others[j].start)
      const to = Math.min(
        others[i].start + others[i].duration,
        others[j].start + others[j].duration,
      )
      if (to - from > 1e-6) busy.push({ from, to })
    }
  }
  const fits = (start: number) =>
    !busy.some((zone) => start < zone.to - 1e-6 && start + clip.duration > zone.from + 1e-6)

  if (fits(clip.start)) return 0

  let best: number | null = null
  for (const zone of busy) {
    for (const start of [zone.to, zone.from - clip.duration]) {
      if (start < 0 || !fits(start)) continue
      const delta = start - clip.start
      if (best === null || Math.abs(delta) < Math.abs(best)) best = delta
    }
  }
  return best ?? 0
}

/** Первый кусок времени под клипом, где уже лежат двое. */
function crowdedUnder(
  clip: ComposeClip,
  others: ComposeClip[],
): { from: number; to: number } | null {
  const end = clip.start + clip.duration
  for (let i = 0; i < others.length; i++) {
    for (let j = i + 1; j < others.length; j++) {
      const from = Math.max(others[i].start, others[j].start, clip.start)
      const to = Math.min(
        others[i].start + others[i].duration,
        others[j].start + others[j].duration,
        end,
      )
      if (to - from > 1e-6) return { from, to }
    }
  }
  return null
}

/** Дополняет выбор соседями по группе. */
function withGroups(tracks: ComposeTrack[], ids: string[]): string[] {
  const all = tracks.flatMap((track) => track.clips)
  const links = new Set(
    all.filter((clip) => ids.includes(clip.id)).map((clip) => clip.groupId).filter(Boolean),
  )
  if (!links.size) return ids
  const family = new Set(ids)
  for (const clip of all) {
    if (clip.groupId && links.has(clip.groupId)) family.add(clip.id)
  }
  return [...family]
}

/** Мелкая настройка окна: запоминаем, но в файл проекта не кладём. */
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Приватный режим браузера — тогда просто не запомним.
  }
}

function recall(key: string, fallback: number): number {
  try {
    const saved = Number(localStorage.getItem(key))
    return Number.isFinite(saved) && saved > 0 ? saved : fallback
  } catch {
    return fallback
  }
}

export const useCompose = create<State>((set, get) => ({
  ...loadSaved(),
  playhead: 0,
  selected: [],
  picked: [],
  projectName: '',
  scale: 60,
  compact: (() => {
    try {
      return localStorage.getItem('sgh.composeCompact') === '1'
    } catch {
      return false
    }
  })(),
  headWidth: recall('sgh.composeHead', 150),
  refresh: 0,
  masking: null,
  setMasking: (id) => {
    if (id) {
      const clip = get().findClip(id)?.clip
      const { playhead } = get()
      if (clip && (playhead < clip.start || playhead >= clip.start + clip.duration)) {
        set({ playhead: clip.start + clip.duration / 2 })
      }
    }
    // Двигать маску и обрезать разом нельзя: рамки лежат друг на друге.
    set({ masking: id, ...(id ? { cropping: null, animFocus: 'mask' } : {}) })
    if (id) get().ensureKey(id, 'mask')
  },
  cropping: null,
  setCropping: (id) => {
    if (id) {
      // Рамку обрезки видно, только когда клип под иглой: иначе режешь
      // вслепую. Игла вне клипа — переводим её в его середину.
      const clip = get().findClip(id)?.clip
      const { playhead } = get()
      if (clip && (playhead < clip.start || playhead >= clip.start + clip.duration)) {
        set({ playhead: clip.start + clip.duration / 2 })
      }
    }
    set({ cropping: id, ...(id ? { masking: null, animFocus: 'crop' } : {}) })
    // Нажали «Обрезать» — на таймлайне сразу ключ под иглой. Один ключ —
    // одна обрезка на весь клип; поставят второй в другом месте — обрезка
    // будет меняться между ними.
    if (id) get().ensureKey(id, 'crop')
  },
  bumpRefresh: () => set({ refresh: get().refresh + 1 }),
  missing: [],
  missingAlert: 0,
  opened: 0,

  setQuality(quality) {
    const { shape, turned } = get()
    set({ quality, custom: false, ...frameSize(quality, shape, turned) })
    save(get())
  },

  setShape(shape) {
    const { quality, turned } = get()
    set({ shape, custom: false, ...frameSize(quality, shape, turned) })
    save(get())
  },

  setTurned(turned) {
    const { quality, shape } = get()
    set({ turned, custom: false, ...frameSize(quality, shape, turned) })
    save(get())
  },

  setCustomSize(width, height) {
    // Нечётные размеры кодировщики не принимают.
    const even = (value: number) => Math.max(16, Math.round(value / 2) * 2)
    const size = { width: even(width), height: even(height) }
    set({ ...size, custom: true })
    rememberCustom(size)
    save(get())
  },

  useCustom(custom) {
    if (custom) {
      set({ custom: true, ...(recallCustom() ?? {}) })
    } else {
      const { quality, shape, turned } = get()
      set({ custom: false, ...frameSize(quality, shape, turned) })
    }
    save(get())
  },

  fitToSource(width, height) {
    const wanted = sourceFrame(width, height)
    // Совпал с готовым набором — ставим его: так в настройках кадра
    // подсвечено понятное «1080p, 16:9», а не безликое «Свой».
    for (const quality of FRAME_QUALITY) {
      for (const { value: shape } of FRAME_SHAPES) {
        for (const turned of [false, true]) {
          const size = frameSize(quality, shape, turned)
          if (size.width === wanted.width && size.height === wanted.height) {
            set({ quality, shape, turned, custom: false, ...size })
            save(get())
            return
          }
        }
      }
    }
    set({ ...wanted, custom: true })
    rememberCustom(wanted)
    save(get())
  },

  setFps(fps) {
    set({ fps })
    save(get())
  },

  setPlayhead(at) {
    // Игла стоит на кадре, а не между ними: иначе ключ или разрез ложатся в
    // середину кадра, и попасть в последний кадр сцены нельзя.
    const fps = get().fps || 30
    set({ playhead: Math.max(0, Math.round(at * fps) / fps) })
  },

  setScale(scale) {
    // Нижний предел здесь только страховочный: настоящий считает таймлайн —
    // он знает и длину монтажа, и ширину окна, а хранилище нет.
    set({ scale: Math.min(MAX_SCALE, Math.max(0.05, scale)) })
  },

  // Как человеку удобно смотреть — не часть монтажа, поэтому в файл проекта
  // это не идёт, но между запусками помнить надо.
  setCompact(compact) {
    set({ compact })
    remember('sgh.composeCompact', compact ? '1' : '0')
  },

  setHeadWidth(headWidth) {
    set({ headWidth })
    remember('sgh.composeHead', String(headWidth))
  },

  mark() {
    history.push(toSaved(get()))
    if (history.length > HISTORY_LIMIT) history.shift()
  },

  undo() {
    // Пропускаем снимки, в которых ничего не менялось: отметка ставится по
    // нажатию мыши, а нажать можно и не сдвинув ничего. Иначе первое Ctrl+Z
    // выглядело бы так, будто оно не сработало.
    const now = JSON.stringify(toSaved(get()))
    let was = history.pop()
    while (was && JSON.stringify(was) === now) was = history.pop()
    if (!was) return
    // Игла и выделение не восстанавливаются: клипа, который был выбран, после
    // отмены может и не быть, а игла к правке отношения не имеет.
    set({ ...normalize(was), selected: [] })
    save(get())
  },

  canUndo() {
    return history.length > 0
  },

  setProjectName(name) {
    set({ projectName: name })
  },


  selectAll() {
    set((state) => ({
      selected: state.tracks.flatMap((track) => track.clips).map((clip) => clip.id),
    }))
  },

  select(ids) {
    // Группа — одно целое: взяв один клип, берём и его соседей. Иначе
    // выделенным выглядит только ролик, а его звуковая дорожка — нет, хотя
    // двигаются, режутся и удаляются они вместе.
    //
    // Заодно помним, что человек выбрал сам: без этого после разрыва группы
    // не понять, какой клип брали в руки, а какой приехал за компанию.
    set({ picked: ids, selected: withGroups(get().tracks, ids) })
  },

  // --- метки отрезка сборки ---------------------------------------------
  setLoudnorm(value) {
    set({ loudnorm: value })
    save(get())
  },

  setMasterVolume(value) {
    set({ masterVolume: Math.min(MAX_GAIN, Math.max(0, value)) })
    save(get())
  },

  markIn() {
    const { playhead, renderOut } = get()
    set({
      renderIn: playhead,
      // Метка начала позже конца — конец сбрасываем, иначе отрезок пустой.
      renderOut: renderOut !== null && renderOut <= playhead ? null : renderOut,
    })
    save(get())
  },

  markOut() {
    const { playhead, renderIn } = get()
    set({
      renderOut: playhead,
      renderIn: renderIn !== null && renderIn >= playhead ? null : renderIn,
    })
    save(get())
  },

  clearMarks() {
    set({ renderIn: null, renderOut: null })
    save(get())
  },

  // --- клипы -------------------------------------------------------------
  addClip(clip, trackId) {
    get().mark()
    const id = nextId()
    set((state) => {
      // Звук ложится на звуковую дорожку, картинки и видео — на видеодорожку,
      // даже если бросили мимо: на чужой дорожке клип всё равно не прозвучит
      // и не покажется, а искать причину человек будет долго.
      const wanted = clip.kind === 'audio' ? 'audio' : 'video'
      const asked = state.tracks.find((track) => track.id === trackId)
      const target =
        asked && asked.kind === wanted
          ? asked
          : state.tracks.find((track) => track.kind === wanted) ?? state.tracks[0]
      return {
        tracks: settle(
          state.tracks.map((track) =>
            track.id === target?.id
              ? { ...track, clips: [...track.clips, { ...clip, id }] }
              : track,
          ),
        ),
        selected: [id],
      }
    })
    save(get())
    return id
  },

  /**
   * Кладёт заливку — от неё не нужно ни файла, ни медиатеки.
   *
   * Без дорожки встаёт на нижнюю видеодорожку: заливку чаще всего кладут под
   * остальное. Длина — как у картинки по умолчанию, дальше её тянут.
   */
  addText(trackId, at) {
    const state = get()
    const video = state.tracks.filter((track) => track.kind === 'video')
    const target =
      state.tracks.find((track) => track.id === trackId && track.kind === 'video') ??
      video[video.length - 1]
    // Надпись ложится там же, где стоит игла, и живёт три секунды — обычная
    // длина субтитра. Дальше её тянут за край, как всё остальное.
    return get().addClip(
      {
        source: '',
        name: TEXT_DEFAULTS.text,
        kind: 'text',
        start: Math.round((at ?? state.playhead) * 100) / 100,
        duration: DEFAULT_TEXT_SECONDS,
        sourceIn: 0,
        sourceDuration: 0,
        hasAudio: false,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
        muted: true,
        opacity: 1,
        zoom: 1,
        size: 1,
        sizeY: 0,
        ratio: 0,
        // Надпись рождается посередине кадра: субтитры — лишь один из
        // случаев, а заголовки и подписи ставят куда угодно. Отсюда её
        // видно сразу, куда бы её потом ни понесли.
        x: 0.5,
        y: 0.5,
        ...TEXT_DEFAULTS,
        ...effectDefaults(state.height),
      },
      target?.id,
    )
  },

  addColor(color, trackId, at) {
    const state = get()
    const video = state.tracks.filter((track) => track.kind === 'video')
    const target =
      state.tracks.find((track) => track.id === trackId && track.kind === 'video') ??
      video[video.length - 1]
    return get().addClip(
      {
        source: '',
        name: 'Заливка',
        kind: 'color',
        color,
        start: Math.round((at ?? state.playhead) * 100) / 100,
        duration: DEFAULT_IMAGE_SECONDS,
        sourceIn: 0,
        sourceDuration: 0,
        hasAudio: false,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
        muted: true,
        opacity: 1,
        zoom: 1,
        size: 1,
        sizeY: 0,
        ratio: 0,
        x: 0.5,
        y: 0.5,
        radius: 0,
        strokeOn: false,
        strokeColor: '#ffffff',
        shadowOn: false,
        shadowColor: '#000000',
        ...effectDefaults(state.height),
      },
      target?.id,
    )
  },

  /**
   * Кладёт ролик вместе с его звуком: картинку на видеодорожку, звук —
   * отдельным клипом под ней. Человек видит, что звук есть, и может отдельно
   * убавить его или убрать совсем.
   */
  addPair(video, trackId) {
    get().mark()
    const groupId = nextId()
    const videoId = nextId()
    const audioId = nextId()
    set((state) => {
      const videoTrack =
        state.tracks.find((track) => track.id === trackId && track.kind === 'video') ??
        state.tracks.find((track) => track.kind === 'video')
      const audioTrack = state.tracks.find((track) => track.kind === 'audio')
      const sound: ComposeClip = {
        ...video,
        id: audioId,
        kind: 'audio',
        groupId,
        // Звук ролика живёт в звуковом клипе, поэтому у картинки он выключен —
        // иначе одна и та же дорожка попала бы в сборку дважды.
      }
      return {
        tracks: settle(state.tracks.map((track) => {
          if (track.id === videoTrack?.id) {
            const clip: ComposeClip = { ...video, id: videoId, groupId, muted: true }
            return { ...track, clips: [...track.clips, clip] }
          }
          if (track.id === audioTrack?.id) {
            return { ...track, clips: [...track.clips, sound] }
          }
          return track
        })),
        selected: [videoId],
      }
    })
    save(get())
    return videoId
  },

  updateClip(id, patch) {
    set((state) => ({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => (clip.id === id ? { ...clip, ...patch } : clip)),
      })),
    }))
    save(get())
  },

  /** Двигает выбранные клипы (и связанные с ними) на ``shift`` секунд. */
  moveClips(ids, shift) {
    set((state) => {
      const all = state.tracks.flatMap((track) => track.clips)
      const links = new Set(
        all.filter((clip) => ids.includes(clip.id)).map((clip) => clip.groupId).filter(Boolean),
      )
      const family = all.filter(
        (clip) => ids.includes(clip.id) || (clip.groupId && links.has(clip.groupId)),
      )
      const moving = family.map((clip) => clip.id)

      // У начала таймлайна пачка едет как одно целое: если каждый клип
      // упирается в ноль сам по себе, передние встают, задние продолжают
      // ехать — и разложенное по порядку съезжается в кучу.
      const edge = family.reduce((least, clip) => Math.min(least, clip.start), Infinity)
      const step = Number.isFinite(edge) ? Math.max(shift, -edge) : shift
      if (!step) return state

      return {
        tracks: settle(
          state.tracks.map((track) => {
            const touched = track.clips.some((clip) => moving.includes(clip.id))
            if (!touched) return track
            const shifted = track.clips.map((clip) =>
              moving.includes(clip.id)
                ? { ...clip, start: Math.max(0, clip.start + step) }
                : clip,
            )
            return { ...track, clips: shifted }
          }),
        ),
      }
    })
    save(get())
  },

  resizeClip(id, start, duration, sourceIn, speed) {
    set((state) => {
      const all = state.tracks.flatMap((track) => track.clips)
      const link = all.find((clip) => clip.id === id)?.groupId
      const family = all
        .filter((clip) => clip.id === id || (link && clip.groupId === link))
        .map((clip) => clip.id)

      return {
        tracks: settle(
          state.tracks.map((track) => {
            if (!track.clips.some((clip) => family.includes(clip.id))) return track
            const next = track.clips.map((clip) =>
              family.includes(clip.id)
                ? {
                    ...clip,
                    anim: rekey(clip, {
                      start: Math.max(0, start),
                      sourceIn: Math.max(0, sourceIn),
                      speed: speed ?? clip.speed ?? 1,
                    }),
                    start: Math.max(0, start),
                    duration: Math.max(MIN_CLIP_SECONDS, duration),
                    sourceIn: Math.max(0, sourceIn),
                    // Скорость у картинки и звука ролика одна: иначе губы и
                    // голос разошлись бы с первой же секунды.
                    ...(speed !== undefined && clip.kind !== 'image' ? { speed } : {}),
                  }
                : clip,
            )
            return { ...track, clips: next }
          }),
        ),
      }
    })
    save(get())
  },

  /**
   * Режет клипы под иглой надвое.
   *
   * Это и есть способ убрать кусок из середины ролика: режем дважды и
   * удаляем средний клип. Отдельного инструмента «вырезать» не нужно —
   * в монтажных программах делают ровно так же. Связанные видео и звук
   * режутся вместе, иначе они разъехались бы.
   */
  splitAtPlayhead() {
    get().mark()
    const at = get().playhead
    const made: string[] = []
    set((state) => ({
      tracks: state.tracks.map((track) => {
        const next: ComposeClip[] = []
        for (const clip of track.clips) {
          const inside =
            at > clip.start + MIN_CLIP_SECONDS && at < clip.start + clip.duration - MIN_CLIP_SECONDS
          if (!inside) {
            next.push(clip)
            continue
          }
          const passed = at - clip.start
          const rightId = nextId()
          const right: ComposeClip = {
            ...clip,
            id: rightId,
            start: at,
            duration: clip.duration - passed,
            // У картинки своего времени нет, а ролик продолжаем с той же точки.
            // Задом наперёд — наоборот: правая половина на таймлайне — это
            // начало отрезка файла, левая — его конец.
            sourceIn:
              clip.kind === 'image' || clip.reverse
                ? clip.sourceIn
                : clip.sourceIn + passed * speedOf(clip),
            // Половинки связаны между собой заново: старая связка осталась у
            // левых кусков, правым нужна своя.
            groupId: clip.groupId ? `${clip.groupId}-r` : undefined,
          }
          // Ключи правой половины — от её собственного начала, на тех же кадрах.
          right.anim = rekey(clip, { start: right.start, sourceIn: right.sourceIn, speed: speedOf(clip) })
          made.push(rightId)
          next.push(
            {
              ...clip,
              duration: passed,
              ...(clip.reverse
                ? { sourceIn: clip.sourceIn + (clip.duration - passed) * speedOf(clip) }
                : {}),
            },
            right,
          )
        }
        return { ...track, clips: next }
      }),
    }))
    if (made.length) set({ selected: made.slice(0, 1) })
    save(get())
  },

  removeClips(ids) {
    get().mark()
    set((state) => {
      const all = state.tracks.flatMap((track) => track.clips)
      const links = new Set(
        all.filter((clip) => ids.includes(clip.id)).map((clip) => clip.groupId).filter(Boolean),
      )
      return {
        tracks: state.tracks.map((track) => ({
          ...track,
          clips: track.clips.filter(
            (clip) => !ids.includes(clip.id) && !(clip.groupId && links.has(clip.groupId)),
          ),
        })),
        selected: [],
      }
    })
    save(get())
  },

  // --- дорожки -----------------------------------------------------------
  /**
   * Добавляет дорожку.
   *
   * Видеодорожка встаёт сверху и становится верхним слоем: так же она и
   * нарисована, и так же собирается в файл. Звуковые живут ниже всех —
   * слоёв у звука нет, он просто складывается.
   */
  addTrack(kind) {
    get().mark()
    set((state) => {
      if (state.tracks.length >= MAX_TRACKS) return state
      const track: ComposeTrack = { id: nextId(), kind, clips: [], level: 1 }
      return {
        tracks: kind === 'video' ? [track, ...state.tracks] : [...state.tracks, track],
      }
    })
    save(get())
  },

  /**
   * Убирает дорожку вместе с тем, что на ней лежит.
   *
   * Убрать можно любую, в том числе последнюю звуковую или последнюю
   * видеодорожку: бывает монтаж из одного только видео или одного только
   * звука, и лишняя пустая дорожка там только мешает. Не даём снять лишь
   * самую последнюю — на пустом таймлайне некуда было бы положить файл.
   */
  removeTrack(id) {
    get().mark()
    set((state) => {
      if (state.tracks.length <= 1) return state
      const going = state.tracks.find((track) => track.id === id)
      if (!going) return state
      const gone = going.clips.map((clip) => clip.id)
      return {
        tracks: state.tracks.filter((track) => track.id !== id),
        selected: state.selected.filter((clip) => !gone.includes(clip)),
      }
    })
    save(get())
  },

  /**
   * Переставляет дорожку на новое место.
   *
   * Видеодорожки всегда выше звуковых: слои считаются сверху вниз, и звук,
   * оказавшийся между картинками, ломал бы этот порядок. Поэтому дорожка
   * ходит только внутри своего вида — за границу её не пускаем, а прижимаем
   * к краю соседнего блока.
   */
  moveTrack(id, to) {
    get().mark()
    set((state) => {
      const from = state.tracks.findIndex((track) => track.id === id)
      if (from < 0) return state
      const kind = state.tracks[from].kind
      const same = state.tracks
        .map((track, index) => ({ track, index }))
        .filter((item) => item.track.kind === kind)
        .map((item) => item.index)
      const limited = Math.min(Math.max(to, same[0]), same[same.length - 1])
      if (limited === from) return state
      const tracks = [...state.tracks]
      const [moved] = tracks.splice(from, 1)
      tracks.splice(limited, 0, moved)
      return { tracks }
    })
    save(get())
  },

  setTrackHeight(id, height) {
    set((state) => ({
      tracks: state.tracks.map((track) => (track.id === id ? { ...track, height } : track)),
    }))
    save(get())
  },

  renameTrack(id, name) {
    set((state) => ({
      tracks: state.tracks.map((track) =>
        track.id === id ? { ...track, name: name.slice(0, 60) } : track,
      ),
    }))
    save(get())
  },

  setTrackLevel(id, level) {
    set((state) => ({
      tracks: state.tracks.map((track) =>
        track.id === id
          ? { ...track, level: Math.min(track.kind === 'audio' ? MAX_GAIN : 1, Math.max(0, level)) }
          : track,
      ),
    }))
    save(get())
  },

  /**
   * Не даёт трём клипам сойтись в одной точке дорожки.
   *
   * Наложение двух — это переход: один сменяет другой. Третий поверх перехода
   * не значит ничего: непонятно, что должно быть видно, и выглядит это
   * случайной кашей.
   *
   * Проверяем только в конце перетаскивания, а не на каждом движении мыши:
   * иначе клип упирался бы в чужой переход и не мог бы через него
   * перебраться. Не поместился — отодвигаем к ближайшему месту, где всё в
   * порядке, а не возвращаем откуда взяли.
   */
  settleOverlaps(ids) {
    if (!ids.length) return
    const state = get()
    let shift = 0
    for (const track of state.tracks) {
      for (const clip of track.clips) {
        if (!ids.includes(clip.id)) continue
        const others = track.clips.filter((item) => item.id !== clip.id)
        const delta = escapeCrowd(clip, others)
        if (Math.abs(delta) > Math.abs(shift)) shift = delta
      }
    }
    if (Math.abs(shift) > 1e-6) get().moveClips(ids, shift)
  },

  /**
   * Укорачивает клип, если, растягивая, его дотянули до чужого перехода.
   *
   * Правило то же: трое в одной точке — это каша. Растягивать можно до чужого
   * перехода, но не поверх него.
   */
  trimOverlaps(id) {
    const state = get()
    for (const track of state.tracks) {
      const clip = track.clips.find((item) => item.id === id)
      if (!clip) continue
      const zone = crowdedUnder(clip, track.clips.filter((item) => item.id !== id))
      if (!zone) return
      const end = clip.start + clip.duration
      if (clip.start <= zone.from) {
        state.resizeClip(id, clip.start, zone.from - clip.start, clip.sourceIn)
      } else {
        const shift = zone.to - clip.start
        state.resizeClip(
          id,
          zone.to,
          end - zone.to,
          clip.kind === 'image' ? 0 : Math.max(0, clip.sourceIn + shift * speedOf(clip)),
        )
      }
      return
    }
  },

  /**
   * Переносит клипы на соседние дорожки.
   *
   * Сдвигаем всех выбранных на одно и то же число дорожек, а не сваливаем их
   * на одну: иначе разложенные по слоям клипы схлопнулись бы в кучу.
   *
   * Считаем отдельно по картинке и по звуку. Если хоть одной картинке
   * переехать некуда — картинки не двигаются вовсе: половина переехала,
   * половина осталась, и то, что было разложено по слоям, перепуталось. А вот
   * звуку это не мешает: у ролика со звуком половинки лежат на разных
   * дорожках, и картинка должна переезжать между слоями, даже когда звуковых
   * дорожек всего одна и его звуку двигаться некуда.
   */
  shiftTracks(ids, delta) {
    if (!delta || !ids.length) return
    set((state) => {
      const wanted: { clip: ComposeClip; kind: 'video' | 'audio'; to: number }[] = []
      const stuck = new Set<'video' | 'audio'>()
      for (const [index, track] of state.tracks.entries()) {
        for (const clip of track.clips) {
          if (!ids.includes(clip.id)) continue
          const target = state.tracks[index + delta]
          if (!target || target.kind !== track.kind) stuck.add(track.kind)
          else wanted.push({ clip, kind: track.kind, to: index + delta })
        }
      }
      const moves = wanted.filter((move) => !stuck.has(move.kind))
      if (!moves.length) return state

      const tracks = state.tracks.map((track, index) => ({
        ...track,
        clips: [
          ...track.clips.filter((clip) => !moves.some((move) => move.clip.id === clip.id)),
          ...moves.filter((move) => move.to === index).map((move) => move.clip),
        ],
      }))
      return { tracks: settle(tracks) }
    })
    save(get())
  },

  /**
   * Собирает выбранные клипы в одну группу.
   *
   * Вместе с ними забирает и тех, кто уже был с ними в группе: у ролика это
   * его звук. Иначе группировка картинки с музыкой отрывала бы от ролика
   * собственную дорожку — и при первом же перетаскивании они разъехались бы.
   */
  groupClips(ids) {
    get().mark()
    if (ids.length < 2) return
    const groupId = nextId()
    set((state) => {
      const all = state.tracks.flatMap((track) => track.clips)
      const known = new Set(
        all.filter((clip) => ids.includes(clip.id)).map((clip) => clip.groupId).filter(Boolean),
      )
      const family = all
        .filter((clip) => ids.includes(clip.id) || (clip.groupId && known.has(clip.groupId)))
        .map((clip) => clip.id)

      return {
        tracks: state.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            family.includes(clip.id) ? { ...clip, groupId } : clip,
          ),
        })),
        selected: family,
      }
    })
    save(get())
  },

  /**
   * Запоминает выбранные клипы.
   *
   * Буфер свой, а не системный: в нём лежат клипы со всеми настройками —
   * громкостью, затуханиями, местом в кадре, — и превращать их в текст ради
   * обмена с другими программами незачем. Время считаем от самого левого из
   * выбранных, чтобы при вставке они легли от иглы тем же узором.
   */
  copyClips(ids) {
    const all = get().tracks.flatMap((track) => track.clips)
    const family = withGroups(get().tracks, ids)
    const taken = all.filter((clip) => family.includes(clip.id))
    if (!taken.length) {
      clipboard = []
      return 0
    }
    const edge = Math.min(...taken.map((clip) => clip.start))
    clipboard = taken.map((clip) => {
      const track = get().tracks.find((item) => item.clips.some((one) => one.id === clip.id))
      return { clip: { ...clip, start: clip.start - edge }, trackId: track?.id ?? '' }
    })
    return clipboard.length
  },

  pasteClips(from) {
    if (!clipboard.length) return
    get().mark()
    const at = from ?? get().playhead
    // Группы восстанавливаем заново: копии должны ходить вместе между собой,
    // а не цепляться к тем клипам, с которых их сняли.
    const groups = new Map<string, string>()
    const made: string[] = []
    set((state) => {
      const put = new Map<string, ComposeClip[]>()
      for (const item of clipboard) {
        const known = state.tracks.find((track) => track.id === item.trackId)
        // Дорожки могло не стать — кладём на первую подходящую по виду.
        const track =
          known ?? state.tracks.find((one) => one.kind === (item.clip.kind === 'audio' ? 'audio' : 'video'))
        if (!track) continue
        let groupId = item.clip.groupId
        if (groupId) {
          if (!groups.has(groupId)) groups.set(groupId, nextId())
          groupId = groups.get(groupId)
        }
        const copy: ComposeClip = {
          ...item.clip,
          id: nextId(),
          start: Math.max(0, at + item.clip.start),
          groupId,
        }
        made.push(copy.id)
        put.set(track.id, [...(put.get(track.id) ?? []), copy])
      }
      return {
        tracks: settle(
          state.tracks.map((track) =>
            put.has(track.id) ? { ...track, clips: [...track.clips, ...put.get(track.id)!] } : track,
          ),
        ),
        selected: made,
      }
    })
    save(get())
  },

  hasCopy() {
    return clipboard.length > 0
  },

  /** Выпускает клипы из группы — дальше они ходят сами по себе. */
  ungroupClips(ids) {
    get().mark()
    set((state) => {
      // Выделение сужаем до того клипа, который человек брал в руки. Пока
      // группа была, выбранными числились оба её клипа — и Delete сразу
      // после разрыва уносил и второй, хотя связи между ними уже нет.
      const alone = state.picked.filter((id) => ids.includes(id))
      return {
        tracks: state.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) =>
            ids.includes(clip.id) ? { ...clip, groupId: undefined } : clip,
          ),
        })),
        selected: alone.length ? alone : state.selected,
      }
    })
    save(get())
  },

  /**
   * Убирает с таймлайна всё: и клипы, и лишние дорожки.
   *
   * Дорожки заводят под конкретный монтаж, и после очистки они висят пустыми —
   * удалять их по одной незачем. Остаётся по одной каждого вида, чтобы было
   * куда положить следующий файл.
   */
  clearAll() {
    get().mark()
    set((state) => {
      const first = (kind: 'video' | 'audio') => state.tracks.find((t) => t.kind === kind)
      const kept = [first('video'), first('audio')].filter(Boolean) as ComposeTrack[]
      return {
        tracks: (kept.length ? kept : state.tracks.slice(0, 1)).map((track) => ({
          ...track,
          clips: [],
          name: '',
          level: 1,
        })),
        selected: [],
        playhead: 0,
        renderIn: null,
        renderOut: null,
      }
    })
    save(get())
  },

  snapshot() {
    return toSaved(get())
  },

  /**
   * Открывает сохранённый монтаж вместо нынешнего.
   *
   * Игла и выделение при этом сбрасываются: в чужом монтаже они ничего не
   * значат, а клипа, который был выбран, там может и не быть.
   */
  loadProject(data) {
    get().mark()
    set({ ...normalize(data), playhead: 0, selected: [], missing: [], opened: get().opened + 1 })
    save(get())
  },

  placeClip(id, patch) {
    const values: Record<string, number> = {}
    for (const field of ['x', 'y', 'size', 'sizeY'] as const) {
      const value = patch[field]
      if (typeof value === 'number') values[field] = value
    }
    get().applyValues(id, values)
  },

  applyValues(id, values) {
    const clip = get().findClip(id)?.clip
    if (!clip) return
    const local = get().playhead - clip.start
    // Показатели раскладываем по группам: у каждой свои ключи.
    let next: ComposeClip = clip
    const plain: Record<string, AnimValue> = {}
    const touched = new Map<string, Record<string, AnimValue>>()
    for (const [field, value] of Object.entries(values)) {
      const groupId =
        field === 'x' || field === 'y'
          ? 'position'
          : field === 'size' || field === 'sizeY'
            ? 'size'
            : CROP_FIELDS.includes(field)
              ? 'crop'
              : MASK_FIELDS.includes(field) || field === POINTS
                ? 'mask'
                : field.startsWith('fx.')
                  ? field
                  : ''
      const group = groupOf(clip, groupId)
      const keyed = group && group.fields.some((name) => (clip.anim?.[name]?.length ?? 0) > 0)
      if (group && (keyed || group.auto)) {
        touched.set(group.id, { ...(touched.get(group.id) ?? {}), [field]: value })
      } else {
        plain[field] = value
      }
    }
    next = withValues(next, plain)
    for (const [groupId, part] of touched) {
      const group = groupOf(next, groupId)!
      // Остальные показатели группы — какими они видны под иглой.
      const current = groupValues(next, group, local)
      next = { ...next, anim: withKey(next, group, local, { ...current, ...part }) }
    }
    get().updateClip(id, {
      x: next.x,
      y: next.y,
      size: next.size,
      sizeY: next.sizeY,
      cropLeft: next.cropLeft,
      cropTop: next.cropTop,
      cropRight: next.cropRight,
      cropBottom: next.cropBottom,
      mask: next.mask,
      effects: next.effects,
      anim: next.anim,
    })
  },

  animFocus: null,
  setAnimFocus(group) {
    set({ animFocus: group })
  },

  toggleAnim(id, groupId) {
    const clip = get().findClip(id)?.clip
    const group = clip && groupOf(clip, groupId)
    if (!clip || !group) return
    // Часики — это «чьи ключи сейчас в работе», а не «есть ли ключи».
    // Одни на всё: включили эти — прежние погасли. Выключение ключей не
    // стирает: движение остаётся, просто их не видно на таймлайне.
    if (get().animFocus === groupId) {
      set({ animFocus: null, selectedKeys: null })
      return
    }
    const keyed = group.fields.some((field) => (clip.anim?.[field]?.length ?? 0) > 0)
    if (!keyed) {
      // Ключей ещё нет — первый встаёт под иглой с тем, что сейчас видно.
      get().mark()
      const at = Math.min(Math.max(get().playhead - clip.start, 0), clip.duration)
      get().updateClip(id, { anim: withKey(clip, group, at, groupValues(clip, group, at)) })
    }
    set({ animFocus: groupId, selectedKeys: null })
  },

  selectedKeys: null,
  selectKeys(selection) {
    set({ selectedKeys: selection })
  },

  moveKeys(id, groupId, times, delta) {
    const clip = get().findClip(id)?.clip
    const group = clip && groupOf(clip, groupId)
    if (!clip || !group || !delta) return
    const near = (t: number) => times.some((time) => Math.abs(time - t) < KEY_NEAR / 2)
    const anim: Anim = { ...(clip.anim ?? {}) }
    for (const field of group.fields) {
      const keys = anim[field] ?? []
      const moving = keys.filter((key) => near(key.t))
      // Сдвинутый ключ, попавший на соседний, занимает его место.
      const staying = keys.filter(
        (key) => !near(key.t) && !moving.some((item) => Math.abs(item.t + delta - key.t) < KEY_NEAR / 2),
      )
      anim[field] = [...staying, ...moving.map((key) => ({ ...key, t: key.t + delta }))].sort((a, b) => a.t - b.t)
    }
    get().updateClip(id, { anim })
  },

  deleteKeys() {
    const chosen = get().selectedKeys
    if (!chosen) return
    const clip = get().findClip(chosen.clipId)?.clip
    const group = clip && groupOf(clip, chosen.group)
    if (!clip || !group) return
    get().mark()
    const near = (t: number) => chosen.times.some((time) => Math.abs(time - t) < KEY_NEAR / 2)
    const anim: Anim = { ...(clip.anim ?? {}) }
    let left = false
    for (const field of group.fields) {
      anim[field] = (anim[field] ?? []).filter((key) => !near(key.t))
      if (anim[field].length) left = true
      else delete anim[field]
    }
    // Убрали все ключи — показатель остаётся таким, каким был под иглой.
    const local = get().playhead - clip.start
    const next = left ? { ...clip, anim } : withValues({ ...clip, anim }, groupValues(clip, group, local))
    get().updateClip(clip.id, { ...next })
    set({ selectedKeys: null })
  },

  copyKeys() {
    const chosen = get().selectedKeys
    if (!chosen) return 0
    const clip = get().findClip(chosen.clipId)?.clip
    const group = clip && groupOf(clip, chosen.group)
    if (!clip || !group) return 0
    const first = Math.min(...chosen.times)
    const near = (t: number) => chosen.times.some((time) => Math.abs(time - t) < KEY_NEAR / 2)
    // Время — от самого левого из выбранных: вставятся от иглы тем же узором.
    const fields: Record<string, AnimKey[]> = {}
    for (const field of group.fields) {
      fields[field] = (clip.anim?.[field] ?? [])
        .filter((key) => near(key.t))
        .map((key) => ({ ...key, t: key.t - first }))
    }
    keyClipboard = { kind: chosen.group.startsWith('fx.') ? effectOf(chosen.group) : chosen.group, fields }
    return chosen.times.length
  },

  hasKeyCopy() {
    return keyClipboard !== null
  },

  pasteKeys() {
    const copy = keyClipboard
    const focus = get().animFocus
    const ids = get().selected
    if (!copy || !focus) return false
    const clip = ids.map((id) => get().findClip(id)?.clip).find((item) => item && groupOf(item, focus))
    const group = clip && groupOf(clip, focus)
    if (!clip || !group) return false
    // Вставлять можно в ту же настройку — или в такую же у другого эффекта
    // того же вида (размытие одного клипа — в размытие другого).
    const kind = focus.startsWith('fx.') ? effectOf(focus) : focus
    if (kind !== copy.kind) return false
    get().mark()
    const at = get().playhead - clip.start
    const anim: Anim = { ...(clip.anim ?? {}) }
    const sources = Object.values(copy.fields)
    group.fields.forEach((field, index) => {
      const pasted = (copy.fields[field] ?? sources[index] ?? []).map((key) => ({ ...key, t: key.t + at }))
      if (!pasted.length) return
      const clash = (t: number) => pasted.some((key) => Math.abs(key.t - t) < KEY_NEAR / 2)
      anim[field] = [...(anim[field] ?? []).filter((key) => !clash(key.t)), ...pasted].sort((a, b) => a.t - b.t)
    })
    get().updateClip(clip.id, { anim })
    const times = keyTimes({ ...clip, anim }, group).filter((t) =>
      Object.values(copy.fields).some((keys) => keys.some((key) => Math.abs(key.t + at - t) < KEY_NEAR / 2)),
    )
    set({ selectedKeys: { clipId: clip.id, group: focus, times } })
    return true
  },

  keyHere(id, groupId) {
    const clip = get().findClip(id)?.clip
    const group = clip && groupOf(clip, groupId)
    if (!clip || !group) return
    get().mark()
    const local = get().playhead - clip.start
    get().updateClip(id, { anim: withKey(clip, group, local, groupValues(clip, group, local)) })
  },

  unkeyHere(id, groupId) {
    const clip = get().findClip(id)?.clip
    const group = clip && groupOf(clip, groupId)
    if (!clip || !group) return
    const local = get().playhead - clip.start
    const anim = withoutKey(clip, group, local)
    if (!anim) return
    get().mark()
    // Убрали последний ключ — показатель остаётся таким, каким был в нём.
    const left = group.fields.some((field) => (anim[field]?.length ?? 0) > 0)
    const fixed = left ? { ...clip, anim } : withValues({ ...clip, anim }, groupValues(clip, group, local))
    get().updateClip(id, { ...fixed })
  },

  resetPlace(id) {
    const clip = get().findClip(id)?.clip
    if (!clip) return
    get().mark()
    get().updateClip(id, {
      x: 0.5,
      y: 0.5,
      size: 1,
      sizeY: 0,
      anim: withoutGroup(clip.anim, ['x', 'y', 'size', 'sizeY']),
    })
  },

  removeMask(id) {
    const clip = get().findClip(id)?.clip
    if (!clip) return
    get().mark()
    if (get().masking === id) set({ masking: null })
    get().updateClip(id, { mask: null, anim: withoutPrefix(clip.anim, 'mask.') })
  },

  ensureKey(id, groupId) {
    const clip = get().findClip(id)?.clip
    const group = clip && groupOf(clip, groupId)
    if (!clip || !group) return
    if (group.fields.some((field) => (clip.anim?.[field]?.length ?? 0) > 0)) return
    const local = Math.min(Math.max(get().playhead - clip.start, 0), clip.duration)
    get().updateClip(id, { anim: withKey(clip, group, local, groupValues(clip, group, local)) })
  },

  removeCrop(id) {
    const clip = get().findClip(id)?.clip
    if (!clip) return
    get().mark()
    get().updateClip(id, {
      cropLeft: 0,
      cropTop: 0,
      cropRight: 0,
      cropBottom: 0,
      anim: withoutGroup(clip.anim, CROP_FIELDS),
    })
  },

  partnerOf(clipId) {
    const all = get().tracks.flatMap((track) => track.clips)
    const clip = all.find((item) => item.id === clipId)
    if (!clip?.groupId) return null
    // Родная половина — из той же группы, с тем же файлом и другого вида:
    // в группе, собранной руками, могут лежать и чужие клипы.
    return (
      all.find(
        (item) =>
          item.id !== clip.id &&
          item.groupId === clip.groupId &&
          item.source === clip.source &&
          (item.kind === 'audio') !== (clip.kind === 'audio'),
      ) ?? null
    )
  },

  copyEffects(clipId) {
    const clip = get().findClip(clipId)?.clip
    if (!clip) return 0
    // Эффекты ролика — это и картинка, и звук: берём обе половины.
    const parts = [clip, get().partnerOf(clipId)].filter(Boolean) as ComposeClip[]
    const effects: ClipEffect[] = []
    const keys: Record<string, AnimKey[]> = {}
    for (const part of parts) {
      for (const effect of part.effects ?? []) {
        effects.push(effect)
        for (const [field, list] of Object.entries(part.anim ?? {})) {
          if (field.startsWith(`fx.${effect.id}.`)) keys[field] = list
        }
      }
    }
    effectClipboard = effects.length ? { effects, keys } : null
    return effects.length
  },

  hasEffectCopy() {
    return effectClipboard !== null
  },

  pasteEffects(ids) {
    const copy = effectClipboard
    if (!copy) return
    get().mark()
    const targets = new Set<string>()
    for (const id of ids) {
      targets.add(id)
      const partner = get().partnerOf(id)
      if (partner) targets.add(partner.id)
    }
    for (const id of targets) {
      const clip = get().findClip(id)?.clip
      if (!clip) continue
      const wanted = clip.kind === 'audio' ? 'audio' : clip.kind === 'video' || clip.kind === 'image' ? 'video' : null
      const fitting = copy.effects.filter((effect) => effectKind(effect.type)?.target === wanted)
      if (!fitting.length) continue
      // Такой же эффект уже есть — заменяем его, а не ставим второй.
      const types = new Set(fitting.map((effect) => effect.type))
      const dropped = (clip.effects ?? []).filter((effect) => types.has(effect.type))
      let anim = clip.anim ?? {}
      for (const effect of dropped) anim = withoutPrefix(anim, `fx.${effect.id}.`)
      const made = fitting.map((effect) => {
        const fresh = { ...effect, id: nextId(), params: { ...effect.params } }
        for (const [field, list] of Object.entries(copy.keys)) {
          if (field.startsWith(`fx.${effect.id}.`)) {
            anim = { ...anim, [`fx.${fresh.id}.${field.split('.')[2]}`]: list.map((key) => ({ ...key })) }
          }
        }
        return fresh
      })
      get().updateClip(id, {
        effects: [...(clip.effects ?? []).filter((effect) => !types.has(effect.type)), ...made],
        anim,
      })
    }
  },

  addEffect(clipId, type, params) {
    get().mark()
    const clip = get().findClip(clipId)?.clip
    if (!clip) return
    const effect: ClipEffect = { id: nextId(), type, on: true, params }
    get().updateClip(clipId, { effects: [...(clip.effects ?? []), effect] })
  },

  updateEffect(clipId, effectId, patch) {
    const clip = get().findClip(clipId)?.clip
    if (!clip) return
    get().updateClip(clipId, {
      effects: (clip.effects ?? []).map((effect) =>
        effect.id === effectId
          ? { ...effect, ...patch, params: { ...effect.params, ...(patch.params ?? {}) } }
          : effect,
      ),
    })
  },

  removeEffect(clipId, effectId) {
    get().mark()
    const clip = get().findClip(clipId)?.clip
    if (!clip) return
    get().updateClip(clipId, {
      effects: (clip.effects ?? []).filter((effect) => effect.id !== effectId),
      anim: withoutPrefix(clip.anim, `fx.${effectId}.`),
    })
  },

  flipClips(ids, axis) {
    get().mark()
    for (const id of ids) {
      const clip = get().findClip(id)?.clip
      if (!clip || clip.kind === 'audio' || clip.kind === 'text') continue
      get().updateClip(id, axis === 'h' ? { flipH: !clip.flipH } : { flipV: !clip.flipV })
    }
  },

  rotateClips(ids) {
    get().mark()
    for (const id of ids) {
      const clip = get().findClip(id)?.clip
      if (!clip || clip.kind === 'audio' || clip.kind === 'text') continue
      // Повёрнутый на бок клип меняет форму — рамка в окне просмотра должна
      // лечь по новой картинке, а не по прежней.
      get().updateClip(id, {
        rotate: ((clip.rotate ?? 0) + 90) % 360,
        ratio: clip.ratio ? 1 / clip.ratio : clip.ratio,
      })
    }
  },

  resetSpeed(id) {
    const clip = get().findClip(id)?.clip
    if (!clip) return
    get().mark()
    get().resizeClip(id, clip.start, clip.duration * speedOf(clip), clip.sourceIn, 1)
  },

  reverseClips(ids) {
    get().mark()
    const touched = new Set<string>()
    for (const id of ids) {
      const clip = get().findClip(id)?.clip
      if (!clip || (clip.kind !== 'video' && clip.kind !== 'audio')) continue
      const next = !clip.reverse
      // Картинка и звук ролика разворачиваются вместе: иначе губы шли бы в
      // одну сторону, а голос в другую.
      for (const item of [clip, get().partnerOf(id)]) {
        if (!item || touched.has(item.id)) continue
        touched.add(item.id)
        get().updateClip(item.id, { reverse: next })
      }
    }
  },

  setMissing(paths) {
    set({ missing: paths })
  },

  reportMissing(paths) {
    const known = get().missing
    const fresh = paths.filter((path) => !known.includes(path))
    if (!fresh.length) return
    set({ missing: [...known, ...fresh], missingAlert: get().missingAlert + 1 })
  },

  relink(from, to) {
    get().mark()
    const oldName = from.split(/[\\/]/).pop()
    const newName = to.split(/[\\/]/).pop() ?? to
    set((state) => ({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.source === from
            ? {
                ...clip,
                source: to,
                // Подпись на клипе — имя файла, если человек её не менял.
                name: clip.name === oldName ? newName : clip.name,
              }
            : clip,
        ),
      })),
      missing: state.missing.filter((path) => path !== from),
    }))
    save(get())
  },

  duration() {
    return get().tracks.reduce(
      (longest, track) =>
        track.clips.reduce((value, clip) => Math.max(value, clip.start + clip.duration), longest),
      0,
    )
  },

  findClip(id) {
    if (!id) return null
    for (const track of get().tracks) {
      const clip = track.clips.find((item) => item.id === id)
      if (clip) return { clip, track }
    }
    return null
  },
}))

/**
 * Точки, к которым липнут края клипов: ноль, игла и границы **всех** клипов,
 * включая соседние дорожки.
 *
 * Соседние дорожки важнее своих: так видео выравнивается по музыке под ним, а
 * звук — по картинке над ним, и в готовом файле не остаётся ни просадки в
 * звуке, ни чёрного кадра длиной в полсекунды.
 */
export function magnets(
  tracks: ComposeTrack[],
  skipIds: string[],
  playhead: number,
): number[] {
  const points = [0, playhead]
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (skipIds.includes(clip.id)) continue
      points.push(clip.start, clip.start + clip.duration)
    }
  }
  return points
}

/** Края всех клипов — к ним липнет игла, когда её тянут. */
export function clipEdges(tracks: ComposeTrack[]): number[] {
  const points = [0]
  for (const track of tracks) {
    for (const clip of track.clips) points.push(clip.start, clip.start + clip.duration)
  }
  return points
}

export function snap(value: number, points: number[], within: number): number {
  let best = value
  let distance = within
  for (const point of points) {
    const gap = Math.abs(point - value)
    if (gap < distance) {
      distance = gap
      best = point
    }
  }
  return best
}
