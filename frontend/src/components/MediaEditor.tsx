import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Camera,
  Maximize2,
  Pause,
  Play,
  Repeat,
  Scissors,
  SkipBack,
  Volume2,
} from 'lucide-react'
import { api, mediaUrl } from '../lib/api'
import { humanSize, timecode } from '../lib/format'
import { loadPrefs, onPrefs } from '../lib/prefs'
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

// О формате судим по тому, открылся ли файл, а не по расширению: MKV и MOV
// окно обычно показывает, а список «понятных» расширений их отбраковывал.
const UNPLAYABLE =
  'Этот файл не открывается в предпросмотре. Обработать его можно и так — или сначала перегнать пресетом «Конвертация в H.264».'

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
  // Кадры на дорожке видео: по склейкам, редко или никак — и их качество.
  // Настройка в окне настроек, меняется на ходу.
  const [frames, setFrames] = useState(() => ({
    mode: loadPrefs().timelineFrames ?? 'scenes',
    large: loadPrefs().timelineQuality === 'high',
  }))
  useEffect(
    () =>
      onPrefs(() =>
        setFrames({ mode: loadPrefs().timelineFrames ?? 'scenes', large: loadPrefs().timelineQuality === 'high' }),
      ),
    [],
  )
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
  // Равномерная лента дешёвая (читаются только опорные кадры) и показывается,
  // пока кадры по склейкам ещё считаются; при «Без кадров» её нет вовсе.
  useEffect(() => {
    if (file.kind !== 'video' || frames.mode === 'off') {
      setStrip(null)
      setStripLoading(false)
      return
    }
    let cancelled = false
    setStrip(null)
    setStripLoading(true)
    api
      .filmstrip(file.path, frames.mode === 'sparse' && frames.large ? 80 : undefined)
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
  }, [file.path, file.kind, frames.mode, frames.large])

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
  const scenes = useScenes(isVideo ? file.path : null, isVideo && frames.mode === 'scenes', frames.large)
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

  // Сведения о файле делятся на два угла над кадром: слева сам файл, справа
  // его дорожки.
  // У звука — только вес, кодек и битрейт, справа. У MP3 с обложкой ffprobe
  // видит обложку отдельным потоком «видео», и её размер выдавался за
  // сведения о самом файле.
  const fileDetails = isVideo
    ? [
        humanSize(file.size),
        media?.width ? `${media.width}×${media.height}${media.fps ? ` · ${media.fps.toFixed(media.fps % 1 ? 2 : 0)} кадров/с` : ''}` : '',
      ].filter(Boolean)
    : []
  const audioRate = media?.audioBitRate || (!isVideo && media?.duration ? (file.size * 8) / media.duration : 0)
  const streamDetails = !isVideo
    ? [
        humanSize(file.size),
        [
          media?.audioCodec ? codecName(media.audioCodec) : file.ext.toUpperCase(),
          media?.audioChannels && media.audioChannels !== 2 ? channelsName(media.audioChannels) : '',
          audioRate ? kbps(audioRate) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ]
    : [
    media?.videoCodec ? `Видео ${codecName(media.videoCodec)}${media.videoBitRate ? ` · ${kbps(media.videoBitRate)}` : ''}` : '',
    media?.audioCodec
      ? `Звук ${codecName(media.audioCodec)}${media.audioChannels ? ` · ${channelsName(media.audioChannels)}` : ''}${media.audioBitRate ? ` · ${kbps(media.audioBitRate)}` : ''}`
      : '',
  ].filter(Boolean)

  // Панель плеера — над таймлайном и устроена как в монтаже: слева время и
  // метки, посередине просмотр (стоит по центру и не ездит), справа кадр,
  // полный экран и масштаб таймлайна. Всё в одну строку на любом окне.
  const cutting =
    (trim.in !== null && trim.in > 0.05) || (trim.out !== null && duration > 0 && trim.out < duration - 0.05)
  const left = (
    <>
      <span className="shrink-0 cursor-text select-text font-mono text-[11px] tabular-nums text-ink-dim">
        <span title={isVideo ? 'Минуты, секунды и номер кадра в секунде' : undefined}>
          {isVideo ? frameCode(time, fps) : timecode(time, true)}
        </span>
        <span className="text-ink-faint"> / {timecode(duration)}</span>
      </span>

      <span className="mx-0.5 h-4 w-px shrink-0 bg-line-soft" />

      <IconButton className="h-7 w-7" onClick={setIn} title={`Метка начала (I)${trim.in !== null ? ` — сейчас ${timecode(trim.in, true)}` : ''}`}>
        <span className="text-[12px] font-bold text-accent-soft">I</span>
      </IconButton>
      <IconButton className="h-7 w-7" onClick={setOut} title={`Метка конца (O)${trim.out !== null ? ` — сейчас ${timecode(trim.out, true)}` : ''}`}>
        <span className="text-[12px] font-bold text-accent-soft">O</span>
      </IconButton>
      {selectionLength !== null && (
        // Длина отрезка видна всегда, а выделена — только когда метки и
        // правда что-то отрезают.
        <button
          type="button"
          onClick={() => onTrimChange({ in: 0, out: duration })}
          title={`Отрезок ${timecode(trim.in ?? 0, true)} → ${timecode(trim.out ?? duration, true)}. Нажмите, чтобы вернуть метки на края файла`}
          className={`flex h-7 shrink-0 items-center gap-1 px-2 font-mono text-[11px] tabular-nums ${
            cutting ? 'bg-accent/15 text-accent-soft hover:bg-accent/25' : 'text-ink-faint hover:bg-surface-3 hover:text-ink-dim'
          }`}
        >
          <Scissors size={11} />
          {timecode(Math.max(selectionLength, 0), true)}
        </button>
      )}
    </>
  )

  const shownVolume = muted ? 0 : volume
  const changeVolume = (value: number) => {
    setVolume(value)
    setMuted(value === 0)
    localStorage.setItem(VOLUME_KEY, String(value))
  }
  const center = (
    <>
      <IconButton className="h-7 w-7" onClick={() => seek(trim.in ?? 0)} title="К началу отрезка (Home — к началу файла)">
        <SkipBack size={14} />
      </IconButton>
      <IconButton className="h-7 w-7" onClick={togglePlay} active={playing} title="Воспроизведение / пауза (Пробел)">
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </IconButton>
      <IconButton className="h-7 w-7"
        onClick={() => setLoopSelection((value) => !value)}
        active={loopSelection}
        title="Повторять отрезок по кругу (L)"
      >
        <Repeat size={14} />
      </IconButton>
      {/* Громкость просмотра — как в монтаже: есть место — обычная полоска
          рядом со значком, тесно — ползунок всплывает над значком. */}
      <VolumeControl
        small
        volume={volume}
        muted={muted}
        popupClassName="@[700px]:hidden"
        onMute={() => setMuted((value) => !value)}
        onChange={changeVolume}
      />
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(shownVolume * 100)}
        onChange={(event) => changeVolume(Number(event.target.value) / 100)}
        title={`Громкость просмотра ${Math.round(shownVolume * 100)}% — на файл не влияет`}
        className="ml-0.5 hidden w-[72px] @[700px]:block"
      />
    </>
  )

  const right = isVideo ? (
    <>
      <IconButton className="h-7 w-7"
        onClick={() => void grabFrame()}
        disabled={grabbing}
        title="Сохранить текущий кадр картинкой (S)"
      >
        <Camera size={14} />
      </IconButton>
      <IconButton className="h-7 w-7"
        onClick={() => {
          const element = mediaRef.current
          if (document.fullscreenElement) void document.exitFullscreen()
          else void element?.requestFullscreen?.()
        }}
        title="Полный экран"
      >
        <Maximize2 size={14} />
      </IconButton>
    </>
  ) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Область просмотра — без рамок и скруглений, как в монтаже. */}
      <div
        ref={zoom.shell}
        onMouseDown={zoom.onMouseDown}
        // Вокруг кадра — сцена с сеткой, у самого кадра — чёрный фон и рамка:
        // иначе у вертикального ролика не понять, где кончается видео, а где
        // поле. Сверху отступ под сведения о файле: они стоят над кадром.
        className="stage relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4 pt-9"
      >
        {zoom.view !== 1 && (
          <button
            type="button"
            onClick={zoom.reset}
            title="Масштаб просмотра — на готовый файл не влияет. Нажмите, чтобы вернуть обычный размер."
            className="absolute bottom-3 right-3 z-10 bg-accent/25 px-2 py-1 font-mono text-[11px] tabular-nums text-accent-soft backdrop-blur hover:bg-accent/35"
          >
            {Math.round(zoom.view * 100)}%
          </button>
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
            onError={() => setError(UNPLAYABLE)}
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
              onError={() => setError(UNPLAYABLE)}
            />
          </div>
        )}

        {/* Сведения о файле — мелко по углам над кадром, как у картинок:
            отдельная строка под плеером съедала место, а на самом кадре они
            мешали смотреть. */}
        <div className="pointer-events-none absolute left-3 top-2.5 z-10 flex max-w-[calc(40%-24px)] items-center gap-2.5 overflow-hidden whitespace-nowrap text-[11px] text-ink-faint">
          {fileDetails.map((item) => (
            <span key={item} className="truncate">
              {item}
            </span>
          ))}
        </div>
        <div className="pointer-events-none absolute right-3 top-2.5 z-10 flex max-w-[calc(60%-24px)] items-center gap-2.5 overflow-hidden whitespace-nowrap text-[11px] text-ink-faint">
          {streamDetails.map((item) => (
            <span key={item} className="truncate">
              {item}
            </span>
          ))}
          {isVideo && !media?.audioCodec && <span className="text-warn">без звуковой дорожки</span>}
        </div>

        {error && (
          <div className="absolute inset-x-0 bottom-0 bg-danger/20 px-4 py-2 text-center text-[12px] text-danger">
            {error}
          </div>
        )}
      </div>

      <Timeline
        toolbar={{ left, center, right }}
        framesOff={frames.mode === 'off'}
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
