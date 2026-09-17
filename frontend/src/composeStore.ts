import { create } from 'zustand'

/**
 * Состояние вкладки «Монтаж».
 *
 * Отдельное хранилище, а не часть общего: монтаж ничего не знает про
 * медиатеку и очередь, кроме того, что оттуда приходят файлы. Если вкладка
 * не приживётся, её можно убрать целиком, не трогая остальную программу.
 *
 * Время везде в секундах, положение клипа — от начала таймлайна.
 */

export type ClipKind = 'video' | 'image' | 'audio' | 'color'

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

  addClip: (clip: Omit<ComposeClip, 'id'>, trackId?: string) => string
  /** Кладёт заливку под иглу — файла для этого не нужно. */
  addColor: (color: string, trackId?: string) => string
  addPair: (video: Omit<ComposeClip, 'id'>, trackId?: string) => string
  updateClip: (id: string, patch: Partial<ComposeClip>) => void
  moveClips: (ids: string[], shift: number) => void
  resizeClip: (id: string, start: number, duration: number, sourceIn: number) => void
  splitAtPlayhead: () => void
  removeClips: (ids: string[]) => void
  addTrack: (kind: 'video' | 'audio') => void
  removeTrack: (id: string) => void
  renameTrack: (id: string, name: string) => void
  setTrackLevel: (id: string, level: number) => void
  /** Переносит клипы на соседние дорожки: ``delta`` — на сколько вниз. */
  shiftTracks: (ids: string[], delta: number) => void
  /** Разводит клипы, если после переноса где-то сошлись больше двух. */
  settleOverlaps: (ids: string[]) => void
  /** Укорачивает растянутый клип, если он накрыл чужой переход. */
  trimOverlaps: (id: string) => void
  groupClips: (ids: string[]) => void
  ungroupClips: (ids: string[]) => void
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
        lead.sourceIn === clip.sourceIn
      ) {
        return clip
      }
      changed = true
      return { ...clip, start: lead.start, duration: lead.duration, sourceIn: lead.sourceIn }
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
  scale: 60,
  compact: (() => {
    try {
      return localStorage.getItem('sgh.composeCompact') === '1'
    } catch {
      return false
    }
  })(),
  headWidth: recall('sgh.composeHead', 150),

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
    set({ width: even(width), height: even(height), custom: true })
    save(get())
  },

  useCustom(custom) {
    if (custom) {
      set({ custom: true })
    } else {
      const { quality, shape, turned } = get()
      set({ custom: false, ...frameSize(quality, shape, turned) })
    }
    save(get())
  },

  setFps(fps) {
    set({ fps })
    save(get())
  },

  setPlayhead(at) {
    set({ playhead: Math.max(0, at) })
  },

  setScale(scale) {
    set({ scale: Math.min(400, Math.max(4, scale)) })
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

  selectAll() {
    set((state) => ({
      selected: state.tracks.flatMap((track) => track.clips).map((clip) => clip.id),
    }))
  },

  select(ids) {
    // Группа — одно целое: взяв один клип, берём и его соседей. Иначе
    // выделенным выглядит только ролик, а его звуковая дорожка — нет, хотя
    // двигаются, режутся и удаляются они вместе.
    set({ selected: withGroups(get().tracks, ids) })
  },

  // --- метки отрезка сборки ---------------------------------------------
  setMasterVolume(value) {
    set({ masterVolume: Math.min(MAX_GAIN, Math.max(0, value)) })
    save(get())
  },

  setLoudnorm(value) {
    set({ loudnorm: value })
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
  addColor(color, trackId) {
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
        start: Math.round(state.playhead * 100) / 100,
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

  resizeClip(id, start, duration, sourceIn) {
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
                    start: Math.max(0, start),
                    duration: Math.max(MIN_CLIP_SECONDS, duration),
                    sourceIn: Math.max(0, sourceIn),
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
            sourceIn: clip.kind === 'image' ? clip.sourceIn : clip.sourceIn + passed,
            // Половинки связаны между собой заново: старая связка осталась у
            // левых кусков, правым нужна своя.
            groupId: clip.groupId ? `${clip.groupId}-r` : undefined,
          }
          made.push(rightId)
          next.push({ ...clip, duration: passed }, right)
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
          clip.kind === 'image' ? 0 : Math.max(0, clip.sourceIn + shift),
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

  /** Выпускает клипы из группы — дальше они ходят сами по себе. */
  ungroupClips(ids) {
    get().mark()
    set((state) => ({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          ids.includes(clip.id) ? { ...clip, groupId: undefined } : clip,
        ),
      })),
    }))
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
    set({ ...normalize(data), playhead: 0, selected: [] })
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
