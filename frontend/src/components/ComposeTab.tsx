import { useEffect, useRef, useState } from 'react'
import {
  Camera,
  ChevronDown,
  Film,
  FolderOpen,
  Grid3x3,
  Loader2,
  Save,
  Play,
  RotateCw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { parentDir, timecode } from '../lib/format'
import {
  DEFAULT_IMAGE_SECONDS,
  FRAME_QUALITY,
  FRAME_SHAPES,
  useCompose,
  type ComposeClip,
  type ComposeTrack,
} from '../composeStore'
import { useStore } from '../store'
import {
  COMPACT_HEIGHT,
  ComposeTimeline,
  RULER_HEIGHT,
  TOOLBAR_HEIGHT,
  TRACK_HEIGHT,
} from './ComposeTimeline'
import { ComposeFrameBox, ComposeGrid, GRIDS, type GridKind } from './ComposeFrameBox'
import { ComposeProjects } from './ComposeProjects'
import {
  ComposeRenderSettings,
  DEFAULT_RENDER,
  renderSummary,
  type RenderSettings,
} from './ComposeRender'
import { FolderPicker } from './FolderPicker'
import { MasterMeter, METER_DEFAULT } from './MasterMeter'
import { useComposePlayer } from '../hooks/useComposePlayer'
import { Button, Dropdown, Empty, IconButton, Segmented, Toggle } from './ui'

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
const VIEWS = [1, 1.5, 2, 3, 4]

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
  const setCustomSize = useCompose((state) => state.setCustomSize)
  const useCustom = useCompose((state) => state.useCustom)
  const addClip = useCompose((state) => state.addClip)
  const addPair = useCompose((state) => state.addPair)
  const clearAll = useCompose((state) => state.clearAll)
  const renderIn = useCompose((state) => state.renderIn)
  const renderOut = useCompose((state) => state.renderOut)
  const compact = useCompose((state) => state.compact)
  const masterVolume = useCompose((state) => state.masterVolume)
  const setMasterVolume = useCompose((state) => state.setMasterVolume)
  const loudnorm = useCompose((state) => state.loudnorm)
  const setLoudnorm = useCompose((state) => state.setLoudnorm)

  const toast = useStore((state) => state.toast)
  const setQueueOpen = useStore((state) => state.setQueueOpen)
  const settings = useStore((state) => state.settings)

  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [frameError, setFrameError] = useState<string | null>(null)
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
  const [renderOpen, setRenderOpen] = useState(false)
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
  const frameBox = useRef<HTMLDivElement>(null)
  const player = useComposePlayer(videoRef)
  // Чтение файла занимает мгновение, но окно без этого выглядит зависшим.
  // Держим и место, откуда началась работа: значок должен появиться под
  // курсором сразу, а не после первого движения мыши.
  const [adding, setAdding] = useState<{ x: number; y: number } | null>(null)
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
      api
        .composeFrame(
          {
            project: {
              width: view.width,
              height: view.height,
              fps: view.fps,
              tracks: view.tracks,
            },
            at: playhead,
            preview_width: 960,
          },
          control.signal,
        )
        .then((blob) => {
          setFrameUrl((old) => {
            if (old) URL.revokeObjectURL(old)
            return URL.createObjectURL(blob)
          })
          setFrameError(null)
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
  }, [playhead, clips, tracks, player.playing])

  // Картинку держим ровно до следующей: иначе браузер копит их в памяти.
  useEffect(() => () => {
    if (frameUrl) URL.revokeObjectURL(frameUrl)
  }, [frameUrl])

  /** Файл притащили из медиатеки — добавляем клип на дорожку. */
  async function dropFile(
    path: string,
    at: number,
    trackId: string,
    from: { x: number; y: number },
  ) {
    setAdding(from)
    try {
      const info = await api.fileInfo(path)
      if (info.kind === 'other') {
        toast('Такой файл в монтаж не положить', 'error')
        return
      }
      const length = info.media?.duration ?? 0
      const clip: Omit<ComposeClip, 'id'> = {
        source: info.path,
        name: info.name,
        kind: info.kind === 'audio' ? 'audio' : info.kind === 'image' ? 'image' : 'video',
        start: Math.max(0, Math.round(at * 100) / 100),
        // Картинка висит столько, сколько скажут; у ролика берём его длину.
        duration: info.kind === 'image' ? DEFAULT_IMAGE_SECONDS : Math.max(0.2, length),
        sourceIn: 0,
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
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setAdding(null)
    }
  }

  async function build() {
    setBusy(true)
    try {
      const state = useCompose.getState()
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
        output_name: outputName.trim() || 'Монтаж',
        render,
        start: renderIn,
        end: renderOut,
      })
      setQueueOpen(true)
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
        outputName: outputName || 'Монтаж',
      })
      toast('Кадр сохранён — в полном размере кадра проекта, без сжатия', 'ok')
      setQueueOpen(true)
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setSnapping(false)
    }
  }

  // Высота таймлайна растёт вместе с числом дорожек, но до предела: кадр в
  // окне просмотра важнее, и отдавать ему меньше половины окна нельзя. Сжатые
  // дорожки занимают втрое меньше — ради этого их и сжимают.
  const timelineHeight = Math.min(
    380,
    TOOLBAR_HEIGHT +
      RULER_HEIGHT +
      12 +
      tracks.length * (compact ? COMPACT_HEIGHT : TRACK_HEIGHT),
  )

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

  // Куда ляжет файл, если папку не выбирали: та же, что выберет сервер —
  // папка первого клипа плюс подпапка из настроек. Показываем её целиком:
  // «рядом с первым файлом» ничего не говорит, когда папок были десятки.
  const firstClip = tracks.flatMap((track) => track.clips)[0]
  const defaultOut = firstClip
    ? `${parentDir(firstClip.source)}\\${settings?.export?.output_folder || 'Обработанное'}`
    : null
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
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-2/60 p-4"
            onWheel={(event) => {
              // Колесо увеличивает сам экран просмотра, а не файлы на нём.
              // Точка под курсором остаётся на месте: иначе на приближении
              // нужный кусок кадра уезжает неизвестно куда.
              if (!clips) return
              event.preventDefault()
              const box = frameBox.current?.getBoundingClientRect()
              const next = Math.min(
                6,
                Math.max(1, Number((view * (event.deltaY < 0 ? 1.15 : 1 / 1.15)).toFixed(3))),
              )
              if (box) {
                const toX = event.clientX - (box.left + box.width / 2)
                const toY = event.clientY - (box.top + box.height / 2)
                const keep = next / view
                setPan({
                  x: next === 1 ? 0 : toX - (toX - pan.x) * keep,
                  y: next === 1 ? 0 : toY - (toY - pan.y) * keep,
                })
              }
              setView(next)
            }}
            // Зажатое колесо таскает кадр: при большом увеличении иначе не
            // добраться до нужного угла.
            onMouseDown={(event) => {
              if (event.button !== 1 || view <= 1) return
              event.preventDefault()
              const from = { x: event.clientX, y: event.clientY }
              const was = { ...pan }
              const move = (moved: MouseEvent) => {
                setPan({
                  x: was.x + (moved.clientX - from.x),
                  y: was.y + (moved.clientY - from.y),
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
                Поверх картинки её ставить нельзя — кнопка посреди кадра
                закрывает собой то, ради чего окно и нужно. */}
            {clips > 0 && (
              <div className="mb-2 flex shrink-0 flex-wrap items-center justify-center gap-1.5">
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
                    className={`inline-flex h-8 items-center rounded-lg px-2 font-mono text-[11px] tabular-nums transition-colors ${
                      view > 1
                        ? 'bg-accent/20 text-accent-soft hover:bg-accent/30'
                        : 'text-ink-faint hover:text-ink'
                    }`}
                  >
                    {Math.round(view * 100)}%
                  </button>
                  <Dropdown
                    value={String(view)}
                    title="Насколько увеличить экран"
                    className="flex h-8 w-4 items-center justify-center text-ink-faint hover:text-ink"
                    options={VIEWS.map((item) => ({
                      value: String(item),
                      label: `Экран ${Math.round(item * 100)}%`,
                    }))}
                    onChange={(item) => {
                      setView(Number(item))
                      setPan({ x: 0, y: 0 })
                    }}
                  >
                    <ChevronDown size={12} />
                  </Dropdown>
                </div>

                {/* Сетка — не только разметка для глаза: клип к её линиям
                    прилипает, поэтому точное положение можно набрать мышью.
                    Кнопка включает и выключает, список рядом меняет вид. */}
                <div className="flex items-center">
                  <IconButton
                    title="Сетка поверх кадра. К её линиям, к краям кадра и к его середине клип прилипает, когда его двигают."
                    active={gridOn}
                    onClick={() => {
                      setGridOn((on) => {
                        localStorage.setItem('sgh.composeGridOn', on ? '0' : '1')
                        return !on
                      })
                    }}
                  >
                    <Grid3x3 size={14} />
                  </IconButton>
                  {/* Галочка рядом со значком: сам список нужен редко, а
                      место занимал бы постоянно, поэтому от него оставлена
                      только стрелка. */}
                  <Dropdown
                    value={gridKind}
                    title="Какая сетка"
                    className="flex h-8 w-4 items-center justify-center text-ink-faint hover:text-ink"
                    options={GRIDS.filter((item) => item.value !== 'none')}
                    onChange={(value) => {
                      setGridKind(value)
                      setGridOn(true)
                      localStorage.setItem('sgh.composeGrid', value)
                      localStorage.setItem('sgh.composeGridOn', '1')
                    }}
                  >
                    <ChevronDown size={12} />
                  </Dropdown>
                </div>

                <Dropdown
                  value={String(player.quality)}
                  title="Качество просмотра. На готовый файл не влияет — только на то, что видно здесь."
                  className="flex h-8 items-center gap-1.5 rounded-lg border border-line-soft bg-surface-2 px-2 text-[11px] text-ink-dim hover:text-ink"
                  options={[
                    { value: 'auto', label: 'Качество просмотра: авто' },
                    { value: '360', label: 'Качество просмотра: 360p' },
                    { value: '480', label: 'Качество просмотра: 480p' },
                    { value: '720', label: 'Качество просмотра: 720p' },
                  ]}
                  onChange={(value) =>
                    player.setQuality(
                      value === 'auto' ? 'auto' : (Number(value) as 360 | 480 | 720),
                    )
                  }
                >
                  {player.quality === 'auto' ? 'авто' : `${player.quality}p`}
                  <ChevronDown size={12} className="text-ink-faint" />
                </Dropdown>

                <IconButton
                  title="Сохранить кадр картинкой"
                  onClick={() => void grabFrame()}
                  disabled={snapping}
                >
                  <Camera size={14} />
                </IconButton>
              </div>
            )}

            <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden">
            {!clips ? (
              <Empty
                icon={<Film size={44} />}
                title="Перетащите файлы из медиатеки"
                hint="Картинки, видео и звук ложатся на дорожки внизу. Картинку можно растянуть за край — столько она и будет висеть на экране. Клип режется клавишей S под иглой, удаляется — Delete."
              />
            ) : (
              <div
                ref={frameBox}
                className="relative overflow-hidden bg-black shadow-xl ring-1 ring-line"
                style={{
                  aspectRatio: `${width} / ${height}`,
                  // Кадр вписывается в свободное место и не растягивает окно:
                  // с одной только высотой широкий проект выдавливал правую
                  // панель за край экрана.
                  maxWidth: '100%',
                  maxHeight: '100%',
                  height: '100%',
                  width: 'auto',
                }}
              >
              {/* Всё содержимое кадра увеличивается целиком — и картинка, и
                  сетка, и рамка клипа. Точка увеличения та, где было колесо,
                  поэтому нужное место остаётся под курсором. */}
              <div
                className="absolute inset-0"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${view})`,
                }}
              >
                {/* Пока смотрим — играет собранный кусок, иначе показываем
                    кадр под иглой. Снаружи разницы нет: то же окно. */}
                <video
                  ref={videoRef}
                  className={`h-full w-full object-contain ${player.playing ? '' : 'hidden'}`}
                  onEnded={() => void player.onEnded()}
                  onError={() => player.stop()}
                />
                {!player.playing && frameUrl && (
                  <img src={frameUrl} alt="" className="h-full w-full object-contain" />
                )}
                {!player.playing && frameError && (
                  <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-[12px] leading-snug text-danger">
                    {frameError}
                  </p>
                )}

                {/* Рамка выбранного клипа: за неё его двигают и меняют
                    размер прямо в кадре. Пока клип не выбран, рамки нет —
                    иначе она мешала бы просто смотреть. */}
                <ComposeGrid kind={grid} />

                {!player.playing && placing && (
                  <ComposeFrameBox clip={placing} grid={grid} />
                )}

              </div>

                {player.error && (
                  <p className="absolute inset-x-0 bottom-0 bg-danger/85 px-3 py-1.5 text-center text-[11px] text-white">
                    {player.error}
                  </p>
                )}
              </div>
            )}
            </div>
          </div>

          <MasterMeter
            levels={player.levels}
            master={masterVolume}
            onMaster={setMasterVolume}
            active={player.playing}
            loudnorm={loudnorm}
            width={meterWidth}
            onWidth={(value) => {
              setMeterWidth(value)
              localStorage.setItem('sgh.composeMeter', String(value))
            }}
          />
        </div>

        {/* Таймлайн */}
        <div
          className="shrink-0 border-t border-line-soft bg-surface"
          style={{ height: timelineHeight }}
        >
          <ComposeTimeline
            adding={adding !== null}
            player={player}
            onDropFile={(path, at, trackId, from) => void dropFile(path, at, trackId, from)}
          />
        </div>
      </div>

      {/* Правая панель */}
      <aside className="flex w-[300px] shrink-0 flex-col border-l border-line-soft bg-surface">
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
          {/* Кадр проекта. Без заголовка и без лишних чисел: что выбрано,
              видно по самим кнопкам, а форму кадра показывает рамка в окне
              просмотра. Раздел «Клип» тоже убран — имя файла, громкость и
              затухания живут на самом таймлайне. */}
          <div className="space-y-3">
            <div>
              <span className="label">Качество</span>
              <Segmented
                columns={4}
                value={custom ? 'custom' : String(quality)}
                onChange={(value) => {
                  if (value === 'custom') useCustom(true)
                  else setQuality(Number(value))
                }}
                options={[
                  ...FRAME_QUALITY.map((value) => ({
                    value: String(value),
                    label: `${value}p`,
                    title: 'Короткая сторона кадра',
                  })),
                  { value: 'custom', label: 'Свой', title: 'Задать ширину и высоту вручную' },
                ]}
              />
            </div>

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
              <div>
                <div className="flex items-center justify-between">
                  <span className="label">Форма</span>
                  {/* Поворот не объясняем словами: подписи форм сами
                      переворачиваются, и сразу видно, что получится. */}
                  <button
                    type="button"
                    disabled={shape === '1:1'}
                    onClick={() => setTurned(!turned)}
                    title="Повернуть кадр: из 16:9 получится 9:16"
                    className={`mb-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-35 ${
                      turned ? 'bg-accent/20 text-accent-soft' : 'text-ink-faint hover:bg-surface-3'
                    }`}
                  >
                    <RotateCw size={11} />
                    вертикально
                  </button>
                </div>
                <Segmented
                  columns={4}
                  value={shape}
                  onChange={setShape}
                  options={FRAME_SHAPES.map((item) => ({
                    value: item.value,
                    label: turned ? item.label.split(':').reverse().join(':') : item.label,
                    title: item.hint,
                  }))}
                />
              </div>
            )}
          </div>

          <div className="space-y-3 border-t border-line-soft pt-4">
            <Toggle
              checked={loudnorm}
              onChange={setLoudnorm}
              label="Выровнять звук"
              hint="Приводит громкость всего файла к общему уровню, как на радио. Пока включено, фейдер громкости заперт."
            />
          </div>
        </div>

        {/* Всё про готовый файл собрано в одном месте, над кнопкой сборки:
            чем кодировать, как назвать и куда положить. Раньше это лежало
            вперемешку с настройками кадра и читалось как чужое. */}
        <div className="space-y-2 border-t border-line-soft px-4 py-3">
          <div>
            <button
              type="button"
              onClick={() => setRenderOpen(true)}
              className="field flex w-full items-center gap-2 text-left hover:border-line"
            >
              <SlidersHorizontal size={14} className="shrink-0 text-accent-soft" />
              <span className="flex-1 text-[12.5px]">Настройки сборки</span>
            </button>
            <p className="mt-1 text-[11px] leading-snug text-ink-faint">
              {renderSummary(render)}
            </p>
          </div>

          {/* Имя и папка — одной строкой: это про один и тот же файл. */}
          <div className="flex items-center gap-2">
            <input
              className="field min-w-0 flex-1"
              value={outputName}
              onChange={(event) => setOutputName(event.target.value)}
              placeholder="Название будущего файла"
              title="Имя готового файла"
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
              {outputDir ?? defaultOut ?? 'Положите файл на таймлайн'}
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
          {/* Монтаж запоминается сам, но только последний: чтобы вести
              несколько, их сохраняют под именами. */}
          <Button
            className="w-[42px] shrink-0 px-0"
            title="Мои монтажи: сохранить нынешний или открыть прежний"
            onClick={() => setProjectsOpen(true)}
          >
            <Save size={15} />
          </Button>
          <Button
            tone="primary"
            className="min-w-0 flex-1 py-2.5"
            disabled={busy || !clips}
            onClick={() => void build()}
          >
            <Play size={15} />
            Собрать видео
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

      <ComposeProjects open={projectsOpen} onClose={() => setProjectsOpen(false)} />

      <ComposeRenderSettings
        open={renderOpen}
        onClose={() => setRenderOpen(false)}
        value={render}
        onChange={(next) => {
          setRender(next)
          localStorage.setItem('sgh.composeRender', JSON.stringify(next))
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
