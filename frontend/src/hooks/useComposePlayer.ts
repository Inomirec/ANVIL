import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useCompose } from '../composeStore'
import type { MeterLevels } from '../components/MasterMeter'

/**
 * Воспроизведение монтажа.
 *
 * Снаружи это обычный плеер: нажали «играть» — пошло со звуком. Внутри
 * программа собирает кусок монтажа настоящим кодировщиком и играет его
 * обычным видео, а пока он идёт — готовит следующий. Иначе браузеру пришлось
 * бы крутить несколько видео разом и складывать их на лету, чего он не умеет.
 *
 * Длина куска — компромисс: короткий готовится быстрее, но чаще требует
 * подготовки следующего; на длинном дольше ждёшь первого кадра.
 */
const CHUNK_SECONDS = 12
/** С какого качества начинаем. На слабой машине программа понизит сама. */
const START_HEIGHT = 540
const MIN_HEIGHT = 288
/** Дольше этого ждать первый кадр нельзя — берём качество помельче. */
const SLOW_SECONDS = 2.5

interface Chunk {
  url: string
  at: number
  span: number
}

export function useComposePlayer(video: React.RefObject<HTMLVideoElement | null>) {
  const [playing, setPlaying] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [levels, setLevels] = useState<MeterLevels>({ left: -60, right: -60 })
  const [volume, setVolume] = useState(() => {
    const saved = Number(localStorage.getItem('sgh.composeVolume'))
    return Number.isFinite(saved) && saved > 0 ? Math.min(1, saved) : 0.8
  })

  const chunk = useRef<Chunk | null>(null)
  const ahead = useRef<Chunk | null>(null)
  const height = useRef(START_HEIGHT)
  const alive = useRef(true)

  // Звуковой граф: уровень снимаем до громкости прослушивания, чтобы ползунок
  // не влиял на показания шкалы.
  const audio = useRef<{
    ctx: AudioContext
    gain: GainNode
    left: AnalyserNode
    right: AnalyserNode
  } | null>(null)

  const snapshot = useCallback(() => {
    const state = useCompose.getState()
    return {
      width: state.width,
      height: state.height,
      fps: state.fps,
      tracks: state.tracks,
    }
  }, [])

  /** Просит у программы кусок монтажа с указанной секунды. */
  const fetchChunk = useCallback(
    async (at: number): Promise<Chunk | null> => {
      const started = performance.now()
      try {
        const data = await api.composeDraft({
          project: snapshot(),
          at,
          span: CHUNK_SECONDS,
          height: height.current,
        })
        // Собиралось долго — дальше берём кадр помельче. Человек этого не
        // видит, зато просмотр перестаёт спотыкаться на слабой машине.
        const spent = (performance.now() - started) / 1000
        if (spent > SLOW_SECONDS && height.current > MIN_HEIGHT) {
          height.current = Math.max(MIN_HEIGHT, Math.round(height.current / 1.5))
        }
        return { url: data.url, at: data.at, span: data.span }
      } catch (problem) {
        setError((problem as Error).message)
        return null
      }
    },
    [snapshot],
  )

  /** Готовит следующий кусок, пока играет текущий. */
  const prefetch = useCallback(
    async (at: number) => {
      const duration = useCompose.getState().duration()
      if (at >= duration - 0.05) {
        ahead.current = null
        return
      }
      const next = await fetchChunk(at)
      if (alive.current) ahead.current = next
    },
    [fetchChunk],
  )

  const stop = useCallback(() => {
    setPlaying(false)
    setPreparing(false)
    const element = video.current
    if (element) element.pause()
    setLevels({ left: -60, right: -60 })
  }, [video])

  const start = useCallback(async () => {
    const element = video.current
    if (!element) return
    setError(null)
    setPreparing(true)
    const at = useCompose.getState().playhead
    const first = await fetchChunk(at)
    setPreparing(false)
    if (!first || !alive.current) return

    chunk.current = first
    ahead.current = null
    element.src = first.url
    element.currentTime = 0
    try {
      await element.play()
      setPlaying(true)
      void prefetch(first.at + first.span)
    } catch (problem) {
      setError((problem as Error).message)
    }
  }, [fetchChunk, prefetch, video])

  /** Кусок доиграл — подставляем следующий, если он готов. */
  const onEnded = useCallback(async () => {
    const element = video.current
    if (!element) return
    const current = chunk.current
    const nextAt = current ? current.at + current.span : 0

    let next = ahead.current
    if (!next) {
      setPreparing(true)
      next = await fetchChunk(nextAt)
      setPreparing(false)
    }
    if (!next || !alive.current) {
      stop()
      return
    }
    chunk.current = next
    ahead.current = null
    element.src = next.url
    element.currentTime = 0
    await element.play().catch(() => stop())
    void prefetch(next.at + next.span)
  }, [fetchChunk, prefetch, stop, video])

  /** Пока играет — двигаем иглу и снимаем уровень. */
  useEffect(() => {
    if (!playing) return
    const element = video.current
    if (!element) return

    // Граф собираем один раз на элемент: повторный вызов браузер запрещает.
    if (!audio.current) {
      try {
        const ctx = new AudioContext()
        const source = ctx.createMediaElementSource(element)
        const splitter = ctx.createChannelSplitter(2)
        const left = ctx.createAnalyser()
        const right = ctx.createAnalyser()
        left.fftSize = 1024
        right.fftSize = 1024
        const gain = ctx.createGain()
        source.connect(splitter)
        splitter.connect(left, 0)
        splitter.connect(right, 1)
        source.connect(gain)
        gain.connect(ctx.destination)
        audio.current = { ctx, gain, left, right }
      } catch {
        // Без звукового графа просмотр всё равно работает — не будет только
        // шкалы уровня.
      }
    }
    void audio.current?.ctx.resume()
    if (audio.current) audio.current.gain.gain.value = volume

    const buffer = new Float32Array(1024)
    const read = (node: AnalyserNode): number => {
      node.getFloatTimeDomainData(buffer)
      let sum = 0
      for (const value of buffer) sum += value * value
      const rms = Math.sqrt(sum / buffer.length)
      return rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60
    }

    // Обычный таймер, а не кадры отрисовки: в свёрнутом окне кадры не
    // приходят вовсе, и игла замирала бы вместе с показаниями.
    const timer = setInterval(() => {
      const current = chunk.current
      if (current) useCompose.getState().setPlayhead(current.at + element.currentTime)
      if (audio.current) {
        setLevels({ left: read(audio.current.left), right: read(audio.current.right) })
      }
    }, 60)
    return () => clearInterval(timer)
  }, [playing, volume, video])

  // Громкость прослушивания меняется на ходу и запоминается.
  useEffect(() => {
    if (audio.current) audio.current.gain.gain.value = volume
    localStorage.setItem('sgh.composeVolume', String(volume))
  }, [volume])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      void audio.current?.ctx.close()
      audio.current = null
    }
  }, [])

  return { playing, preparing, error, levels, volume, setVolume, start, stop, onEnded }
}
