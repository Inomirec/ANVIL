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

  setQuality: (quality: number) => void
  setShape: (shape: string) => void
  setTurned: (turned: boolean) => void
  setCustomSize: (width: number, height: number) => void
  useCustom: (custom: boolean) => void
  setFps: (fps: number) => void
  setPlayhead: (at: number) => void
  setScale: (scale: number) => void
  select: (ids: string[]) => void

  setMasterVolume: (value: number) => void
  setLoudnorm: (value: boolean) => void
  markIn: () => void
  markOut: () => void
  clearMarks: () => void

  addClip: (clip: Omit<ComposeClip, 'id'>, trackId?: string) => string
  addPair: (video: Omit<ComposeClip, 'id'>, trackId?: string) => string
  updateClip: (id: string, patch: Partial<ComposeClip>) => void
  moveClips: (ids: string[], shift: number) => void
  resizeClip: (id: string, start: number, duration: number, sourceIn: number) => void
  splitAtPlayhead: () => void
  removeClips: (ids: string[]) => void
  groupClips: (ids: string[]) => void
  ungroupClips: (ids: string[]) => void
  clearAll: () => void

  duration: () => number
  findClip: (id: string | null) => { clip: ComposeClip; track: ComposeTrack } | null
}

function loadSaved(): Saved {
  const empty: Saved = {
    width: 1280,
    height: 720,
    fps: 30,
    quality: 720,
    shape: '16:9',
    turned: false,
    custom: false,
    tracks: [
      { id: 'v1', kind: 'video', clips: [] },
      { id: 'a1', kind: 'audio', clips: [] },
    ],
    renderIn: null,
    renderOut: null,
    masterVolume: 1,
    loudnorm: false,
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const data = JSON.parse(raw) as Saved
    if (!Array.isArray(data.tracks) || !data.tracks.length) return empty
    const tracks = data.tracks.map((track) => ({
      ...track,
      // Клипы из прежних версий не знали про громкость и затухания.
      clips: (track.clips ?? []).map((clip) => ({
        ...clip,
        volume: clip.volume ?? 1,
        fadeIn: clip.fadeIn ?? 0,
        fadeOut: clip.fadeOut ?? 0,
        muted: clip.muted ?? false,
        opacity: clip.opacity ?? 1,
        zoom: clip.zoom ?? 1,
      })),
    }))
    if (!tracks.some((track) => track.kind === 'audio')) {
      tracks.push({ id: 'a1', kind: 'audio', clips: [] })
    }
    return { ...empty, ...data, tracks }
  } catch {
    return empty
  }
}

/** Монтаж запоминается сам: закрытое окно не должно стоить часа работы. */
function save(state: State): void {
  try {
    const {
      width, height, fps, quality, shape, turned, custom, tracks,
      renderIn, renderOut, masterVolume, loudnorm,
    } = state
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        width, height, fps, quality, shape, turned, custom, tracks,
        renderIn, renderOut, masterVolume, loudnorm,
      }),
    )
  } catch {
    // Приватный режим браузера — тогда просто не запомним.
  }
}

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

export const useCompose = create<State>((set, get) => ({
  ...loadSaved(),
  playhead: 0,
  selected: [],
  scale: 60,

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

  select(ids) {
    set({ selected: ids })
  },

  // --- метки отрезка сборки ---------------------------------------------
  setMasterVolume(value) {
    set({ masterVolume: Math.min(2, Math.max(0, value)) })
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
   * Кладёт ролик вместе с его звуком: картинку на видеодорожку, звук —
   * отдельным клипом под ней. Человек видит, что звук есть, и может отдельно
   * убавить его или убрать совсем.
   */
  addPair(video, trackId) {
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
      const moving = all
        .filter((clip) => ids.includes(clip.id) || (clip.groupId && links.has(clip.groupId)))
        .map((clip) => clip.id)

      return {
        tracks: settle(
          state.tracks.map((track) => {
            const touched = track.clips.some((clip) => moving.includes(clip.id))
            if (!touched) return track
            const shifted = track.clips.map((clip) =>
              moving.includes(clip.id)
                ? { ...clip, start: Math.max(0, clip.start + shift) }
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

  /**
   * Собирает выбранные клипы в одну группу.
   *
   * Вместе с ними забирает и тех, кто уже был с ними в группе: у ролика это
   * его звук. Иначе группировка картинки с музыкой отрывала бы от ролика
   * собственную дорожку — и при первом же перетаскивании они разъехались бы.
   */
  groupClips(ids) {
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

  clearAll() {
    set((state) => ({
      tracks: state.tracks.map((track) => ({ ...track, clips: [] })),
      selected: [],
      playhead: 0,
      renderIn: null,
      renderOut: null,
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
