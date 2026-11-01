import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, ChevronDown, Download, Pause, Play, RefreshCw, Scissors, SkipBack } from 'lucide-react'
import { api } from '../lib/api'
import { humanDuration, timecode } from '../lib/format'
import { loadPrefs, savePrefs } from '../lib/prefs'
import type { FilmstripInfo, ResolvedLink } from '../lib/types'
import { useStore } from '../store'
import { Timeline } from './Timeline'
import { VolumeControl } from './VolumeControl'
import { Button, Dropdown, IconButton, Modal, Spinner } from './ui'

/** Ключ громкости общий с плеером медиатеки: настраивают её один раз. */
const VOLUME_KEY = 'sgh.volume'

type Trim = { in: number | null; out: number | null }

/**
 * Разметка одной ссылки — живёт дольше окна. Разбор ссылки, кадры и волна
 * готовятся долго, поэтому закрытое окно их не бросает: открыли ту же ссылку
 * снова — всё на месте, вместе с метками и местом просмотра. Другая ссылка
 * заводит новую разметку, а недоделанное для прежней обрывается.
 */
interface Session {
  url: string
  info: ResolvedLink | null
  loading: boolean
  error: string | null
  token: string | null
  strip: FilmstripInfo | null
  stripLoading: boolean
  peaks: number[] | null
  peaksLoading: boolean
  trim: Trim
  time: number
  duration: number
  aborter: AbortController
}

let session: Session | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Правка разметки — только своей: ответ для прежней ссылки не в счёт. */
function patchSession(owner: AbortController, patch: Partial<Session>) {
  if (!session || session.aborter !== owner) return
  session = { ...session, ...patch }
  listeners.forEach((listener) => listener())
}

/** Новая разметка. keep — метки и место, когда ту же ссылку подключают заново. */
function startSession(url: string, keep?: Pick<Session, 'trim' | 'time' | 'duration'>) {
  session?.aborter.abort()
  const aborter = new AbortController()
  const { signal } = aborter
  session = {
    url,
    info: null,
    loading: true,
    error: null,
    token: null,
    strip: null,
    stripLoading: false,
    peaks: null,
    peaksLoading: false,
    trim: keep?.trim ?? { in: null, out: null },
    time: keep?.time ?? 0,
    duration: keep?.duration ?? 0,
    aborter,
  }
  listeners.forEach((listener) => listener())
  const set = (patch: Partial<Session>) => patchSession(aborter, patch)

  api
    .resolveLink(url, signal)
    .then((info) => {
      // Запомненное качество предпросмотра, если у ссылки такое есть.
      const wanted = loadPrefs().previewHeight
      const same = info.previewOptions?.find((item) => item.height === wanted)
      set({
        info,
        loading: false,
        token: same?.token ?? info.previewToken ?? null,
        duration: session?.duration || info.duration || 0,
      })
      // Кадры и волна на дорожках — их программа строит по ссылке, не
      // скачивая ролик: кадры — отдельными переходами по потоку, волну — по
      // потоку одного звука. Пока готовятся, на дорожках заглушка.
      if (!info.previewToken) return
      set({ stripLoading: true })
      api
        .streamStrip(info.previewToken, signal)
        .then((strip) => set({ strip, stripLoading: false }))
        .catch(() => set({ strip: null, stripLoading: false }))
      // Отдельного потока звука нет — волну строим по самому ролику, но только
      // у коротких: иначе ради неё пришлось бы тянуть весь файл.
      const sound = info.audioToken ?? ((info.duration ?? 0) <= 600 ? info.previewToken : null)
      if (!sound) return
      set({ peaksLoading: true })
      api
        .streamWaveform(sound, signal)
        .then((data) => set({ peaks: data.peaks, peaksLoading: false }))
        .catch(() => set({ peaks: null, peaksLoading: false }))
    })
    .catch((err) => set({ error: (err as Error).message, loading: false }))
}

/**
 * Просмотр видео по ссылке до скачивания.
 *
 * Поток идёт через наш прокси, поэтому обычный тег <video> его открывает и
 * умеет перематывать. Пользователь размечает отрезок метками In/Out — и
 * скачивается только он, а не вся серия целиком.
 */
export function LinkPreview({
  url,
  open,
  onClose,
  onApply,
  options = {},
}: {
  url: string
  open: boolean
  onClose: () => void
  onApply: (start: number | null, end: number | null) => void
  /** Настройки скачивания из колонки справа: качество, формат, кодек, пресет. */
  options?: Record<string, unknown>
}) {
  const toast = useStore((state) => state.toast)
  const revealQueue = useStore((state) => state.revealQueue)

  const videoRef = useRef<HTMLVideoElement>(null)
  // Звук качества, где картинка идёт без него: играет рядом с видео.
  const audioRef = useRef<HTMLAudioElement>(null)
  const current = useSyncExternalStore(subscribe, () => session)
  const live = current && current.url === url ? current : null
  // Правка всегда уходит в разметку этой ссылки, какая она сейчас: обработчик
  // клавиш живёт с открытия окна, когда разметки могло ещё не быть.
  const urlRef = useRef(url)
  urlRef.current = url
  const set = useCallback((patch: Partial<Session>) => {
    if (session && session.url === urlRef.current) patchSession(session.aborter, patch)
  }, [])
  const info = live?.info ?? null
  const loading = live?.loading ?? false
  const error = live?.error ?? null
  const token = live?.token ?? null
  const strip = live?.strip ?? null
  const stripLoading = live?.stripLoading ?? false
  const peaks = live?.peaks ?? null
  const peaksLoading = live?.peaksLoading ?? false
  const trim = live?.trim ?? { in: null, out: null }
  const time = live?.time ?? 0
  const duration = live?.duration ?? 0
  const option = info?.previewOptions?.find((item) => item.token === token)
  // Картинка без звука: звук играет отдельным потоком, видео молчит.
  const separate = Boolean(option?.separate && info?.audioToken)
  const setError = (value: string | null) => set({ error: value })
  const setTrim = (value: Trim) => set({ trim: value })
  const setTime = (value: number) => set({ time: value })
  const setDuration = (value: number) => set({ duration: value })
  const setToken = (value: string) => set({ token: value })
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  // Громкость общая с плеером медиатеки — человек настраивает её один раз.
  const [volume, setVolume] = useState(
    () => Number(localStorage.getItem(VOLUME_KEY) ?? '1') || 0,
  )
  const [busy, setBusy] = useState(false)
  // Куда вернуться, когда поток открылся заново: после смены качества,
  // переподключения или повторного открытия окна.
  const resume = useRef<{ at: number; play: boolean } | null>(null)

  // Открыли окно: та же ссылка — разметка уже есть, другая — новая.
  useEffect(() => {
    // Закрытое окно уносит с собой видео — а с ним и воспроизведение.
    if (!open) setPlaying(false)
    if (!open || !url) return
    if (!session || session.url !== url) startSession(url)
    resume.current = { at: session?.time ?? 0, play: false }
  }, [open, url])

  /** Разбирает ссылку заново — метки и место просмотра остаются. */
  const reconnect = () => {
    const at = videoRef.current?.currentTime ?? time
    resume.current = { at, play: false }
    startSession(url, { trim, time: at, duration })
  }

  const seek = useCallback((value: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.max(0, Math.min(value, video.duration || value))
    setTime(video.currentTime)
  }, [])

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void video.play().catch((err: Error) => {
        // Прерванный запуск — не поломка, а обычная гонка при переключении.
        if (err?.name === 'AbortError') return
        setError('Поток не проигрывается')
      })
    }
    else video.pause()
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const audio = audioRef.current
    video.volume = muted ? 0 : volume
    video.muted = muted || separate
    if (audio) {
      audio.volume = muted ? 0 : volume
      audio.muted = muted
    }
  }, [volume, muted, info, separate])

  /** Ставит отдельный звук туда же, где картинка, и в то же состояние. */
  const syncSound = (force = false) => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video || !audio || !separate) return
    // Мелкое расхождение не трогаем: каждая перестановка звука — щелчок.
    if (force || Math.abs(audio.currentTime - video.currentTime) > 0.2) audio.currentTime = video.currentTime
    if (video.paused || video.readyState < 3) audio.pause()
    else if (audio.paused) void audio.play().catch(() => undefined)
  }

  const ensureTrim = (total: number) => {
    if (total > 0 && trim.in === null && trim.out === null) setTrim({ in: 0, out: total })
  }

  // Те же клавиши, что и в медиатеке: размечают одинаково, значит и
  // управляться должны одинаково. Свежие значения берём из ссылки —
  // обработчик на window иначе застрянет на первом рендере.
  const stateRef = useRef({ time: 0, duration: 0, trim })
  stateRef.current = { time, duration, trim }

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const now = stateRef.current
      switch (event.code) {
        case 'Space':
          event.preventDefault()
          togglePlay()
          break
        case 'KeyI':
          event.preventDefault()
          setTrim({ ...now.trim, in: Math.min(now.time, now.trim.out ?? now.duration) })
          break
        case 'KeyO':
          event.preventDefault()
          setTrim({ ...now.trim, out: Math.max(now.time, now.trim.in ?? 0) })
          break
        case 'KeyM':
          setMuted((value) => !value)
          break
        case 'ArrowLeft':
          event.preventDefault()
          seek(now.time - (event.shiftKey ? 5 : 1))
          break
        case 'ArrowRight':
          event.preventDefault()
          seek(now.time + (event.shiftKey ? 5 : 1))
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seek])

  /** Скачивает лёгкую копию целиком — для сайтов, чей поток браузер не открыл. */
  async function downloadDraft() {
    setBusy(true)
    try {
      await api.download({
        items: [{ url }],
        mode: 'video',
        max_height: 360,
      })
      toast('Черновик добавлен в очередь — потом разметьте его в медиатеке', 'ok')
      revealQueue()
      onClose()
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function downloadSection() {
    setBusy(true)
    try {
      await api.download({
        max_height: 0,
        ...options,
        items: [{ url, start: trim.in, end: trim.out }],
        mode: 'video',
      })
      toast('Отрезок добавлен в очередь скачивания', 'ok')
      revealQueue()
      onClose()
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const canPreview = Boolean(info?.previewToken)
  const selection =
    trim.in !== null && trim.out !== null ? Math.max(trim.out - trim.in, 0) : null
  const cutting =
    (trim.in !== null && trim.in > 0.05) || (trim.out !== null && duration > 0 && trim.out < duration - 0.05)
  const qualities = info?.previewOptions ?? []
  const shownHeight = qualities.find((item) => item.token === token)?.height ?? info?.previewHeight ?? 0

  const changeVolume = (value: number) => {
    setVolume(value)
    setMuted(value === 0)
    localStorage.setItem(VOLUME_KEY, String(value))
  }

  // Панель над таймлайном — как в медиатеке: слева время и метки,
  // посередине просмотр, справа качество предпросмотра.
  const left = (
    <>
      <span className="shrink-0 cursor-text select-text font-mono text-[11px] tabular-nums text-ink-dim">
        {timecode(time, true)}
        <span className="text-ink-faint"> / {timecode(duration)}</span>
      </span>
      <span className="mx-0.5 h-4 w-px shrink-0 bg-line-soft" />
      <IconButton
        className="h-7 w-7"
        onClick={() => setTrim({ ...trim, in: Math.min(time, trim.out ?? duration) })}
        title={`Метка начала (I)${trim.in !== null ? ` — сейчас ${timecode(trim.in, true)}` : ''}`}
      >
        <span className="text-[12px] font-bold text-accent-soft">I</span>
      </IconButton>
      <IconButton
        className="h-7 w-7"
        onClick={() => setTrim({ ...trim, out: Math.max(time, trim.in ?? 0) })}
        title={`Метка конца (O)${trim.out !== null ? ` — сейчас ${timecode(trim.out, true)}` : ''}`}
      >
        <span className="text-[12px] font-bold text-accent-soft">O</span>
      </IconButton>
      {selection !== null && (
        <button
          type="button"
          onClick={() => setTrim({ in: 0, out: duration })}
          title="Длина отрезка. Нажмите, чтобы вернуть метки на края ролика"
          className={`flex h-7 shrink-0 items-center gap-1 px-2 font-mono text-[11px] tabular-nums ${
            cutting ? 'bg-accent/15 text-accent-soft hover:bg-accent/25' : 'text-ink-faint hover:bg-surface-3 hover:text-ink-dim'
          }`}
        >
          <Scissors size={11} />
          {timecode(selection, true)}
        </button>
      )}
    </>
  )
  const center = (
    <>
      <IconButton className="h-7 w-7" onClick={() => seek(trim.in ?? 0)} title="К началу отрезка">
        <SkipBack size={14} />
      </IconButton>
      <IconButton className="h-7 w-7" onClick={togglePlay} active={playing} title="Воспроизведение / пауза (Пробел)">
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </IconButton>
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
        value={Math.round((muted ? 0 : volume) * 100)}
        onChange={(event) => changeVolume(Number(event.target.value) / 100)}
        title="Громкость просмотра"
        className="ml-0.5 hidden w-[72px] @[700px]:block"
      />
    </>
  )
  const right = (
    <>
    <IconButton
      className="h-7 w-7"
      onClick={reconnect}
      title="Подключиться заново: ссылка разберётся ещё раз, метки останутся. Если поток оборвался или застыл"
    >
      <RefreshCw size={13} />
    </IconButton>
    {shownHeight ? (
    <Dropdown
      value={token ?? ''}
      align="right"
      options={qualities.map((item) => ({ value: item.token, label: `${item.height}p` }))}
      onChange={(next) => {
        const video = videoRef.current
        resume.current = { at: video?.currentTime ?? time, play: Boolean(video && !video.paused) }
        setToken(next)
        const picked = qualities.find((item) => item.token === next)
        if (picked) savePrefs({ previewHeight: picked.height })
      }}
      className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] text-ink-dim hover:bg-surface-3 hover:text-ink"
    >
      <span
        title={
          qualities.length > 1
            ? 'Качество предпросмотра. Скачается всё равно то качество, что выбрано справа'
            : 'Других качеств предпросмотра сайт не даёт'
        }
        className="font-mono tabular-nums"
      >
        {shownHeight}p
      </span>
      {qualities.length > 1 && <ChevronDown size={12} className="text-ink-faint" />}
    </Dropdown>
    ) : null}
    </>
  )

  return (
    <Modal open={open} onClose={onClose} title="Разметка до скачивания" wide>
      {loading && (
        <div className="flex items-center justify-center gap-3 py-16 text-ink-dim">
          <Spinner size={18} />
          Разбираю ссылку…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2.5 rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-3 text-[12.5px] leading-relaxed text-danger">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 select-text">{error}</span>
          <Button className="-my-1 shrink-0" onClick={reconnect}>
            <RefreshCw size={13} />
            Подключиться заново
          </Button>
        </div>
      )}

      {info && (
        <div className="space-y-4">
          <div>
            <p className="text-[14px] font-medium">{info.title}</p>
            <p className="mt-0.5 text-[11.5px] text-ink-faint">
              {[info.uploader, info.extractor, humanDuration(info.duration)]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>

          {canPreview ? (
            <>
              <div className="relative flex min-h-[220px] items-center justify-center overflow-hidden rounded-xl bg-black">
                <video
                  ref={videoRef}
                  src={`/api/stream/${token ?? info.previewToken}`}
                  className="max-h-[46vh] max-w-full"
                  onLoadedMetadata={(event) => {
                    const total = event.currentTarget.duration || info.duration || 0
                    setDuration(total)
                    ensureTrim(total)
                    // Сменили качество — продолжаем с того же места.
                    const back = resume.current
                    if (back) {
                      resume.current = null
                      event.currentTarget.currentTime = back.at
                      if (back.play) void event.currentTarget.play().catch(() => undefined)
                    }
                  }}
                  onTimeUpdate={(event) => {
                    setTime(event.currentTarget.currentTime)
                    syncSound()
                  }}
                  onPlay={() => {
                    setPlaying(true)
                    syncSound(true)
                  }}
                  onPause={() => {
                    setPlaying(false)
                    syncSound()
                  }}
                  onPlaying={() => syncSound(true)}
                  onWaiting={() => audioRef.current?.pause()}
                  onSeeked={() => syncSound(true)}
                  onError={() =>
                    setError('Источник оборвал поток. Подключитесь заново или скачайте черновик.')
                  }
                  onClick={togglePlay}
                  playsInline
                />
                {separate && (
                  <audio
                    ref={audioRef}
                    src={`/api/stream/${info.audioToken}`}
                    preload="auto"
                    onLoadedMetadata={() => syncSound(true)}
                  />
                )}
              </div>

              <div className="-mx-5 border-b border-line-soft">
                <Timeline
                  toolbar={{ left, center, right }}
                  duration={duration}
                  currentTime={time}
                  inPoint={trim.in}
                  outPoint={trim.out}
                  onSeek={seek}
                  onChangeIn={(value) => setTrim({ ...trim, in: value })}
                  onChangeOut={(value) => setTrim({ ...trim, out: value })}
                  strip={strip}
                  stripLoading={stripLoading}
                  peaks={peaks}
                  peaksLoading={peaksLoading}
                  hasVideo
                  hasAudio
                  playing={playing}
                />
              </div>

              <div className="flex gap-2">
                <Button
                  tone="primary"
                  className="flex-1 py-2.5"
                  disabled={busy}
                  onClick={() => void downloadSection()}
                >
                  <Download size={15} />
                  Скачать отрезок
                </Button>
                <Button
                  onClick={() => {
                    onApply(trim.in, trim.out)
                    onClose()
                  }}
                  disabled={busy}
                >
                  Перенести тайминги в список
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-2.5 rounded-xl border border-warn/35 bg-warn/10 px-3.5 py-3 text-[12.5px] leading-relaxed text-warn">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>{info.previewNote ?? 'Предпросмотр для этой ссылки недоступен.'}</span>
              </div>
              <Button
                tone="primary"
                className="w-full py-2.5"
                disabled={busy}
                onClick={() => void downloadDraft()}
              >
                <Download size={15} />
                Скачать черновик 360p для разметки
              </Button>
              <p className="text-[11px] leading-relaxed text-ink-faint">
                Лёгкая копия целиком: откройте её в медиатеке, разметьте отрезок в обычном
                редакторе, а потом вернитесь сюда и скачайте нужный кусок в полном качестве —
                или просто сожмите черновик, если качества хватает.
              </p>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
