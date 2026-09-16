import { useEffect, useRef, useState } from 'react'
import {
  Camera,
  Film,
  FolderOpen,
  Grid3x3,
  Save,
  Play,
  RotateCw,
  Search,
  Trash2,
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
import { ComposeProjects } from './ComposeProjects'
import { FolderPicker } from './FolderPicker'
import { MasterMeter, METER_DEFAULT } from './MasterMeter'
import { useComposePlayer } from '../hooks/useComposePlayer'
import { Button, Empty, IconButton, Segmented, Select, Toggle } from './ui'

/**
 * Какие клипы приближает колесо и кнопки.
 *
 * Берём все выбранные, а не строго один: после группировки или рамки их
 * обычно несколько, и требовать ровно одного значило бы «приближение иногда
 * не работает». Ничего не выбрано — приближаем то, что сейчас в кадре: человек
 * видит эту картинку перед собой, и лезть на таймлайн выделять её незачем.
 */
function zoomTargets(state: {
  tracks: ComposeTrack[]
  selected: string[]
  playhead: number
}): ComposeClip[] {
  const visible = state.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => clip.kind !== 'audio')
  return state.selected.length
    ? visible.filter((clip) => state.selected.includes(clip.id))
    : visible.filter(
        (clip) => clip.start <= state.playhead && clip.start + clip.duration > state.playhead,
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
  const presets = useStore((state) => state.presets)
  const settings = useStore((state) => state.settings)

  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [frameError, setFrameError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [presetId, setPresetId] = useState('pack_balanced')
  // Куда и под каким именем сохранять. Папку запоминаем: готовое обычно
  // складывают в одно и то же место, и выбирать его каждый раз заново незачем.
  const [outputName, setOutputName] = useState('Монтаж')
  const [outputDir, setOutputDir] = useState<string | null>(
    () => localStorage.getItem('sgh.composeOut') || null,
  )
  const [pickingFolder, setPickingFolder] = useState(false)
  // Окно сохранённых монтажей: программа сама помнит только последний.
  const [projectsOpen, setProjectsOpen] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const player = useComposePlayer(videoRef)
  // Чтение файла занимает мгновение, но окно без этого выглядит зависшим.
  const [adding, setAdding] = useState(false)
  // Сетка поверх кадра, как в медиатеке: по ней видно, попадает ли важное в
  // середину. Выбор запоминается — включают её обычно надолго.
  const [grid, setGrid] = useState(() => localStorage.getItem('sgh.composeGrid') === '1')
  const [snapping, setSnapping] = useState(false)
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
    const timer = setTimeout(() => {
      pending.current?.abort()
      const control = new AbortController()
      pending.current = control
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
    }, 80)
    return () => clearTimeout(timer)
  }, [playhead, clips, tracks, player.playing])

  // Картинку держим ровно до следующей: иначе браузер копит их в памяти.
  useEffect(() => () => {
    if (frameUrl) URL.revokeObjectURL(frameUrl)
  }, [frameUrl])

  /** Файл притащили из медиатеки — добавляем клип на дорожку. */
  async function dropFile(path: string, at: number, trackId: string) {
    setAdding(true)
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
      setAdding(false)
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
        preset_id: presetId,
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

  // Насколько приближено то, что сейчас в кадре. Показываем самое большое из
  // выбранных: иначе непонятно, почему картинка мыльная — приблизил колесом,
  // забыл, и следов на экране не осталось.
  const zoomed = zoomTargets({ tracks, selected, playhead })
  const zoom = zoomed.reduce((most, clip) => Math.max(most, clip.zoom), 1)

  /** Приближает или отдаляет всё, к чему сейчас относится колесо. */
  function changeZoom(factor: number) {
    const state = useCompose.getState()
    const picked = zoomTargets(state)
    for (const clip of picked) {
      const next = Math.min(8, Math.max(1, factor === 0 ? 1 : clip.zoom * factor))
      state.updateClip(clip.id, { zoom: Number(next.toFixed(3)) })
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

  const videoPresets = presets.video ?? []
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
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Окно просмотра.

            Фон не чёрный, и у кадра есть рамка: иначе чёрные поля вокруг
            вертикального видео сливались с фоном, и понять, какой формы
            получится кадр, было невозможно — всё выглядело прямоугольником. */}
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-2/60 p-4"
            onWheel={(event) => {
              // Колесо над кадром приближает выбранные картинки и видео — как
              // в монтажных программах. Берём все выбранные, а не строго один:
              // после группировки или рамки их обычно несколько, и требовать
              // ровно одного значило бы «колесо иногда не работает».
              const state = useCompose.getState()
              const picked = zoomTargets(state)
              if (!picked.length) return
              event.preventDefault()
              for (const clip of picked) {
                const next = Math.min(8, Math.max(1, clip.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)))
                state.updateClip(clip.id, { zoom: Number(next.toFixed(3)) })
              }
            }}
          >
            {/* Панель над кадром: сетка, приближение, качество и снимок.
                Поверх картинки её ставить нельзя — кнопка посреди кадра
                закрывает собой то, ради чего окно и нужно. */}
            {clips > 0 && (
              <div className="mb-2 flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                <div className="mr-auto flex items-center gap-1">
                  <IconButton
                    title="Отдалить"
                    onClick={() => changeZoom(1 / 1.1)}
                    disabled={!zoomed.length || zoom <= 1}
                  >
                    <span className="text-[13px] font-semibold">−</span>
                  </IconButton>
                  <button
                    type="button"
                    onClick={() => changeZoom(0)}
                    disabled={zoom <= 1}
                    title={
                      zoom > 1
                        ? 'Нажмите, чтобы вернуть обычный размер'
                        : 'Приближение: колесо над кадром или эти кнопки'
                    }
                    className={`inline-flex h-8 items-center gap-1 rounded-lg px-2 font-mono text-[11px] tabular-nums transition-colors ${
                      zoom > 1
                        ? 'bg-accent/20 text-accent-soft hover:bg-accent/30'
                        : 'text-ink-faint'
                    }`}
                  >
                    <Search size={12} />
                    ×{zoom.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}
                  </button>
                  <IconButton
                    title="Приблизить"
                    onClick={() => changeZoom(1.1)}
                    disabled={!zoomed.length || zoom >= 8}
                  >
                    <span className="text-[13px] font-semibold">+</span>
                  </IconButton>
                </div>

                <IconButton
                  title="Сетка поверх кадра"
                  active={grid}
                  onClick={() => {
                    setGrid((on) => {
                      localStorage.setItem('sgh.composeGrid', on ? '0' : '1')
                      return !on
                    })
                  }}
                >
                  <Grid3x3 size={14} />
                </IconButton>

                <select
                  value={String(player.quality)}
                  onChange={(event) => {
                    const value = event.target.value
                    player.setQuality(value === 'auto' ? 'auto' : (Number(value) as 360 | 480 | 720))
                  }}
                  title="Качество просмотра. На готовый файл не влияет — только на то, что видно здесь."
                  className="h-8 rounded-lg border border-line-soft bg-surface-2 px-2 text-[11px] text-ink-dim outline-none hover:text-ink focus:border-accent"
                >
                  <option value="auto">Просмотр: авто</option>
                  <option value="360">Просмотр: 360p</option>
                  <option value="480">Просмотр: 480p</option>
                  <option value="720">Просмотр: 720p</option>
                </select>

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
                className="relative overflow-hidden rounded-lg bg-black shadow-xl ring-1 ring-line"
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

                {/* Сетка по третям: по ней видно, что попадает в середину
                    кадра, а что уедет к краю. */}
                {grid && (
                  <div className="pointer-events-none absolute inset-0">
                    <div className="absolute inset-y-0 left-1/3 w-px bg-white/25" />
                    <div className="absolute inset-y-0 left-2/3 w-px bg-white/25" />
                    <div className="absolute inset-x-0 top-1/3 h-px bg-white/25" />
                    <div className="absolute inset-x-0 top-2/3 h-px bg-white/25" />
                  </div>
                )}

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
            adding={adding}
            player={player}
            onDropFile={(path, at, trackId) => void dropFile(path, at, trackId)}
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
                <label className="flex-1">
                  <span className="label">Ширина</span>
                  <input
                    type="number"
                    className="field"
                    value={width}
                    min={16}
                    max={7680}
                    onChange={(event) => setCustomSize(Number(event.target.value) || 16, height)}
                  />
                </label>
                <span className="pb-2.5 text-ink-faint">×</span>
                <label className="flex-1">
                  <span className="label">Высота</span>
                  <input
                    type="number"
                    className="field"
                    value={height}
                    min={16}
                    max={4320}
                    onChange={(event) => setCustomSize(width, Number(event.target.value) || 16)}
                  />
                </label>
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
            <Select
              label="Насколько сильно жать"
              value={presetId}
              options={videoPresets.map((preset) => ({ value: preset.id, label: preset.label }))}
              onChange={setPresetId}
            />

            <Toggle
              checked={loudnorm}
              onChange={setLoudnorm}
              label="Выровнять звук"
              hint="Приводит громкость готового файла к единому уровню — та же настройка, что и при обычной обработке."
            />

            <label className="block">
              <span className="label">Имя файла</span>
              <input
                className="field"
                value={outputName}
                onChange={(event) => setOutputName(event.target.value)}
                placeholder="Монтаж"
              />
            </label>

            <div>
              <span className="label">Куда сохранить</span>
              <button
                type="button"
                onClick={() => setPickingFolder(true)}
                className="field flex w-full items-center gap-2 text-left hover:border-line"
                title={outputDir ?? defaultOut ?? 'Папку выберет программа'}
              >
                <FolderOpen size={14} className="shrink-0 text-accent-soft" />
                <span className="min-w-0 flex-1 truncate text-[11.5px]">
                  {outputDir ?? defaultOut ?? 'Положите файл на таймлайн'}
                </span>
              </button>
              {outputDir && (
                <button
                  type="button"
                  onClick={() => {
                    setOutputDir(null)
                    localStorage.removeItem('sgh.composeOut')
                  }}
                  className="mt-1 text-[11px] text-ink-faint hover:text-ink-dim"
                >
                  Вернуть папку рядом с исходником
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Сборка — главная кнопка, остальное по краям значками: три кнопки в
            ряд занимали треть панели, а нажимают из них обычно одну. */}
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
