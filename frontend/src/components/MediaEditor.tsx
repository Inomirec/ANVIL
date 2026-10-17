import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Camera,
  Maximize2,
  Pause,
  Play,
  Repeat,
  Scissors,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { api, mediaUrl } from '../lib/api'
import { humanSize, timecode } from '../lib/format'
import { cutTimes, frameCode, useScenes } from '../lib/scenes'
import type { FileInfo, FilmstripInfo } from '../lib/types'
import { useStore } from '../store'
import { useZoomPan } from '../lib/zoomPan'
import { Timeline, type Fades } from './Timeline'
import { VolumeControl } from './VolumeControl'
import { IconButton } from './ui'

export interface TrimState {
  in: number | null
  out: number | null
}

const VOLUME_KEY = 'sgh.volume'

/**
 * Во сколько раз приглушить дорожку в конкретный момент.
 *
 * Возвращает 1 в середине отрезка и плавно уходит в 0 на краях. Кривая
 * четвертьсинусоидная — та же, что применяется при экспорте, поэтому
 * предпросмотр совпадает с результатом.
 */
function fadeGain(
  time: number,
  from: number,
  to: number,
  fadeIn: number,
  fadeOut: number,
): number {
  let gain = 1
  if (fadeIn > 0 && time < from + fadeIn) {
    gain = Math.min(gain, Math.max((time - from) / fadeIn, 0))
  }
  if (fadeOut > 0 && time > to - fadeOut) {
    gain = Math.min(gain, Math.max((to - time) / fadeOut, 0))
  }
  return Math.sin((Math.PI / 2) * Math.min(Math.max(gain, 0), 1))
}

/** Плеер с таймлайном и метками In/Out для видео и аудио. */
export function MediaEditor({
  file,
  trim,
  onTrimChange,
  fades,
  onFadesChange,
  trackVolume,
  onTrackVolumeChange,
}: {
  file: FileInfo
  trim: TrimState
  onTrimChange: (trim: TrimState) => void
  fades: Fades
  onFadesChange: (fades: Fades) => void
  /** Громкость дорожки в результате — не громкость предпросмотра. */
  trackVolume: number
  onTrackVolumeChange: (volume: number) => void
}) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null)

  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(file.media?.duration ?? 0)
  const [volume, setVolume] = useState(() => Number(localStorage.getItem(VOLUME_KEY) ?? '1'))
  const [muted, setMuted] = useState(false)
  const [loopSelection, setLoopSelection] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [peaksLoading, setPeaksLoading] = useState(false)
  const [strip, setStrip] = useState<FilmstripInfo | null>(null)
  const [stripLoading, setStripLoading] = useState(false)
  const [grabbing, setGrabbing] = useState(false)
  // Насколько затемнить картинку прямо сейчас — показываем затухание вживую.
  const [dim, setDim] = useState(0)

  const toast = useStore((state) => state.toast)
  const revealQueue = useStore((state) => state.revealQueue)

  const isVideo = file.kind === 'video'
  // Колесо над кадром приближает его, зажатое колесо таскает: мелкую надпись
  // или край кадра иначе не разглядеть. На готовый файл не влияет.
  const zoom = useZoomPan(file.path, isVideo ? 8 : 1, isVideo ? 0.4 : 1)

  /**
   * Метки должны существовать сразу, а не появляться после нажатия I/O:
   * как только известна длительность, ставим их на края файла — тогда
   * ползунки видно на таймлайне с первого кадра и их можно просто тянуть.
   */
  const ensureTrim = useCallback(
    (total: number) => {
      if (total > 0 && trim.in === null && trim.out === null) {
        onTrimChange({ in: 0, out: total })
      }
    },
    [trim.in, trim.out, onTrimChange],
  )

  // ensureTrim пересоздаётся при каждом изменении меток, и если держать его
  // в зависимостях эффекта ниже, тот срабатывает на любое движение границы
  // и сбрасывает время на ноль — игла прыгает в начало прямо во время
  // разметки. Держим функцию в ссылке: эффект должен реагировать только
  // на смену файла.
  const ensureTrimRef = useRef(ensureTrim)
  ensureTrimRef.current = ensureTrim

  // При смене файла сбрасываем состояние плеера, но не трогаем метки:
  // ими управляет родитель, который сам обнуляет их при выборе другого файла.
  useEffect(() => {
    setTime(0)
    setPlaying(false)
    setError(null)
    const total = file.media?.duration ?? 0
    setDuration(total)
    ensureTrimRef.current(total)
  }, [file.path, file.media?.duration])

  // Осциллограмму считает бэкенд и кэширует на диске: во второй раз она
  // появляется мгновенно. Пока считается — на дорожке видна заглушка.
  useEffect(() => {
    if (!file.media?.hasAudio) {
      setPeaks(null)
      return
    }
    let cancelled = false
    setPeaks(null)
    setPeaksLoading(true)
    api
      .waveform(file.path)
      .then((data) => {
        if (!cancelled) setPeaks(data.peaks ?? null)
      })
      .catch(() => {
        // Волна — украшение, а не функциональность: молча остаёмся без неё.
        if (!cancelled) setPeaks(null)
      })
      .finally(() => {
        if (!cancelled) setPeaksLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [file.path, file.media?.hasAudio])

  // Лента кадров для верхней дорожки — её тоже готовит и кэширует бэкенд.
  useEffect(() => {
    if (file.kind !== 'video') {
      setStrip(null)
      return
    }
    let cancelled = false
    setStrip(null)
    setStripLoading(true)
    api
      .filmstrip(file.path)
      .then((data) => {
        if (!cancelled) setStrip(data)
      })
      .catch(() => {
        if (!cancelled) setStrip(null)
      })
      .finally(() => {
        if (!cancelled) setStripLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [file.path, file.kind])

  /** Держит громкость и затемнение в соответствии с нарисованными затуханиями. */
  const applyFades = useCallback(
    (media: HTMLVideoElement | HTMLAudioElement, at: number) => {
      const from = trim.in ?? 0
      const to = trim.out ?? duration ?? 0
      const audioGain = fadeGain(at, from, to, fades.audio.in, fades.audio.out)
      media.volume = muted ? 0 : volume * audioGain
      setDim(1 - fadeGain(at, from, to, fades.video.in, fades.video.out))
    },
    [trim.in, trim.out, duration, fades, volume, muted],
  )

  useEffect(() => {
    const media = mediaRef.current
    if (!media) return
    media.muted = muted
    applyFades(media, media.currentTime)
  }, [volume, muted, file.path, applyFades])

  // Игла стоит на кадре, а не между кадрами: так можно попасть ровно в
  // последний кадр сцены. Плееру отдаём чуть позже начала кадра — ровно на
  // границе он иногда показывает предыдущий.
  const fps = isVideo ? file.media?.fps || 30 : 100
  const frameOf = useCallback((value: number) => Math.floor(value * fps + 1e-3) / fps, [fps])
  const seek = useCallback(
    (value: number) => {
      const media = mediaRef.current
      if (!media) return
      const end = media.duration || value
      const target = Math.min(Math.max(Math.round(value * fps) / fps, 0), end)
      media.currentTime = Math.min(target + 0.25 / fps, end)
      setTime(target)
    },
    [fps],
  )

  const togglePlay = useCallback(() => {
    const media = mediaRef.current
    if (!media) return
    if (media.paused) {
      // Зацикленный предпросмотр всегда стартует с точки In.
      if (loopSelection && trim.in !== null && (media.currentTime < trim.in || (trim.out !== null && media.currentTime >= trim.out))) {
        media.currentTime = trim.in
      }
      void media.play().catch((err) => {
        // AbortError — не поломка: так плеер отвечает, когда воспроизведение
        // прервали раньше, чем оно успело начаться (переключили файл, нажали
        // паузу). Показывать это человеку незачем.
        if ((err as Error)?.name === 'AbortError') return
        setError(String(err))
      })
    } else {
      media.pause()
    }
  }, [loopSelection, trim.in, trim.out])

  const nudge = useCallback(
    (delta: number) => {
      const media = mediaRef.current
      if (!media) return
      seek(frameOf(media.currentTime) + delta)
    },
    [seek, frameOf],
  )

  // Склейки ролика: Shift со стрелкой шагает к соседней смене сцены.
  const scenes = useScenes(isVideo ? file.path : null, isVideo)
  const toScene = useCallback(
    (forward: boolean) => {
      const media = mediaRef.current
      if (!media) return
      const here = frameOf(media.currentTime)
      const half = 0.5 / fps
      const points = [
        0,
        ...(scenes ? cutTimes(scenes) : []).map((at) => Math.ceil(at * fps - 1e-3) / fps),
        ...(trim.in !== null ? [trim.in] : []),
        ...(trim.out !== null ? [trim.out] : []),
        media.duration || duration,
      ].sort((a, b) => a - b)
      const next = forward
        ? points.find((at) => at > here + half)
        : [...points].reverse().find((at) => at < here - half)
      if (next !== undefined) seek(next)
    },
    [scenes, fps, frameOf, seek, trim.in, trim.out, duration],
  )

  const setIn = useCallback(() => {
    const media = mediaRef.current
    if (!media) return
    const value = frameOf(media.currentTime)
    const total = media.duration || duration
    // Если новая метка начала оказалась правее конца — отодвигаем конец в хвост,
    // иначе выделение схлопнулось бы в ноль.
    const end = trim.out !== null && trim.out <= value ? total : trim.out
    onTrimChange({ in: value, out: end ?? total })
  }, [onTrimChange, trim.out, duration, frameOf])

  const setOut = useCallback(() => {
    const media = mediaRef.current
    if (!media) return
    const value = frameOf(media.currentTime)
    const start = trim.in !== null && trim.in >= value ? 0 : trim.in
    onTrimChange({ in: start ?? 0, out: value })
  }, [onTrimChange, trim.in, frameOf])

  /** Сохраняет текущий кадр картинкой как есть — для вопросов-угадаек. */
  const grabFrame = useCallback(async () => {
    const media = mediaRef.current
    if (!media || !isVideo) return
    setGrabbing(true)
    try {
      await api.exportFrame({ source: file.path, time: media.currentTime })
      toast('Кадр сохранён — без сжатия, в том же качестве, что в видео', 'ok')
      revealQueue()
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setGrabbing(false)
    }
  }, [file.path, isVideo, toast, revealQueue])

  // Горячие клавиши работают, пока фокус не в поле ввода.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      // Стрелки: на кадр; со Shift — к соседней склейке или метке; с Ctrl —
      // на 5 секунд.
      if ((event.code === 'ArrowLeft' || event.code === 'ArrowRight') && !event.altKey && !event.metaKey) {
        event.preventDefault()
        const forward = event.code === 'ArrowRight'
        if (event.ctrlKey) nudge(forward ? 5 : -5)
        else if (event.shiftKey) toScene(forward)
        else nudge((forward ? 1 : -1) / fps)
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return

      switch (event.code) {
        case 'Space':
          event.preventDefault()
          togglePlay()
          break
        case 'KeyI':
          event.preventDefault()
          setIn()
          break
        case 'KeyO':
          event.preventDefault()
          setOut()
          break
        case 'KeyL':
          setLoopSelection((value) => !value)
          break
        case 'KeyS':
          event.preventDefault()
          void grabFrame()
          break
        case 'KeyM':
          setMuted((value) => !value)
          break
        case 'Home':
          seek(0)
          break
        case 'End':
          seek(duration)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, setIn, setOut, nudge, seek, duration, grabFrame, toScene, fps])

  const onTimeUpdate = () => {
    const media = mediaRef.current
    if (!media) return
    // Зацикливание выделенного отрезка — предпросмотр будущего среза.
    if (loopSelection && trim.out !== null && media.currentTime >= trim.out) {
      media.currentTime = trim.in ?? 0
      return
    }
    setTime(frameOf(media.currentTime))
    applyFades(media, media.currentTime)
  }

  const media = file.media
  const selectionLength =
    trim.in !== null || trim.out !== null
      ? (trim.out ?? duration) - (trim.in ?? 0)
      : null

  const details = [
    humanSize(file.size),
    media?.width ? `${media.width}×${media.height}${media.fps ? ` · ${media.fps.toFixed(media.fps % 1 ? 2 : 0)} кадров/с` : ''}` : '',
    media?.videoCodec ? `Видео ${codecName(media.videoCodec)}${media.videoBitRate ? ` · ${kbps(media.videoBitRate)}` : ''}` : '',
    media?.audioCodec
      ? `Звук ${codecName(media.audioCodec)}${media.audioChannels ? ` · ${channelsName(media.audioChannels)}` : ''}${media.audioBitRate ? ` · ${kbps(media.audioBitRate)}` : ''}`
      : '',
  ].filter(Boolean)

  // Панель плеера — над таймлайном, как в монтаже. Всё в одну строку и
  // ничего не прячется на узком окне: скорость просмотра убрана, громкость
  // ползунком всплывает над значком.
  const toolbar = (
    <>
      <IconButton onClick={togglePlay} active={playing} title="Воспроизведение / пауза (Пробел)">
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </IconButton>
      <span className="shrink-0 cursor-text select-text font-mono text-[11px] tabular-nums text-ink-dim">
        <span title={isVideo ? 'Минуты, секунды и номер кадра в секунде' : undefined}>
          {isVideo ? frameCode(time, fps) : timecode(time, true)}
        </span>
        <span className="text-ink-faint"> / {timecode(duration)}</span>
      </span>

      <span className="mx-0.5 h-4 w-px shrink-0 bg-line-soft" />

      <IconButton onClick={setIn} title={`Метка начала (I)${trim.in !== null ? ` — сейчас ${timecode(trim.in, true)}` : ''}`}>
        <span className="text-[12px] font-bold text-accent-soft">I</span>
      </IconButton>
      <IconButton onClick={setOut} title={`Метка конца (O)${trim.out !== null ? ` — сейчас ${timecode(trim.out, true)}` : ''}`}>
        <span className="text-[12px] font-bold text-accent-soft">O</span>
      </IconButton>
      {selectionLength !== null && (
        <button
          type="button"
          onClick={() => onTrimChange({ in: 0, out: duration })}
          title={`Отрезок ${timecode(trim.in ?? 0, true)} → ${timecode(trim.out ?? duration, true)}. Нажмите, чтобы вернуть метки на края файла`}
          className="flex h-7 shrink-0 items-center gap-1 bg-accent/15 px-2 font-mono text-[11px] tabular-nums text-accent-soft hover:bg-accent/25"
        >
          <Scissors size={11} />
          {timecode(Math.max(selectionLength, 0), true)}
        </button>
      )}
      <IconButton
        onClick={() => setLoopSelection((value) => !value)}
        active={loopSelection}
        title="Зациклить выделение (L)"
      >
        <Repeat size={14} />
      </IconButton>
      {isVideo && (
        <IconButton
          onClick={() => void grabFrame()}
          disabled={grabbing}
          title="Сохранить текущий кадр картинкой (S)"
        >
          <Camera size={14} />
        </IconButton>
      )}

      <span className="ml-auto" />
      <VolumeControl
        volume={volume}
        muted={muted}
        onMute={() => setMuted((value) => !value)}
        onChange={(value) => {
          setVolume(value)
          setMuted(value === 0)
          localStorage.setItem(VOLUME_KEY, String(value))
        }}
      />
      {isVideo && (
        <IconButton
          onClick={() => {
            const element = mediaRef.current
            if (document.fullscreenElement) void document.exitFullscreen()
            else void element?.requestFullscreen?.()
          }}
          title="Полный экран"
        >
          <Maximize2 size={14} />
        </IconButton>
      )}
      <span className="mx-0.5 h-4 w-px shrink-0 bg-line-soft" />
    </>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Область просмотра — без рамок и скруглений, как в монтаже. */}
      <div
        ref={zoom.shell}
        onMouseDown={zoom.onMouseDown}
        // Вокруг кадра — цвет окна, у самого кадра — чёрный фон и рамка: иначе
        // у вертикального ролика не понять, где кончается видео, а где поле.
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-surface-2/60 p-4"
      >
        {zoom.view !== 1 && (
          <button
            type="button"
            onClick={zoom.reset}
            title="Масштаб просмотра — на готовый файл не влияет. Нажмите, чтобы вернуть обычный размер."
            className="absolute right-3 top-3 z-10 bg-accent/25 px-2 py-1 font-mono text-[11px] tabular-nums text-accent-soft backdrop-blur hover:bg-accent/35"
          >
            {Math.round(zoom.view * 100)}%
          </button>
        )}
        {!file.playable && (
          <div className="absolute inset-x-0 top-0 z-10 bg-warn/15 px-4 py-2 text-center text-[12px] text-warn">
            Формат «.{file.ext}» не показывается в предпросмотре. Обработать файл
            можно и так — или сначала перегнать его пресетом «Конвертация в H.264».
          </div>
        )}

        {isVideo ? (
          <video
            key={file.path}
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            src={mediaUrl(file.path)}
            className="max-h-full max-w-full bg-black shadow-xl ring-1 ring-line"
            // Затухание картинки — потемнением самого кадра: вуаль поверх
            // всего окна закрасила бы и поле вокруг.
            style={{ transform: zoom.transform, filter: dim > 0.001 ? `brightness(${1 - dim})` : undefined }}
            onLoadedMetadata={(event) => {
              const total = event.currentTarget.duration || 0
              setDuration(total)
              ensureTrim(total)
            }}
            onTimeUpdate={onTimeUpdate}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={() => setError('Не удалось открыть этот файл в предпросмотре')}
            onClick={togglePlay}
            playsInline
          />
        ) : (
          <div className="flex w-full max-w-lg flex-col items-center gap-6 px-8">
            <div
              className={`flex h-28 w-28 items-center justify-center rounded-full bg-accent/12 ring-1 ring-accent/25 ${
                playing ? 'animate-pulse-soft' : ''
              }`}
            >
              <Volume2 size={40} className="text-accent-soft" />
            </div>
            <p className="max-w-full truncate text-center text-[14px] text-ink-dim">{file.name}</p>
            <audio
              key={file.path}
              ref={mediaRef as React.RefObject<HTMLAudioElement>}
              src={mediaUrl(file.path)}
              onLoadedMetadata={(event) => {
                const total = event.currentTarget.duration || 0
                setDuration(total)
                ensureTrim(total)
              }}
              onTimeUpdate={onTimeUpdate}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onError={() => setError('Не удалось открыть этот файл в предпросмотре')}
            />
          </div>
        )}

        {/* Сведения о файле — полупрозрачно в углу, как у картинок: отдельная
            строка под плеером съедала место у кадра. */}
        <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex max-w-[calc(100%-24px)] items-center gap-2.5 overflow-hidden whitespace-nowrap bg-surface/70 px-2.5 py-1 text-[11px] text-ink-faint opacity-80 ring-1 ring-line-soft backdrop-blur">
          {details.map((item) => (
            <span key={item} className="truncate">
              {item}
            </span>
          ))}
          {!media?.audioCodec && <span className="text-warn">без звуковой дорожки</span>}
        </div>

        {error && (
          <div className="absolute inset-x-0 bottom-0 bg-danger/20 px-4 py-2 text-center text-[12px] text-danger">
            {error}
          </div>
        )}
      </div>

      <Timeline
        toolbar={toolbar}
        duration={duration}
        currentTime={time}
        inPoint={trim.in}
        outPoint={trim.out}
        onSeek={seek}
        onChangeIn={(value) => onTrimChange({ ...trim, in: value })}
        onChangeOut={(value) => onTrimChange({ ...trim, out: value })}
        peaks={peaks}
        peaksLoading={peaksLoading}
        strip={strip}
        stripLoading={stripLoading}
        scenes={scenes}
        fps={isVideo ? fps : undefined}
        hasVideo={isVideo}
        hasAudio={file.media?.hasAudio ?? !isVideo}
        fades={fades}
        volume={trackVolume}
        onVolumeChange={onTrackVolumeChange}
        onFadesChange={onFadesChange}
        playing={playing}
      />
    </div>
  )
}

/** Имя кодека так, как его пишут люди, а не как ffmpeg. */
function codecName(codec: string): string {
  const names: Record<string, string> = {
    h264: 'H.264',
    hevc: 'H.265',
    av1: 'AV1',
    vp9: 'VP9',
    vp8: 'VP8',
    mpeg4: 'MPEG-4',
    aac: 'AAC',
    opus: 'Opus',
    mp3: 'MP3',
    vorbis: 'Vorbis',
    flac: 'FLAC',
    ac3: 'AC-3',
    eac3: 'E-AC-3',
  }
  return names[codec] ?? codec.toUpperCase()
}

/** Битрейт в кбит/с, с пробелом в тысячах. */
function kbps(bits: number): string {
  return `${Math.round(bits / 1000).toLocaleString('ru-RU')} кбит/с`
}

function channelsName(count: number): string {
  return count === 1 ? 'моно' : count === 2 ? 'стерео' : `${count} ${count < 5 ? 'канала' : 'каналов'}`
}
