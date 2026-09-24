import { useEffect, useState } from 'react'
import { api } from './api'
import type { SceneInfo } from './types'

/**
 * Кадры и склейки ролика — общие для таймлайна монтажа и медиатеки.
 *
 * Сервер читает ролик один раз и отмечает смены сцен (`core/scenes.py`).
 * Ответ держим в памяти: один файл на таймлайне встречается несколько раз.
 */

const cache = new Map<string, SceneInfo | null>()
const waiting = new Map<string, Promise<SceneInfo | null>>()
const listeners = new Set<() => void>()

function load(path: string): Promise<SceneInfo | null> {
  const known = waiting.get(path)
  if (known) return known
  const promise = api
    .scenes(path)
    .catch(() => null)
    .then((data) => {
      cache.set(path, data)
      waiting.delete(path)
      listeners.forEach((listener) => listener())
      return data
    })
  waiting.set(path, promise)
  return promise
}

/** Сцены файла, если уже известны, — без запроса. */
export function scenesOf(path: string): SceneInfo | null {
  return cache.get(path) ?? null
}

export function useScenes(path: string | null | undefined, enabled = true): SceneInfo | null {
  const [info, setInfo] = useState<SceneInfo | null>(() => (path ? cache.get(path) ?? null : null))
  useEffect(() => {
    if (!path || !enabled) {
      setInfo(path ? cache.get(path) ?? null : null)
      return
    }
    if (cache.has(path)) {
      setInfo(cache.get(path) ?? null)
      return
    }
    let alive = true
    void load(path).then((data) => {
      if (alive) setInfo(data)
    })
    return () => {
      alive = false
    }
  }, [path, enabled])
  return info
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
