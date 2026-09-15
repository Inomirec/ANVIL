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

export type ClipKind = 'video' | 'image' | 'audio'

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
}

export interface ComposeTrack {
  id: string
  kind: 'video' | 'audio'
  clips: ComposeClip[]
}

/** Сколько висит картинка, если не трогать её длину. */
export const DEFAULT_IMAGE_SECONDS = 3
/** Короче этого клип не тянется — иначе он исчезает под курсором. */
export const MIN_CLIP_SECONDS = 0.2

export const FRAME_SIZES = [
  { label: '1080p (1920×1080)', width: 1920, height: 1080 },
  { label: '720p (1280×720)', width: 1280, height: 720 },
  { label: '480p (854×480)', width: 854, height: 480 },
  { label: 'Вертикальное (1080×1920)', width: 1080, height: 1920 },
  { label: 'Квадрат (1080×1080)', width: 1080, height: 1080 },
]

const STORAGE_KEY = 'sgh.compose'

interface Saved {
  width: number
  height: number
  fps: number
  tracks: ComposeTrack[]
}

interface State extends Saved {
  playhead: number
  selected: string | null
  /** Пикселей в секунде: масштаб таймлайна. */
  scale: number

  setFrame: (width: number, height: number) => void
  setFps: (fps: number) => void
  setPlayhead: (at: number) => void
  setScale: (scale: number) => void
  select: (id: string | null) => void

  addClip: (clip: Omit<ComposeClip, 'id'>, trackId?: string) => string
  moveClip: (id: string, start: number) => void
  resizeClip: (id: string, edge: 'left' | 'right', start: number, duration: number, sourceIn: number) => void
  splitAtPlayhead: () => void
  removeClip: (id: string) => void
  clearAll: () => void

  duration: () => number
  findClip: (id: string | null) => { clip: ComposeClip; track: ComposeTrack } | null
}

function loadSaved(): Saved {
  const empty: Saved = {
    width: 1280,
    height: 720,
    fps: 30,
    tracks: [{ id: 'v1', kind: 'video', clips: [] }],
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const data = JSON.parse(raw) as Saved
    if (!Array.isArray(data.tracks) || !data.tracks.length) return empty
    return { ...empty, ...data }
  } catch {
    return empty
  }
}

/** Монтаж запоминается сам: закрытое окно не должно стоить часа работы. */
function save(state: State): void {
  try {
    const { width, height, fps, tracks } = state
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ width, height, fps, tracks }))
  } catch {
    // Приватный режим браузера — тогда просто не запомним.
  }
}

let counter = 0
const nextId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`

/** Клипы дорожки по порядку. */
const ordered = (track: ComposeTrack) => [...track.clips].sort((a, b) => a.start - b.start)

export const useCompose = create<State>((set, get) => ({
  ...loadSaved(),
  playhead: 0,
  selected: null,
  scale: 60,

  setFrame(width, height) {
    set({ width, height })
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

  select(id) {
    set({ selected: id })
  },

  addClip(clip, trackId) {
    const id = nextId()
    set((state) => ({
      tracks: state.tracks.map((track) =>
        track.id === (trackId ?? state.tracks[0]?.id)
          ? { ...track, clips: [...track.clips, { ...clip, id }] }
          : track,
      ),
      selected: id,
    }))
    save(get())
    return id
  },

  moveClip(id, start) {
    set((state) => ({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === id ? { ...clip, start: Math.max(0, start) } : clip,
        ),
      })),
    }))
    save(get())
  },

  resizeClip(id, _edge, start, duration, sourceIn) {
    set((state) => ({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) =>
          clip.id === id
            ? {
                ...clip,
                start: Math.max(0, start),
                duration: Math.max(MIN_CLIP_SECONDS, duration),
                sourceIn: Math.max(0, sourceIn),
              }
            : clip,
        ),
      })),
    }))
    save(get())
  },

  /**
   * Режет клип под иглой надвое.
   *
   * Это и есть способ убрать кусок из середины ролика: режем дважды и
   * удаляем средний клип. Отдельного инструмента «вырезать» не нужно —
   * в монтажных программах делают ровно так же.
   */
  splitAtPlayhead() {
    const at = get().playhead
    let madeId: string | null = null
    set((state) => ({
      tracks: state.tracks.map((track) => {
        const next: ComposeClip[] = []
        for (const clip of track.clips) {
          const inside = at > clip.start + MIN_CLIP_SECONDS && at < clip.start + clip.duration - MIN_CLIP_SECONDS
          if (!inside) {
            next.push(clip)
            continue
          }
          const passed = at - clip.start
          const right: ComposeClip = {
            ...clip,
            id: nextId(),
            start: at,
            duration: clip.duration - passed,
            // У картинки своего времени нет, а ролик продолжаем с той же точки.
            sourceIn: clip.kind === 'image' ? clip.sourceIn : clip.sourceIn + passed,
          }
          madeId = right.id
          next.push({ ...clip, duration: passed }, right)
        }
        return { ...track, clips: next }
      }),
    }))
    if (madeId) set({ selected: madeId })
    save(get())
  },

  removeClip(id) {
    set((state) => ({
      tracks: state.tracks.map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => clip.id !== id),
      })),
      selected: state.selected === id ? null : state.selected,
    }))
    save(get())
  },

  clearAll() {
    set((state) => ({
      tracks: state.tracks.map((track) => ({ ...track, clips: [] })),
      selected: null,
      playhead: 0,
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
 * Куда встанет клип, чтобы не залезть на соседей.
 *
 * На одной дорожке два клипа в одном месте не помещаются: программа не может
 * решить за человека, какой из них показывать. Поэтому клип упирается в
 * соседа, как в стенку, — и заодно к нему прилипает.
 */
export function limitStart(
  track: ComposeTrack,
  clip: ComposeClip,
  wanted: number,
): number {
  const others = ordered(track).filter((item) => item.id !== clip.id)
  let low = 0
  let high = Number.POSITIVE_INFINITY
  for (const other of others) {
    const otherEnd = other.start + other.duration
    if (otherEnd <= clip.start) low = Math.max(low, otherEnd)
    if (other.start >= clip.start + clip.duration) high = Math.min(high, other.start - clip.duration)
  }
  return Math.min(Math.max(wanted, low), high)
}

/** Точки, к которым липнут края клипов: границы соседей, ноль и игла. */
export function magnets(track: ComposeTrack, skipId: string, playhead: number): number[] {
  const points = [0, playhead]
  for (const clip of track.clips) {
    if (clip.id === skipId) continue
    points.push(clip.start, clip.start + clip.duration)
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
