import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Camera,
  ChevronDown,
  Columns2,
  Film,
  FolderOpen,
  Grid3x3,
  Loader2,
  Save,
  Play,
  RotateCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { noStraySelection } from '../lib/noSelect'
import { parentDir, timecode } from '../lib/format'
import {
  DEFAULT_IMAGE_SECONDS,
  FRAME_QUALITY,
  FRAME_RATES,
  FRAME_SHAPES,
  fpsLabel,
  hasClipsIn,
  renderSpan,
  shownAt,
  sourceFrame,
  useCompose,
  type ComposeClip,
  type ComposeTrack,
} from '../composeStore'
import { useStore } from '../store'
import { ComposeTimeline } from './ComposeTimeline'
import { ComposeFrameBox, ComposeGrid, GRIDS, type GridKind } from './ComposeFrameBox'
import { ComposeCropBox } from './ComposeCropBox'
import { ComposeMaskBox } from './ComposeMaskBox'
import { ComposeProjects } from './ComposeProjects'
import { ComposeMissing } from './ComposeMissing'
import { ComposeFrameAsk, type FrameQuestion } from './ComposeFrameAsk'
import { ComposeTextPanel } from './ComposeTextPanel'
import { ComposeFillPanel } from './ComposeFillPanel'
import { ClipAddBar, ComposeClipPanel, ComposeTrackFxPanel } from './ComposeClipPanel'
import { CROP_FIELDS, withoutGroup } from '../composeAnim'
import { ComposeTextOverlay } from './ComposeTextOverlay'
import {
  ComposeRenderPanel,
  DEFAULT_RENDER,
  bitrateForFrame,
  scaleFrame,
  type RenderSettings,
} from './ComposeRender'
import { FolderPicker } from './FolderPicker'
import { MasterMeter, METER_DEFAULT } from './MasterMeter'
import { PREVIEW_QUALITIES, useComposePlayer, type PreviewQuality } from '../hooks/useComposePlayer'
import { useVoiceRecorder } from '../hooks/useVoiceRecorder'
import { Button, Dropdown, Empty, IconButton, QuietHints, Section, Segmented, Toggle } from './ui'

/** Имя готового файла, если поле оставили пустым. */
const DEFAULT_NAME = 'Project'

/**
 * Значок занятости у курсора.
 *
 * Появляется там, куда бросили файл, и дальше едет за мышью. Начальное место
 * важно: во время перетаскивания мышь не шлёт обычных движений, и значок,
 * который ждёт первого из них, так и остаётся за краем экрана — человек видит
 * зависшее окно без единого признака работы.
 */
function BusyMark({ from, text }: { from: { x: number; y: number }; text: string }) {
  const [at, setAt] = useState(from)
  useEffect(() => {
    const move = (event: MouseEvent) => setAt({ x: event.clientX, y: event.clientY })
    window.addEventListener('mousemove', move)
    return () => window.removeEventListener('mousemove', move)
  }, [])
  return (
    <span
      className="pointer-events-none fixed z-50 flex items-center gap-1.5 rounded-lg bg-surface-3/95 px-2 py-1 text-[11px] text-ink shadow-lg ring-1 ring-line"
      style={{ left: at.x + 16, top: at.y + 16 }}
    >
      <Loader2 size={12} className="animate-spin text-accent-soft" />
      {text}
    </span>
  )
}

/**
 * Насколько увеличен экран просмотра.
 *
 * Это увеличительное стекло, а не правка монтажа: файлы остаются какими были,
 * просто кадр показан крупнее — чтобы выровнять картинку по сетке или
 * разглядеть край. Приближение самих файлов отсюда убрано: когда в кадре
 * несколько файлов, оно приближало каждый в его собственных границах, и
 * получался не наезд, а перекос.
 */
// Экран просмотра умеет и отдаляться: клип, вылезший за край кадра, иначе не
// ухватить за уголок — он оказывается за пределами окна.
const VIEWS = [0.5, 0.75, 1, 1.5, 2, 3, 4]

/**
 * Поле размера кадра.
 *
 * Набранное держим строкой и применяем, только когда поле оставили или нажали
 * Enter. Иначе программа правит число на каждую нажатую цифру: набрал «1» —
 * превратилось в 16, и дальше вместо 1920 набирается что попало.
 */
function SizeField({
  label,
  value,
  limit,
  onDone,
}: {
  label: string
  value: number
  limit: number
  onDone: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)

  const apply = () => {
    if (draft === null) return
    const next = Number(draft)
    setDraft(null)
    if (Number.isFinite(next) && next >= 16) onDone(Math.min(limit, next))
  }

  return (
    <label className="flex-1">
      <span className="label">{label}</span>
      <input
        type="number"
        className="field"
        value={draft ?? value}
        min={16}
        max={limit}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === 'Enter') apply()
          if (event.key === 'Escape') setDraft(null)
        }}
      />
    </label>
  )
}

/**
 * Какие клипы приближает колесо и кнопки.
 *
 * Всё, что сейчас в кадре, и не важно, что выбрано на таймлайне. Приближение
 * относится к картинке целиком: когда на экране два файла, а приближается один
 * из них, получается не приближение, а перекос. Выделение тут ни при чём —
 * человек смотрит в окно просмотра, а не на дорожки.
 */
function zoomTargets(state: { tracks: ComposeTrack[]; playhead: number }): ComposeClip[] {
  return state.tracks
    .flatMap((track) => track.clips)
    .filter(
      (clip) =>
        clip.kind !== 'audio' &&
        clip.start <= state.playhead &&
        clip.start + clip.duration > state.playhead,
    )
}

/**
 * Вкладка «Монтаж».
 *
 * Сверху окно просмотра, снизу таймлайн, справа свойства выбранного клипа.
 * Файлы берутся из той же медиатеки слева — их перетаскивают на дорожку.
 */
/** Высота таймлайна: обычная, пределы и где она запоминается. */
const TIMELINE_DEFAULT = 300
const TIMELINE_MIN = 140
/** Окну просмотра оставляем хотя бы столько, сколько бы ни тянули таймлайн. */
const VIEWER_MIN = 260
const TIMELINE_HEIGHT_KEY = 'sgh.timelineHeight'

export function ComposeTab() {
  const width = useCompose((state) => state.width)
  const height = useCompose((state) => state.height)
  const tracks = useCompose((state) => state.tracks)
  const playhead = useCompose((state) => state.playhead)
  const selected = useCompose((state) => state.selected)
  const quality = useCompose((state) => state.quality)
  const shape = useCompose((state) => state.shape)
  const turned = useCompose((state) => state.turned)
  const custom = useCompose((state) => state.custom)
  const setQuality = useCompose((state) => state.setQuality)
  const setShape = useCompose((state) => state.setShape)
  const setTurned = useCompose((state) => state.setTurned)
  const fps = useCompose((state) => state.fps)
  const setFps = useCompose((state) => state.setFps)
  const setCustomSize = useCompose((state) => state.setCustomSize)
  const useCustom = useCompose((state) => state.useCustom)
  const addClip = useCompose((state) => state.addClip)
  const addPair = useCompose((state) => state.addPair)
  const clearAll = useCompose((state) => state.clearAll)
  const masterVolume = useCompose((state) => state.masterVolume)
  const loudnorm = useCompose((state) => state.loudnorm)
  const setLoudnorm = useCompose((state) => state.setLoudnorm)
  const setMasterVolume = useCompose((state) => state.setMasterVolume)

  const toast = useStore((state) => state.toast)
  const revealQueue = useStore((state) => state.revealQueue)
  const settings = useStore((state) => state.settings)

  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  // Сравнение: левая половина кадра — без эффектов, правая — с ними. Тот же
  // кадр под иглой, собранный второй раз без эффектов клипов и дорожек.
  const [compare, setCompare] = useState(() => localStorage.getItem('sgh.composeCompare') === '1')
  const [rawUrl, setRawUrl] = useState<string | null>(null)
  const [frameError, setFrameError] = useState<string | null>(null)
  const [missingOpen, setMissingOpen] = useState(false)
  const opened = useCompose((state) => state.opened)
  const refresh = useCompose((state) => state.refresh)
  const masking = useCompose((state) => state.masking)
  // Рамка обрезки или маски — у выбранного клипа, пока горят их часики:
  // сменили выделение — рамка переходит на новый клип.
  const animFocus = useCompose((state) => state.animFocus)
  useEffect(() => {
    if (animFocus === 'crop' || animFocus === 'mask') useCompose.getState().setAnimFocus(animFocus)
  }, [animFocus, selected])
  const cropping = useCompose((state) => state.cropping)
  // Выделение ушло с клипа — и обрезка его закончена: рамка обрезки без
  // выделенного клипа только путала бы.

  const missingAlert = useCompose((state) => state.missingAlert)
  useEffect(() => {
    if (missingAlert) setMissingOpen(true)
  }, [missingAlert])
  const [busy, setBusy] = useState(false)
  // Чем кодировать готовый файл. Запоминаем: настраивают это редко, а
  // собирают часто.
  const [render, setRender] = useState<RenderSettings>(() => {
    try {
      const saved = localStorage.getItem('sgh.composeRender')
      return saved ? { ...DEFAULT_RENDER, ...JSON.parse(saved) } : DEFAULT_RENDER
    } catch {
      return DEFAULT_RENDER
    }
  })
  // Сменили размер кадра (480p, 720p, 1080p, форма) — битрейт переезжает
  // следом: подписи шкалы считаются от кадра, и «обычно» для 1080p на 480p
  // было бы втрое больше нужного. У «Своего» размера шкала как у 1080p
  // (`scaleFrame`), и туда битрейт переезжает так же.
  const lastFrame = useRef<{ width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const now = scaleFrame({ width, height }, custom)
    const was = lastFrame.current
    lastFrame.current = now
    if (!was || (was.width === now.width && was.height === now.height)) return
    setRender((current) => {
      if (current.bitrateKbps <= 0) return current
      const next = { ...current, bitrateKbps: bitrateForFrame(current.bitrateKbps, current.videoCodec, was, now) }
      localStorage.setItem('sgh.composeRender', JSON.stringify(next))
      return next
    })
  }, [width, height, custom])

  const updateRender = (next: RenderSettings) => {
    setRender(next)
    localStorage.setItem('sgh.composeRender', JSON.stringify(next))
  }
  // Куда и под каким именем сохранять. Папку запоминаем: готовое обычно
  // складывают в одно и то же место, и выбирать его каждый раз заново незачем.
  const [outputName, setOutputName] = useState('')
  const [outputDir, setOutputDir] = useState<string | null>(
    () => localStorage.getItem('sgh.composeOut') || null,
  )
  const [pickingFolder, setPickingFolder] = useState(false)
  // Окно сохранённых монтажей: программа сама помнит только последний.
  const [projectsOpen, setProjectsOpen] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const spareRef = useRef<HTMLVideoElement>(null)
  const videoPair = useRef<[typeof videoRef, typeof videoRef]>([videoRef, spareRef]).current
  const frameBox = useRef<HTMLDivElement>(null)
  const player = useComposePlayer(videoPair)
  // Чтение файла занимает мгновение, но окно без этого выглядит зависшим.
  // Держим и место, откуда началась работа: значок должен появиться под
  // курсором сразу, а не после первого движения мыши.
  const [adding, setAdding] = useState<{ x: number; y: number } | null>(null)

  // Запись голоса: ложится на свободную звуковую дорожку с места иглы.
  const recording = useVoiceRecorder(
    player,
    (path, at, trim) => void placeRecording(path, at, trim),
    (text) => toast(text, 'error'),
  )
  const recordingRef = useRef(recording)
  recordingRef.current = recording
  useEffect(() => {
    // Ctrl+R — запись. Без перехвата окно перезагрузило бы страницу.
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.code === 'KeyR') {
        event.preventDefault()
        recordingRef.current.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** Готовая запись — на звуковую дорожку, где в это время пусто; нет такой — на новую. */
  async function placeRecording(path: string, at: number, trim: number) {
    try {
      const info = await api.fileInfo(path)
      const length = Math.max(0.2, (info.media?.duration ?? 0) - trim)
      const free = (track: ComposeTrack) =>
        track.kind === 'audio' &&
        !track.clips.some((clip) => clip.start < at + length && clip.start + clip.duration > at)
      let target = useCompose.getState().tracks.find(free)
      if (!target) {
        useCompose.getState().addTrack('audio')
        target = useCompose.getState().tracks.filter((track) => track.kind === 'audio').at(-1)
      }
      if (!target) return
      await dropFile(path, at, target.id, { x: window.innerWidth / 2, y: window.innerHeight - 120 }, trim)
      toast(`Запись сохранена: ${info.name}`, 'ok')
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }
  // Вопрос о размере кадра по первому файлу. Отметка нужна, когда бросили
  // сразу несколько файлов: первым считается только один.
  const [frameQuestion, setFrameQuestion] = useState<FrameQuestion | null>(null)
  const framePending = useRef(false)
  // Кадр под иглой иногда считается заметно дольше обычного — на длинном
  // монтаже это выглядит как зависание. Показываем то же, что и при чтении.
  const [slowFrame, setSlowFrame] = useState(false)
  // Сетка поверх кадра, как в медиатеке: по ней видно, попадает ли важное в
  // середину. Выбор запоминается — включают её обычно надолго.
  // Сетку часто включают и выключают, поэтому у неё отдельная кнопка, а вид
  // выбирается списком рядом. Выключенная сетка помнит свой вид: включил —
  // вернулась та же.
  const [gridOn, setGridOn] = useState(() => localStorage.getItem('sgh.composeGridOn') === '1')
  const [gridKind, setGridKind] = useState<GridKind>(() => {
    const saved = localStorage.getItem('sgh.composeGrid')
    return GRIDS.some((item) => item.value === saved && item.value !== 'none')
      ? (saved as GridKind)
      : 'thirds'
  })
  const grid: GridKind = gridOn ? gridKind : 'none'
  const [snapping, setSnapping] = useState(false)
  // Увеличительное стекло над кадром: во сколько раз и насколько сдвинут.
  // Сдвиг в пикселях от середины — так кадр можно и таскать зажатым колесом,
  // и приближать к точке под курсором.
  const [view, setView] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  // Ширина шины громкости: её тянут за границу, и от ширины зависит, что на
  // ней помещается. Запоминаем — настраивают это один раз и надолго.
  const [meterWidth, setMeterWidth] = useState(() => {
    const saved = Number(localStorage.getItem('sgh.composeMeter'))
    return Number.isFinite(saved) && saved > 0 ? saved : METER_DEFAULT
  })

  const duration = tracks.reduce(
    (longest, track) =>
      track.clips.reduce((value, clip) => Math.max(value, clip.start + clip.duration), longest),
    0,
  )
  const clips = tracks.reduce((count, track) => count + track.clips.length, 0)

  // Какую надпись сейчас правят прямо в кадре — её эффект кадра пропустит.
  // Правило то же, что у рамки ниже: выделена ровно одна видимая надпись.
  const liveTextId = (() => {
    const visible = tracks
      .flatMap((track) => track.clips)
      .filter(
        (clip) =>
          selected.includes(clip.id) &&
          clip.kind !== 'audio' &&
          clip.start <= playhead &&
          clip.start + clip.duration > playhead,
      )
    return visible.length === 1 && visible[0].kind === 'text' ? visible[0].id : null
  })()

  // Кадр под иглой. Просчёт занимает около десятой доли секунды, но запросы
  // всё равно гасим: игла ходит непрерывно, и без этого мы бы отправляли по
  // запросу на каждый пиксель её пути.
  const pending = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!clips || player.playing) {
      if (!clips) setFrameUrl(null)
      return
    }
    let slow: ReturnType<typeof setTimeout> | null = null
    const timer = setTimeout(() => {
      pending.current?.abort()
      const control = new AbortController()
      pending.current = control
      slow = setTimeout(() => setSlowFrame(true), 400)
      const view = useCompose.getState()
      // Надпись, которую правят в кадре, рисует само окно — живьём, на каждую
      // букву. Программе её рисовать незачем: получилось бы две.
      // Обрезаемый клип показываем целиком: отрезаемое затемняет рамка
      // обрезки, и видно, что уходит, а что остаётся.
      const shownTracks = view.tracks.map((track) => ({
        ...track,
        clips: track.clips
          .filter((clip) => clip.id !== liveTextId)
          .map((clip) =>
            clip.id === view.cropping
              ? {
                  ...clip,
                  cropLeft: 0,
                  cropTop: 0,
                  cropRight: 0,
                  cropBottom: 0,
                  anim: withoutGroup(clip.anim, CROP_FIELDS),
                }
              : clip,
          ),
      }))
      // Кроме правящейся надписи в кадре ничего нет — собирать нечего: просто
      // чёрный кадр под ней, без сообщения «пусто» за буквами.
      if (!shownTracks.some((track) => track.clips.length)) {
        if (slow) clearTimeout(slow)
        setFrameUrl((old) => {
          if (old) URL.revokeObjectURL(old)
          return null
        })
        setFrameError(null)
        return
      }
      const frameOf = (tracks: typeof shownTracks) =>
        api.composeFrame(
          {
            project: {
              width: view.width,
              height: view.height,
              fps: view.fps,
              tracks,
            },
            at: playhead,
            preview_width: 960,
          },
          control.signal,
        )
      // Кадр без эффектов нужен, только когда сравнивают и эффекты есть:
      // иначе обе половины одинаковые, и второй просчёт ни к чему.
      const withEffects = shownTracks.some(
        (track) => (track.effects ?? []).length || track.clips.some((clip) => (clip.effects ?? []).length),
      )
      const raw =
        compare && withEffects
          ? frameOf(
              shownTracks.map((track) => ({
                ...track,
                effects: [],
                clips: track.clips.map((clip) => ({ ...clip, effects: [] })),
              })),
            )
          : Promise.resolve(null)
      Promise.all([frameOf(shownTracks), raw])
        .then(([{ blob, missing }, plain]) => {
          setFrameUrl((old) => {
            if (old) URL.revokeObjectURL(old)
            return URL.createObjectURL(blob)
          })
          setRawUrl((old) => {
            if (old) URL.revokeObjectURL(old)
            return plain ? URL.createObjectURL(plain.blob) : null
          })
          setFrameError(null)
          // Файл удалили прямо во время работы — кадр собран без него, а
          // окно пропавших откроется само, как при открытии проекта.
          if (missing.length) useCompose.getState().reportMissing(missing)
        })
        .catch((error: Error) => {
          if (error.name === 'AbortError') return
          setFrameError(error.message)
        })
        .finally(() => {
          if (slow) clearTimeout(slow)
          setSlowFrame(false)
        })
    }, 80)
    return () => {
      clearTimeout(timer)
      if (slow) clearTimeout(slow)
    }
    // Размер кадра тоже: без него после смены формы окно показывало кадр
    // прежней формы, пока не сдвинешь иглу.
  }, [playhead, clips, tracks, player.playing, liveTextId, width, height, fps, refresh, cropping, compare])

  // Открыли проект (или программа подняла прошлый монтаж) — сразу чёрный
  // кадр вместо кадра прежнего проекта: иначе ошибку о пропавшем файле
  // человек читал поверх чужой картинки и думал, что речь о ней. Потом
  // проверяем файлы: пропавшие — окно со старыми путями, найденные вне
  // рабочих папок — добавляем папку сами, как при перетаскивании.
  useEffect(() => {
    setFrameUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
    setFrameError(null)
    if (opened) player.stop()
    const sources = [
      ...new Set(
        useCompose
          .getState()
          .tracks.flatMap((track) => track.clips)
          .filter((clip) => clip.kind !== 'color' && clip.kind !== 'text' && clip.source)
          .map((clip) => clip.source),
      ),
    ]
    if (!sources.length) {
      useCompose.getState().setMissing([])
      return
    }
    let alive = true
    void (async () => {
      try {
        const check = await api.composeCheck(sources)
        const folders = [...new Set(check.outside.map(parentDir))]
        for (const folder of folders) await api.addWorkspace(folder)
        if (folders.length) await useStore.getState().refreshSettings()
        if (!alive) return
        useCompose.getState().setMissing(check.missing)
        if (check.missing.length) setMissingOpen(true)
      } catch {
        /* проверка не удалась — ошибки покажет сам кадр */
      }
    })()
    return () => {
      alive = false
    }
    // Только на открытие проекта и первый показ вкладки, не на каждую правку.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened])

  // Картинку держим ровно до следующей: иначе браузер копит их в памяти.
  useEffect(() => () => {
    if (frameUrl) URL.revokeObjectURL(frameUrl)
  }, [frameUrl])
  useEffect(() => () => {
    if (rawUrl) URL.revokeObjectURL(rawUrl)
  }, [rawUrl])

  /** Файл притащили из медиатеки — добавляем клип на дорожку. */
  async function dropFile(
    path: string,
    at: number,
    trackId: string,
    from: { x: number; y: number },
    /** Сколько секунд от начала файла не брать — у записи голоса. */
    trim = 0,
  ) {
    setAdding(from)
    let claimed = false
    try {
      // Файл может лежать где угодно, а программа работает только внутри
      // рабочих папок. Раньше такой файл просто отбивался ошибкой, и человек
      // шёл добавлять папку в медиатеку руками — при том что он уже сказал,
      // чего хочет, перетащив файл сюда. Добавляем папку сами.
      let info = await api.fileInfo(path).catch(() => null)
      if (!info) {
        const folder = parentDir(path)
        await api.addWorkspace(folder)
        info = await api.fileInfo(path)
        // Медиатеку переводим на эту же папку: файл оттуда человек только что
        // взял, значит и остальные, скорее всего, возьмёт оттуда же. Делаем
        // это после того, как клип лёг на дорожку, — обход большой папки
        // занимает время, и ждать его незачем.
        void (async () => {
          await useStore.getState().refreshSettings()
          useStore.getState().openFolder(folder)
        })()
      }
      if (info.kind === 'other') {
        toast('Такой файл на таймлайн не положить', 'error')
        return
      }
      // Первый файл с картинкой на пустом таймлайне — спросим, не взять ли
      // кадр по нему. Смотрим до того, как клип ляжет: после он уже не первый.
      // Надписи и заливки не считаются: у них своего размера нет.
      const firstPicture =
        (info.kind === 'image' || info.kind === 'video') &&
        !framePending.current &&
        !useCompose
          .getState()
          .tracks.some((track) => track.clips.some((item) => item.kind === 'image' || item.kind === 'video'))
      if (firstPicture) {
        framePending.current = true
        claimed = true
      }
      const length = info.media?.duration ?? 0
      const clip: Omit<ComposeClip, 'id'> = {
        source: info.path,
        name: info.name,
        kind: info.kind === 'audio' ? 'audio' : info.kind === 'image' ? 'image' : 'video',
        start: Math.max(0, Math.round(at * 100) / 100),
        // Картинка висит столько, сколько скажут; у ролика берём его длину.
        duration: info.kind === 'image' ? DEFAULT_IMAGE_SECONDS : Math.max(0.2, length - trim),
        sourceIn: trim,
        sourceDuration: info.kind === 'image' ? 0 : length,
        hasAudio: Boolean(info.media?.hasAudio),
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
        muted: false,
        opacity: 1,
        zoom: 1,
        size: 1,
        sizeY: 0,
        // Форма файла нужна, чтобы рамка в окне просмотра совпадала с самой
        // картинкой: у квадратной картинки в широком кадре рамка иначе была
        // бы шире её, и выравнивать по краям было бы не по чему.
        ratio:
          info.media?.width && info.media?.height
            ? info.media.width / info.media.height
            : 0,
        x: 0.5,
        y: 0.5,
      }
      if (clip.kind === 'video' && clip.hasAudio) {
        // У ролика со звуком на таймлайне два клипа: видно, что звук есть,
        // и его можно убавить или убрать, не трогая картинку.
        addPair(clip, trackId)
      } else {
        addClip(clip, trackId)
      }
      // Игла переезжает на положенный клип: иначе она осталась бы на пустом
      // месте, и окно просмотра показало бы чёрный кадр — как будто файл
      // не добавился вовсе.
      useCompose.getState().setPlayhead(clip.start + Math.min(0.2, clip.duration / 2))

      const source = { width: info.media?.width ?? 0, height: info.media?.height ?? 0 }
      // Частота кадров ролика — ближайшая из списка монтажа. У картинки её нет.
      const rate =
        clip.kind === 'video' && info.media?.fps
          ? FRAME_RATES.find((item) => Math.abs(item.value - info.media!.fps!) < 0.05)?.value
          : undefined
      if (firstPicture && source.width && source.height) {
        const state = useCompose.getState()
        const wanted = sourceFrame(source.width, source.height)
        // Кадр и частота уже такие же — спрашивать не о чем.
        if (
          wanted.width !== state.width ||
          wanted.height !== state.height ||
          (rate !== undefined && Math.abs(rate - state.fps) > 1e-3)
        ) {
          setFrameQuestion({ name: info.name, ...source, fps: rate })
          // Вопрос висит — отметку снимет ответ на него.
          claimed = false
        }
      }
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      if (claimed) framePending.current = false
      setAdding(null)
    }
  }

  async function build() {
    // Пустое имя — обычное «Project»: для черновых роликов придумывать имя
    // каждый раз незачем. Что будет вместо имени, видно в самом поле.
    const state = useCompose.getState()
    // Отрезок без единого файла дал бы чёрный экран нужной длины — такое
    // никому не нужно, а метку за концом монтажа легко не заметить.
    const span = renderSpan(state)
    if (!hasClipsIn(state.tracks, span.from, span.to)) {
      toast(
        state.renderIn !== null || state.renderOut !== null
          ? 'Между метками I и O нет ни одного файла — рендерить нечего. Передвиньте метки или уберите их крестиком'
          : 'На таймлайне пусто — рендерить нечего',
        'error',
      )
      return
    }
    setBusy(true)
    try {
      await api.composeBuild({
        project: {
          width: state.width,
          height: state.height,
          fps: state.fps,
          masterVolume: state.masterVolume,
          loudnorm: state.loudnorm,
          tracks: state.tracks,
        },
        output_dir: outputDir,
        output_name: outputName.trim() || DEFAULT_NAME,
        render,
        start: state.renderIn,
        end: state.renderOut,
      })
      revealQueue()
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }


  /** Сохраняет то, что сейчас в окне просмотра, картинкой. */
  async function grabFrame() {
    setSnapping(true)
    try {
      const view = useCompose.getState()
      await api.composeSnapshot({
        project: {
          width: view.width,
          height: view.height,
          fps: view.fps,
          tracks: view.tracks,
        },
        at: view.playhead,
        outputDir: outputDir,
        outputName: outputName.trim() || DEFAULT_NAME,
      })
      toast('Кадр сохранён — в полном размере кадра проекта, без сжатия', 'ok')
      revealQueue()
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setSnapping(false)
    }
  }

  // Высоту таймлайна задаёт человек: тянет за верхний край, и она
  // запоминается. Число дорожек и их высота её не меняют — лишние дорожки
  // прокручиваются внутри. Прежде таймлайн рос с каждой новой дорожкой и
  // ломал уже настроенный вид.
  const [timelineHeight, setTimelineHeight] = useState(() => {
    const saved = Number(localStorage.getItem(TIMELINE_HEIGHT_KEY))
    return Number.isFinite(saved) && saved > 0 ? saved : TIMELINE_DEFAULT
  })
  // Окно сжали — таймлайн не должен съесть окно просмотра целиком.
  const [windowHeight, setWindowHeight] = useState(window.innerHeight)
  useEffect(() => {
    const onResize = () => setWindowHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const timelineMax = Math.max(TIMELINE_MIN, windowHeight - VIEWER_MIN)
  const shownTimeline = Math.min(Math.max(timelineHeight, TIMELINE_MIN), timelineMax)
  const resizeTimeline = (event: React.MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    const from = event.clientY
    const was = shownTimeline
    let next = was
    const move = (moving: MouseEvent) => {
      next = Math.min(Math.max(was - (moving.clientY - from), TIMELINE_MIN), timelineMax)
      setTimelineHeight(next)
    }
    const drop = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', drop)
      document.body.style.cursor = ''
      try {
        localStorage.setItem(TIMELINE_HEIGHT_KEY, String(Math.round(next)))
      } catch {
        // Без памяти высота проживёт до перезапуска.
      }
    }
    document.body.style.cursor = 'ns-resize'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
  }

  // Клип, который сейчас двигают по кадру: рамка появляется, когда среди
  // выбранного ровно одна картинка и она в этот момент видна. Звук в счёт не
  // идёт — иначе у ролика со звуком, где выбирается сразу пара, рамки не было
  // вовсе. На нескольких картинках сразу рамка врала бы: размер и место у
  // каждой свои, — а двигать то, чего в кадре нет, значит вслепую.
  const shown = tracks
    .flatMap((track) => track.clips)
    .filter(
      (clip) =>
        selected.includes(clip.id) &&
        clip.kind !== 'audio' &&
        clip.start <= playhead &&
        clip.start + clip.duration > playhead,
    )
  const placing = shown.length === 1 ? shown[0] : undefined
  // Надпись, выделенная на таймлайне: справа вместо настроек кадра — её
  // настройки. Звук в счёт не идёт, как и у рамки.
  const pickedVisual = tracks
    .flatMap((track) => track.clips)
    .filter((clip) => selected.includes(clip.id) && clip.kind !== 'audio')
  const textClip =
    pickedVisual.length === 1 && pickedVisual[0].kind === 'text' ? pickedVisual[0] : undefined
  // То же для заливки: её цвет, скругление, рамка и тень.
  const fillClip =
    pickedVisual.length === 1 && pickedVisual[0].kind === 'color' ? pickedVisual[0] : undefined
  // Выбран один файл — справа его эффекты. Ролик со звуком — это два клипа,
  // картинка и звук; выбор такой пары тоже считается одним файлом.
  const picked = useCompose((state) => state.picked)
  const partnerOf = useCompose((state) => state.partnerOf)
  // Нажали Fx у дорожки — колонка показывает её эффекты.
  const trackFx = useCompose((state) => state.trackFx)
  const mediaClip = (() => {
    const all = tracks.flatMap((track) => track.clips)
    const chosen = all.filter((clip) => selected.includes(clip.id))
    const media = (clip?: ComposeClip) =>
      clip && (clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'audio') ? clip : undefined
    if (chosen.length === 1) return media(chosen[0])
    if (chosen.length === 2 && partnerOf(chosen[0].id)?.id === chosen[1].id) {
      // Показываем ту половину, по которой нажали, — важно лишь для подписи.
      const first = all.find((clip) => clip.id === picked[0])
      return media(first && chosen.includes(first) ? first : chosen.find((clip) => clip.kind !== 'audio'))
    }
    return undefined
  })()

  // Надпись, которую прямо сейчас видно и можно править в кадре. Её рисует
  // окно, поэтому из собранного программой кадра она убирается — иначе на
  // экране было бы две одинаковые надписи.
  const liveText = placing?.kind === 'text' ? placing : undefined

  // Выделили надпись, а игла стоит вне её — переводим иглу на надпись. Иначе
  // справа открылись бы её настройки, а в кадре её нет: ни написать, ни
  // увидеть, что меняют. Только при смене выделения: двигать иглу дальше
  // человек волен сам.
  const textClipId = textClip?.id
  // Зажата ли кнопка мыши. Надпись выделяют и нажатием по таймлайну, а там
  // игла сама встаёт на место нажатия, когда кнопку отпустят; переводить её
  // в середину надписи до этого значит показать лишний прыжок.
  const mouseHeld = useRef(false)
  useEffect(() => {
    const down = () => (mouseHeld.current = true)
    const up = () => (mouseHeld.current = false)
    window.addEventListener('mousedown', down, true)
    window.addEventListener('mouseup', up, true)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('mouseup', up, true)
    }
  }, [])
  useEffect(() => {
    if (!textClipId) return
    const settle = () => {
      const state = useCompose.getState()
      const clip = state.tracks.flatMap((track) => track.clips).find((item) => item.id === textClipId)
      if (!clip || !state.selected.includes(clip.id)) return
      if (state.playhead >= clip.start && state.playhead < clip.start + clip.duration) return
      // В середину, а не в начало: у начала надпись часто ещё проявляется, и
      // видно её не целиком.
      state.setPlayhead(clip.start + clip.duration / 2)
    }
    if (!mouseHeld.current) {
      settle()
      return
    }
    // Ждём, пока отпустят кнопку и таймлайн поставит иглу сам; после этого
    // игла уже на надписи, и проверка ничего не тронет.
    let timer = 0
    const release = () => {
      timer = window.setTimeout(settle, 0)
    }
    window.addEventListener('mouseup', release, { once: true })
    return () => {
      window.removeEventListener('mouseup', release)
      window.clearTimeout(timer)
    }
  }, [textClipId])

  // Куда ляжет файл, если папку не выбирали: та же, что выберет сервер.
  // Раньше это была папка первого клипа — и она менялась сама, стоило
  // собрать монтаж из другого материала: готовое уходило туда, откуда
  // случайно взялся первый файл. Теперь умолчание одно и то же — «Загрузки».
  const defaultOut = settings?.downloadsDir ?? null
  // Ищем по списку дорожек, а не через getState(): иначе панель справа не
  // узнает, что клип подвинули или растянули, — снимок хранилища не
  // подписывает компонент на изменения.
  const current =
    selected.length === 1
      ? tracks.flatMap((track) => track.clips).find((clip) => clip.id === selected[0])
      : undefined

  return (
    // Пока файл читается, у курсора висит подпись: файл ложится на дорожку не
    // мгновенно, и без этого кажется, что окно зависло. Одного вида курсора
    // мало — его смену легко не заметить.
    <div className={`relative flex h-full ${adding || slowFrame ? 'cursor-progress' : ''}`}>
      {adding && <BusyMark from={adding} text="читаю файл…" />}
      {!adding && slowFrame && (
        <BusyMark from={{ x: 24, y: 24 }} text="собираю кадр…" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Окно просмотра.

            Фон не чёрный, и у кадра есть рамка: иначе чёрные поля вокруг
            вертикального видео сливались с фоном, и понять, какой формы
            получится кадр, было невозможно — всё выглядело прямоугольником. */}
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div
            className={`stage relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4 ${noStraySelection.className}`}
            onMouseDownCapture={noStraySelection.onMouseDownCapture}
            onDragStart={noStraySelection.onDragStart}
            onWheel={(event) => {
              // Колесо увеличивает сам экран просмотра, а не файлы на нём.
              // Точка под курсором остаётся на месте: иначе на приближении
              // нужный кусок кадра уезжает неизвестно куда.
              if (!clips) return
              event.preventDefault()
              const box = frameBox.current?.getBoundingClientRect()
              // Отдалять можно до половины: клип, вылезший за край кадра,
              // иначе не ухватить за уголок — он оказывается за пределами окна.
              const next = Math.min(
                6,
                Math.max(0.5, Number((view * (event.deltaY < 0 ? 1.15 : 1 / 1.15)).toFixed(3))),
              )
              if (box) {
                const toX = event.clientX - (box.left + box.width / 2)
                const toY = event.clientY - (box.top + box.height / 2)
                const keep = next / view
                const x = toX - (toX - pan.x) * keep
                const y = toY - (toY - pan.y) * keep
                // Отдалённый кадр уходит от середины не дальше 20% своего
                // размера — как и при перетаскивании, иначе первое же
                // движение мыши прыжком вернуло бы его к краю запаса.
                const edgeX = next < 1 ? box.width * 0.2 : Infinity
                const edgeY = next < 1 ? box.height * 0.2 : Infinity
                setPan({
                  x: Math.max(-edgeX, Math.min(edgeX, x)),
                  y: Math.max(-edgeY, Math.min(edgeY, y)),
                })
              }
              setView(next)
            }}
            // Зажатое колесо таскает кадр: при большом увеличении иначе не
            // добраться до нужного угла. Отдалённый тоже таскается, но не
            // дальше 20% размера кадра: немного подвинуть, чтобы ухватить
            // клип у края, а не потерять кадр за пределами окна.
            onMouseDown={(event) => {
              if (event.button !== 1 || view === 1) return
              event.preventDefault()
              const from = { x: event.clientX, y: event.clientY }
              const was = { ...pan }
              const box = frameBox.current
              const reach =
                view < 1 && box ? { x: box.offsetWidth * 0.2, y: box.offsetHeight * 0.2 } : null
              const limit = (value: number, edge: number | undefined) =>
                edge === undefined ? value : Math.max(-edge, Math.min(edge, value))
              const move = (moved: MouseEvent) => {
                setPan({
                  x: limit(was.x + (moved.clientX - from.x), reach?.x),
                  y: limit(was.y + (moved.clientY - from.y), reach?.y),
                })
              }
              const drop = () => {
                window.removeEventListener('mousemove', move)
                window.removeEventListener('mouseup', drop)
              }
              window.addEventListener('mousemove', move)
              window.addEventListener('mouseup', drop)
            }}
          >
            {/* Панель над кадром: сетка, приближение, качество и снимок.
                Маленькой плашкой поверх сцены, а не своей строкой: строка
                отнимала у кадра высоту, и сверху кадра оставалось много
                пустого места, а снизу — почти ничего. Кадр может заходить
                под плашку; плашка небольшая и стоит у самого верха. */}
            {clips > 0 && (
              <div className="absolute inset-x-0 top-1.5 z-20 mx-auto flex w-fit items-center gap-0.5 rounded-lg bg-surface/85 px-1 py-0.5 ring-1 ring-line-soft backdrop-blur">
                {/* Увеличительное стекло: сколько сейчас и выбор кратности.
                    Нажатие на число возвращает обычный размер. */}
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={() => {
                      setView(1)
                      setPan({ x: 0, y: 0 })
                    }}
                    title="Увеличение экрана просмотра — на готовый файл не влияет. Колесо приближает, зажатое колесо таскает кадр. Нажмите, чтобы вернуть обычный размер."
                    className={`inline-flex h-6 items-center rounded-md px-1.5 font-mono text-[10.5px] tabular-nums transition-colors ${
                      view !== 1
                        ? 'bg-accent/20 text-accent-soft hover:bg-accent/30'
                        : 'text-ink-faint hover:text-ink'
                    }`}
                  >
                    {Math.round(view * 100)}%
                  </button>
                  <Dropdown
                    value={String(view)}
                    title="Насколько увеличить экран"
                    className="flex h-6 w-3.5 items-center justify-center text-ink-faint hover:text-ink"
                    options={VIEWS.map((item) => ({
                      value: String(item),
                      label: `Экран ${Math.round(item * 100)}%`,
                    }))}
                    onChange={(item) => {
                      setView(Number(item))
                      setPan({ x: 0, y: 0 })
                    }}
                  >
                    <ChevronDown size={11} />
                  </Dropdown>
                </div>

                {/* Сетка — не только разметка для глаза: клип к её линиям
                    прилипает, поэтому точное положение можно набрать мышью.
                    Кнопка включает и выключает, список рядом меняет вид. */}
                <div className="flex items-center">
                  <IconButton
                    className="h-6 w-6"
                    title="Сетка поверх кадра. К её линиям, к краям кадра и к его середине клип прилипает, когда его двигают."
                    active={gridOn}
                    onClick={() => {
                      setGridOn((on) => {
                        localStorage.setItem('sgh.composeGridOn', on ? '0' : '1')
                        return !on
                      })
                    }}
                  >
                    <Grid3x3 size={13} />
                  </IconButton>
                  {/* Галочка рядом со значком: сам список нужен редко, а
                      место занимал бы постоянно, поэтому от него оставлена
                      только стрелка. */}
                  <Dropdown
                    value={gridKind}
                    title="Какая сетка"
                    className="flex h-6 w-3.5 items-center justify-center text-ink-faint hover:text-ink"
                    options={GRIDS.filter((item) => item.value !== 'none')}
                    onChange={(value) => {
                      setGridKind(value)
                      setGridOn(true)
                      localStorage.setItem('sgh.composeGrid', value)
                      localStorage.setItem('sgh.composeGridOn', '1')
                    }}
                  >
                    <ChevronDown size={11} />
                  </Dropdown>
                </div>

                <IconButton
                  className="h-6 w-6"
                  title="Сравнить: слева кадр без эффектов, справа — с ними. Удобно подбирать цвет и другие эффекты. Работает на остановленном кадре"
                  active={compare}
                  onClick={() => {
                    setCompare((on) => {
                      localStorage.setItem('sgh.composeCompare', on ? '0' : '1')
                      return !on
                    })
                  }}
                >
                  <Columns2 size={13} />
                </IconButton>

                <Dropdown
                  value={String(player.quality)}
                  title="Качество просмотра. На готовый файл не влияет — только на то, что видно здесь."
                  className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[10.5px] text-ink-dim hover:bg-surface-3 hover:text-ink"
                  options={[
                    { value: 'auto', label: 'Качество просмотра: авто' },
                    // Выше качества самого проекта просмотр не собирается,
                    // поэтому и выбирать его нечего. У «Своего» размера
                    // доступно всё: размер там бывает любым.
                    ...PREVIEW_QUALITIES.filter((value) => custom || value <= quality).map((value) => ({
                      value: String(value),
                      label: `Качество просмотра: ${value}p`,
                    })),
                  ]}
                  onChange={(value) =>
                    player.setQuality(value === 'auto' ? 'auto' : (Number(value) as PreviewQuality))
                  }
                >
                  {player.quality === 'auto'
                    ? 'авто'
                    : `${custom ? player.quality : Math.min(player.quality, quality)}p`}
                  <ChevronDown size={11} className="text-ink-faint" />
                </Dropdown>

                <IconButton
                  className="h-6 w-6"
                  title="Сохранить кадр картинкой"
                  onClick={() => void grabFrame()}
                  disabled={snapping}
                >
                  <Camera size={13} />
                </IconButton>
              </div>
            )}

            {/* Размер кадра считается от этого места: «containerType: size»
                позволяет внутри мерить его ширину и высоту прямо в CSS.
                Отступ сверху — под плашку с кнопками: в обычном размере кадр
                стоит под ней, а не заходит под неё. Под плашку уходит только
                увеличенный кадр. */}
            <div
              className={`flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden ${
                clips > 0 ? 'pt-[22px]' : ''
              }`}
              style={{ containerType: 'size' }}
            >
            {!clips ? (
              <Empty
                icon={<Film size={44} />}
                title="Перетащите файлы из медиатеки"
                hint="Картинки, видео и звук ложатся на дорожки внизу. Картинку можно растянуть за край — столько она и будет висеть на экране. Клип режется клавишей S под иглой, удаляется — Delete."
              />
            ) : (
              <div
                ref={frameBox}
                // Чёрный фон и рамка принадлежат самому кадру, а не месту под
                // него: при отдалении вокруг уменьшенного кадра оставались
                // чёрные поля, и у видео с тёмным началом край было не
                // отличить от пустоты. Само место прозрачное — сквозь него
                // видна сцена с сеткой; серая подложка торчала при отдалении
                // прямоугольником поверх сцены.
                className="relative overflow-hidden"
                style={{
                  aspectRatio: `${width} / ${height}`,
                  // Кадр вписывается в свободное место целиком, сохраняя свою
                  // форму. Пары «высота 100% и ширина по форме» не хватало:
                  // когда места по ширине меньше, чем просит форма, ограничение
                  // срезало ширину, а высота оставалась прежней — и кадр 16:9
                  // показывался почти квадратным. Считаем ширину сами, по
                  // меньшей из двух сторон свободного места.
                  width: `min(100cqw, calc(100cqh * ${width} / ${height}))`,
                  // Надпись в кадре задана долями его высоты: объявляем кадр
                  // контейнером, и её размер считается прямо в CSS, как в
                  // готовом файле, — без замеров на каждое изменение окна.
                  containerType: 'size',
                }}
              >
              {/* Всё содержимое кадра увеличивается целиком — и картинка, и
                  сетка, и рамка клипа. Точка увеличения та, где было колесо,
                  поэтому нужное место остаётся под курсором. */}
              <div
                className="absolute inset-0 bg-black shadow-xl ring-1 ring-line"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${view})`,
                }}
              >
                {/* Пока смотрим — играет собранный кусок, иначе показываем
                    кадр под иглой. Снаружи разницы нет: то же окно. Видео два
                    и играют по очереди: следующий кусок уже загружен во
                    второе, и на стыке нет пустого кадра. Звук у видео
                    выключен — он идёт отдельно (см. useComposePlayer). */}
                {[videoRef, spareRef].map((ref, index) => (
                  <video
                    key={index}
                    ref={ref}
                    className={`absolute inset-0 h-full w-full object-contain ${
                      player.playing && player.shown === index ? '' : 'invisible'
                    }`}
                    muted
                    playsInline
                    onError={() => {
                      if (player.shown === index) player.stop()
                    }}
                  />
                ))}
                {!player.playing && frameUrl && (
                  <img src={frameUrl} alt="" className="h-full w-full object-contain" />
                )}
                {/* Сравнение: левая половина — тот же кадр без эффектов. */}
                {!player.playing && compare && frameUrl && (
                  <>
                    {rawUrl && (
                      <img
                        src={rawUrl}
                        alt=""
                        className="absolute inset-0 h-full w-full object-contain"
                        style={{ clipPath: 'inset(0 50% 0 0)' }}
                      />
                    )}
                    <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-white/70" />
                    <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white/85">
                      Без эффектов
                    </span>
                    <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white/85">
                      С эффектами
                    </span>
                  </>
                )}
                {/* Ошибка — в одном месте, посреди кадра: и кадра, и просмотра.
                    Прежде ошибка просмотра повторялась ещё и полосой внизу. Текст
                    выделяется и копируется: его переписывают или ищут по нему. */}
                {!player.playing && (player.error || frameError) && (
                  <div className="absolute inset-0 flex items-center justify-center p-4">
                    <p className="cursor-text select-text whitespace-pre-line break-all text-center text-[12px] leading-snug text-danger">
                      {player.error || frameError}
                    </p>
                  </div>
                )}

                {/* Рамка выбранного клипа: за неё его двигают и меняют
                    размер прямо в кадре. Пока клип не выбран, рамки нет —
                    иначе она мешала бы просто смотреть. */}
                <ComposeGrid kind={grid} />

                {/* Рамки получают клип таким, каким он стоит под иглой: у
                    анимированного место и размер берутся из ключей. */}
                {!player.playing && placing && placing.kind !== 'text' && (
                  cropping === placing.id ? (
                    <ComposeCropBox clip={shownAt(placing, playhead)} />
                  ) : masking === placing.id ? (
                    <ComposeMaskBox clip={shownAt(placing, playhead)} />
                  ) : (
                    <ComposeFrameBox clip={shownAt(placing, playhead)} grid={grid} />
                  )
                )}
                {!player.playing && liveText && (
                  <ComposeTextOverlay clip={shownAt(liveText, playhead)} grid={grid} />
                )}

              </div>


              </div>
            )}
            </div>
          </div>

          <MasterMeter
            levels={player.levels}
            master={masterVolume}
            onMaster={setMasterVolume}
            active={player.playing}
            width={meterWidth}
            onWidth={(value) => {
              setMeterWidth(value)
              localStorage.setItem('sgh.composeMeter', String(value))
            }}
          />
        </div>

        {/* Таймлайн. Верхний край тянут мышью — так человек сам решает,
            сколько дорожек видно разом. */}
        <div
          className="relative shrink-0 border-t border-line-soft bg-surface"
          style={{ height: shownTimeline }}
        >
          <div
            onMouseDown={resizeTimeline}
            onDoubleClick={() => {
              setTimelineHeight(TIMELINE_DEFAULT)
              localStorage.removeItem(TIMELINE_HEIGHT_KEY)
            }}
            title="Потяните, чтобы сделать таймлайн выше или ниже. Двойное нажатие — обычная высота"
            className="absolute inset-x-0 -top-1 z-30 h-2 cursor-ns-resize hover:bg-accent/30"
          />
          <ComposeTimeline
            adding={adding !== null}
            recording={recording}
            player={player}
            onDropFile={(path, at, trackId, from) => void dropFile(path, at, trackId, from)}
          />
        </div>
      </div>

      {/* Правая панель */}
      {/* Описания настроек в колонке — при наведении, как и в панелях
          обработки: текстом под каждой галочкой они занимали место. */}
      <QuietHints>
      <aside className="flex w-[clamp(260px,22vw,340px)] shrink-0 flex-col border-l border-line-soft bg-surface">
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
          {/* Пока выделена надпись, здесь её настройки, а не кадра: так их
              не надо искать, и экран просмотра остаётся открытым — цвет и
              тень подбирают, глядя на кадр. */}
          {textClip ? (
            <ComposeTextPanel clip={textClip} />
          ) : fillClip ? (
            <ComposeFillPanel clip={fillClip} />
          ) : mediaClip ? (
            <ComposeClipPanel clip={mediaClip} />
          ) : trackFx ? (
            <ComposeTrackFxPanel trackId={trackFx} />
          ) : (
          <>
          {/* Кадр проекта. Без заголовка и без лишних чисел: что выбрано,
              видно по самим кнопкам, а форму кадра показывает рамка в окне
              просмотра. Раздел «Клип» тоже убран — имя файла, громкость и
              затухания живут на самом таймлайне. */}
          {/* Качество и форма — одним разделом: друг без друга они кадр не
              задают, а порознь занимали вдвое больше места. Подсказок у
              кнопок нет — подписи и так понятны. */}
          <Section
            title="Кадр"
            id="compose.frame"
            summary={
              custom
                ? `${width}×${height} · ${fpsLabel(fps)} к/с`
                : `${quality}p · ${turned ? shape.split(':').reverse().join(':') : shape} · ${fpsLabel(fps)} к/с`
            }
            action={
              <div className="flex items-center gap-1.5">
              {!custom && (
                // Поворот не объясняем словами: подписи форм сами
                // переворачиваются, и сразу видно, что получится.
                <button
                  type="button"
                  disabled={shape === '1:1'}
                  onClick={() => setTurned(!turned)}
                  title="Повернуть кадр: из 16:9 получится 9:16"
                  className={`flex h-[22px] w-[22px] items-center justify-center rounded-md transition-colors disabled:opacity-35 ${
                    turned ? 'bg-accent/20 text-accent-soft' : 'text-ink-faint hover:bg-surface-3'
                  }`}
                >
                  <RotateCw size={12} />
                </button>
              )}
              {/* Частота кадров — тоже свойство кадра: по ней собираются и
                  просмотр, и готовый файл, к её сетке прилипают игла и клипы. */}
              <FpsField value={fps} onChange={setFps} />
              </div>
            }
          >
            <Segmented
              columns={4}
              value={custom ? 'custom' : String(quality)}
              onChange={(value) => {
                if (value === 'custom') useCustom(true)
                else setQuality(Number(value))
              }}
              options={[
                ...FRAME_QUALITY.map((value) => ({ value: String(value), label: `${value}p` })),
                { value: 'custom', label: 'Свой' },
              ]}
            />
            {custom ? (
              <div className="flex items-end gap-2">
                <SizeField
                  label="Ширина"
                  value={width}
                  limit={7680}
                  onDone={(next) => setCustomSize(next, height)}
                />
                <span className="pb-2.5 text-ink-faint">×</span>
                <SizeField
                  label="Высота"
                  value={height}
                  limit={4320}
                  onDone={(next) => setCustomSize(width, next)}
                />
              </div>
            ) : (
              <Segmented
                columns={4}
                value={shape}
                onChange={setShape}
                options={FRAME_SHAPES.map((item) => ({
                  value: item.value,
                  label: turned ? item.label.split(':').reverse().join(':') : item.label,
                }))}
              />
            )}
          </Section>

          {/* Сборка — тут же, когда ничего не выбрано: колонка пустовала ровно
              тогда, когда пора собирать, а отдельное окно было лишним шагом.
              Выравнивание громкости — про весь монтаж, оно тоже здесь. */}
          <ComposeRenderPanel
            value={render}
            onChange={updateRender}
            loudnorm={loudnorm}
            onLoudnorm={setLoudnorm}
          />
          </>
          )}

        </div>

        {/* Всё про готовый файл собрано в одном месте, над кнопкой сборки:
            чем кодировать, как назвать и куда положить. Раньше это лежало
            вперемешку с настройками кадра и читалось как чужое. */}
        <div className="space-y-2 border-t border-line-soft px-4 py-3">
          {/* Добавить эффект, обрезку, маску — неброско, над сборкой: большая
              кнопка наверху колонки забирала на себя всё внимание. */}
          {mediaClip && !textClip && !fillClip && <ClipAddBar clip={mediaClip} />}
          {/* Имя и папка — одной строкой: это про один и тот же файл. */}
          <div className="flex items-center gap-2">
            <input
              className="field min-w-0 flex-1"
              value={outputName}
              onChange={(event) => setOutputName(event.target.value)}
              placeholder={DEFAULT_NAME}
              title={`Имя готового файла. Пустое — «${DEFAULT_NAME}»`}
            />
            <button
              type="button"
              onClick={() => setPickingFolder(true)}
              title={`Куда сохранить: ${outputDir ?? defaultOut ?? 'папку выберет программа'}`}
              className="field flex w-[42px] shrink-0 items-center justify-center px-0 hover:border-line"
            >
              <FolderOpen size={15} className="text-accent-soft" />
            </button>
          </div>
          <div className="flex items-center gap-1">
            <p
              className="min-w-0 flex-1 truncate text-[10.5px] text-ink-faint"
              title={outputDir ?? defaultOut ?? undefined}
            >
              {outputDir ?? defaultOut ?? 'папку выберет программа'}
            </p>
            {outputDir && (
              <button
                type="button"
                title="Вернуть папку рядом с первым файлом монтажа"
                onClick={() => {
                  setOutputDir(null)
                  localStorage.removeItem('sgh.composeOut')
                }}
                className="shrink-0 rounded p-0.5 text-ink-faint hover:text-ink-dim"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-stretch gap-2 border-t border-line-soft px-4 py-3">
          {/* Работа запоминается сама, но только последняя: чтобы вести
              несколько, их сохраняют под именами. */}
          <Button
            className="w-[42px] shrink-0 px-0"
            title="Мои проекты: сохранить нынешний или открыть прежний"
            onClick={() => setProjectsOpen(true)}
          >
            <Save size={15} />
          </Button>
          <Button
            tone="primary"
            className="min-w-0 flex-1 py-2.5"
            disabled={busy || !clips}
            onClick={() => void build()}
            title="Собрать готовое видео — от метки I до метки O, а без меток весь монтаж"
          >
            <Play size={15} />
            Рендер
          </Button>
          <Button
            className="w-[42px] shrink-0 px-0"
            title="Очистить таймлайн"
            disabled={!clips}
            onClick={() => {
              if (confirm('Убрать с таймлайна все клипы? Сами файлы останутся на месте.')) {
                clearAll()
              }
            }}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      </aside>
      </QuietHints>

      <ComposeProjects open={projectsOpen} onClose={() => setProjectsOpen(false)} />
      <ComposeMissing open={missingOpen} onClose={() => setMissingOpen(false)} />

      <ComposeFrameAsk
        question={frameQuestion}
        current={{ width, height, fps }}
        onSource={() => {
          if (frameQuestion) useCompose.getState().fitToSource(frameQuestion.width, frameQuestion.height)
          if (frameQuestion?.fps) setFps(frameQuestion.fps)
          setFrameQuestion(null)
          framePending.current = false
        }}
        onKeep={() => {
          setFrameQuestion(null)
          framePending.current = false
        }}
      />



      <FolderPicker
        open={pickingFolder}
        onClose={() => setPickingFolder(false)}
        title="Куда сохранить готовое видео"
        onPick={(path) => {
          setOutputDir(path)
          localStorage.setItem('sgh.composeOut', path)
        }}
      />
    </div>
  )
}

/** Частота кадров: «FPS: 60» и список одних чисел. */
function FpsField({ value, onChange }: { value: number; onChange: (fps: number) => void }) {
  const picked = FRAME_RATES.find((item) => Math.abs(item.value - value) < 1e-3)
  return (
    <Dropdown
      value={picked ? String(picked.value) : ''}
      align="right"
      options={FRAME_RATES.map((item) => ({ value: String(item.value), label: item.label }))}
      onChange={(next) => onChange(Number(next))}
      className="flex items-center gap-1 rounded-md border border-line-soft bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-dim hover:text-ink"
    >
      <span className="text-ink-faint">FPS:</span>
      <span className="font-mono tabular-nums text-ink">{fpsLabel(value)}</span>
      <ChevronDown size={12} className="text-ink-faint" />
    </Dropdown>
  )
}
