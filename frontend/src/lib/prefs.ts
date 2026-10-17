/**
 * Настройки, которые человек выставляет под себя, а не под конкретный файл.
 *
 * Панели экспорта пересоздаются при каждой смене файла, поэтому без общего
 * хранилища галочки сбрасывались бы к умолчанию — и «на видеокарте» или
 * «без подпапки» приходилось бы включать заново для каждого ролика.
 */

const PREFS_KEY = 'sgh.exportPrefs'

export interface Prefs {
  use_gpu?: boolean
  max_height?: number
  loudnorm?: boolean
  mono?: boolean
  videoPreset?: string
  /** Размер картинки один раз переведён с прежнего умолчания на «как есть». */
  imageSizeAsIs?: boolean
  /** Пресет для GIF: видео или движущийся WebP. */
  gifPreset?: string
  audioPreset?: string
  /** Настройки сжатия картинок: формат, качество, предел размера. */
  image?: { format?: string; quality?: number; max_dimension?: number }
  /** Убирать оригинал в корзину после сжатия картинки. */
  imageReplace?: boolean
  /** То же для видео и звука. */
  mediaReplace?: boolean
  /** Показывать живое превью сжатия. */
  imagePreview?: boolean
  /** Складывать результат в подпапку рядом с оригиналом. */
  subfolder?: boolean
  /** Скорость кодирования видео: 0 — очень медленно … 4 — очень быстро, 2 — обычно. */
  videoSpeed?: number | null
  /** То же у картинок. */
  imageSpeed?: number
  /** Контейнер обработанного видео. */
  videoContainer?: string
}

/** Скорость кодирования — одни и те же подписи у видео и картинок. */
export const SPEED_LABELS = ['Очень медленно', 'Медленно', 'Обычно', 'Быстро', 'Очень быстро']


/** Усилие кодировщика картинок (`effort`, 0 — медленно и лучше, 8 — быстро). */
export function imageEffort(level: number): number {
  return [0, 2, 4, 6, 8][Math.min(4, Math.max(0, level))]
}

export function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Prefs
  } catch {
    return {}
  }
}

export function savePrefs(patch: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }))
  } catch {
    // Приватный режим браузера — тогда просто не запомним.
  }
}
