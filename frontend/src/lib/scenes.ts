import { useEffect, useState } from 'react'
import { api } from './api'
import { loadPrefs, onPrefs } from './prefs'
import type { SceneInfo } from './types'

/** Размер кадров: мелкие — «Низкое качество», крупные — растянутая дорожка. */
export type FrameSize = 'small' | 'normal' | 'large'

/**
 * Кадры и склейки ролика — общие для таймлайна монтажа и медиатеки.
 *
 * Сервер читает ролик один раз и отмечает смены сцен (`core/scenes.py`).
 * Ответ держим в памяти: один файл на таймлайне встречается несколько раз.
 */

const cache = new Map<string, SceneInfo | null>()
const waiting = new Map<string, Promise<SceneInfo | null>>()
const listeners = new Set<() => void>()

/** Ключ кэша: каждый размер кадров — отдельный ответ сервера. */
const slot = (path: string, size: FrameSize) => (size === 'normal' ? path : `${path}#${size}`)

function load(path: string, size: FrameSize = 'normal'): Promise<SceneInfo | null> {
  const id = slot(path, size)
  const known = waiting.get(id)
  if (known) return known
  const promise = api
    .scenes(path, size)
    .catch(() => null)
    .then((data) => {
      cache.set(id, data)
      waiting.delete(id)
      listeners.forEach((listener) => listener())
      return data
    })
  waiting.set(id, promise)
  return promise
}

/** Сцены файла, если уже известны, — без запроса. */
export function scenesOf(path: string): SceneInfo | null {
  return cache.get(path) ?? cache.get(slot(path, 'large')) ?? cache.get(slot(path, 'small')) ?? null
}

export function useScenes(
  path: string | null | undefined,
  enabled = true,
  size: FrameSize = 'normal',
): SceneInfo | null {
  const id = path ? slot(path, size) : ''
  const [info, setInfo] = useState<SceneInfo | null>(() => (path ? cache.get(id) ?? cache.get(path) ?? null : null))
  useEffect(() => {
    if (!path || !enabled) {
      setInfo(path ? cache.get(id) ?? null : null)
      return
    }
    if (cache.has(id)) {
      setInfo(cache.get(id) ?? null)
      return
    }
    // Пока кадры нужного размера готовятся, показываем обычные, если они есть.
    if (size !== 'normal' && cache.get(path)) setInfo(cache.get(path) ?? null)
    let alive = true
    void load(path, size).then((data) => {
      if (alive && data) setInfo(data)
    })
    return () => {
      alive = false
    }
  }, [path, id, enabled, size])
  return info
}

/** Равномерная лента («Редко»): 24 кадра на весь ролик, без склеек. */
const STRIP_FRAMES = 24
const stripCache = new Map<string, SceneInfo | null>()
const stripWaiting = new Map<string, Promise<SceneInfo | null>>()

/**
 * Лента «Редко» в том же виде, что и кадры по сценам: тогда её рисует та же
 * `SceneStrip` — плитки во всю свою ширину, каждая показывает ближайший кадр.
 * Склеек нет, кадров мало, поэтому соседние плитки повторяются — так и видно,
 * что режим редкий. Сервер читает только опорные кадры ролика.
 */
function loadStrip(path: string, low: boolean): Promise<SceneInfo | null> {
  const id = `${path}#strip${low ? '-low' : ''}`
  const known = stripWaiting.get(id)
  if (known) return known
  const promise = api
    .filmstrip(path, STRIP_FRAMES, low ? 36 : 72)
    .then((strip): SceneInfo | null =>
      strip.duration
        ? {
            url: strip.url,
            tileWidth: strip.tileWidth,
            tileHeight: strip.tileHeight,
            columns: strip.frames,
            fps: 0,
            times: Array.from({ length: strip.frames }, (_, index) => (index * strip.duration!) / strip.frames),
            cuts: [],
          }
        : null,
    )
    .catch(() => null)
    .then((data) => {
      stripCache.set(id, data)
      stripWaiting.delete(id)
      return data
    })
  stripWaiting.set(id, promise)
  return promise
}

function useStrip(path: string | null | undefined, enabled: boolean, low: boolean): SceneInfo | null {
  const id = path ? `${path}#strip${low ? '-low' : ''}` : ''
  const [info, setInfo] = useState<SceneInfo | null>(() => stripCache.get(id) ?? null)
  useEffect(() => {
    if (!path || !enabled) return
    if (stripCache.has(id)) {
      setInfo(stripCache.get(id) ?? null)
      return
    }
    let alive = true
    void loadStrip(path, low).then((data) => {
      if (alive) setInfo(data)
    })
    return () => {
      alive = false
    }
  }, [path, id, enabled, low])
  return enabled ? info : null
}

/** Как показывать кадры на дорожках — из настроек («Кадры на таймлайне»). */
export function framePrefs(): { mode: 'scenes' | 'sparse' | 'off'; low: boolean } {
  const prefs = loadPrefs()
  return { mode: prefs.timelineFrames ?? 'scenes', low: prefs.timelineQuality === 'low' }
}

/**
 * Кадры для дорожки видео — по настройке «Кадры на таймлайне», общей для
 * медиатеки и монтажа: по склейкам, редко или никак, низкого качества или
 * хорошего. Настройку меняют на ходу — дорожки перерисовываются сразу.
 * ``tall`` — растянутая дорожка: в хорошем качестве ей нужны кадры крупнее.
 */
export function useFrames(path: string | null | undefined, enabled = true, tall = false) {
  const [prefs, setPrefs] = useState(framePrefs)
  useEffect(() => onPrefs(() => setPrefs(framePrefs())), [])
  const size: FrameSize = prefs.low ? 'small' : tall ? 'large' : 'normal'
  const scenes = useScenes(path, enabled && prefs.mode === 'scenes', size)
  const strip = useStrip(path, enabled && prefs.mode === 'sparse', prefs.low)
  const frames = !enabled ? null : prefs.mode === 'scenes' ? scenes : prefs.mode === 'sparse' ? strip : null
  return { frames, mode: prefs.mode }
}

/** Подписка на появление новых ответов: шагу по сценам нужны свежие склейки. */
export function onScenes(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Времена склеек файла в секундах. */
export function cutTimes(info: SceneInfo): number[] {
  return info.cuts.map((index) => info.times[index])
}

/** Номер кадра сетки, который показывать в момент `t`: последний не позже него. */
export function sampleAt(info: SceneInfo, t: number): number {
  const times = info.times
  let low = 0
  let high = times.length - 1
  if (t < times[0]) return 0
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (times[middle] <= t + 1e-3) low = middle
    else high = middle - 1
  }
  return low
}

// --- кадровая сетка ---------------------------------------------------------

/** Время, притянутое к началу ближайшего кадра. */
export function toFrame(seconds: number, fps: number): number {
  if (!fps || !Number.isFinite(fps)) return seconds
  return Math.round(seconds * fps) / fps
}

/** Время кадром: минуты, секунды и номер кадра в секунде — «1:05:12». */
export function frameCode(seconds: number, fps: number): string {
  const safe = Math.max(0, seconds)
  const whole = Math.round(safe * fps)
  const rate = Math.round(fps) || 1
  const frame = whole % rate
  const total = Math.floor(whole / rate)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  const core = hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`
  return `${core}:${pad(frame)}`
}
