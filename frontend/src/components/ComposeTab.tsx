import { useEffect, useRef, useState } from 'react'
import { Film, FolderOpen, Play, RotateCw, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { parentDir, timecode } from '../lib/format'
import {
  DEFAULT_IMAGE_SECONDS,
  FRAME_QUALITY,
  FRAME_SHAPES,
  useCompose,
  type ComposeClip,
} from '../composeStore'
import { useStore } from '../store'
import { ComposeTimeline } from './ComposeTimeline'
import { FolderPicker } from './FolderPicker'
import { Button, Empty, Segmented, Select } from './ui'

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
  // Чтение файла занимает мгновение, но окно без этого выглядит зависшим.
  const [adding, setAdding] = useState(false)

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
    if (!clips) {
      setFrameUrl(null)
      return
    }
    const timer = setTimeout(() => {
      pending.current?.abort()
      const control = new AbortController()
      pending.current = control
      const { width: w, height: h, fps, tracks: list } = useCompose.getState()
      api
        .composeFrame(
          {
            project: { width: w, height: h, fps, tracks: list },
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
  }, [playhead, clips, tracks])

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
      const { width: w, height: h, fps, tracks: list } = useCompose.getState()
      await api.composeBuild({
        project: { width: w, height: h, fps, tracks: list },
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
        <div
          className="flex min-h-0 flex-1 items-center justify-center bg-surface-2/60 p-5"
          onWheel={(event) => {
            // Колесо над кадром приближает выбранные картинки и видео — как в
            // монтажных программах. Берём все выбранные, а не строго один:
            // после группировки или рамки их обычно несколько, и требовать
            // ровно одного значило бы «колесо иногда не работает».
            const state = useCompose.getState()
            const picked = state.tracks
              .flatMap((track) => track.clips)
              .filter((clip) => state.selected.includes(clip.id) && clip.kind !== 'audio')
            if (!picked.length) return
            event.preventDefault()
            for (const clip of picked) {
              const next = Math.min(8, Math.max(1, clip.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)))
              state.updateClip(clip.id, { zoom: Number(next.toFixed(3)) })
            }
          }}
        >
          {!clips ? (
            <Empty
              icon={<Film size={44} />}
              title="Перетащите файлы из медиатеки"
              hint="Картинки, видео и звук ложатся на дорожку внизу. Картинку можно растянуть за край — столько она и будет висеть на экране. Клип режется клавишей S под иглой, удаляется — Delete."
            />
          ) : frameError ? (
            <p className="max-w-md text-center text-[12px] leading-snug text-danger">{frameError}</p>
          ) : (
            // Рамка показывает границы кадра проекта: по ней видно и форму
            // (квадрат, вертикаль), и то, сколько места занимают чёрные поля.
            <div
              className="relative max-h-full max-w-full overflow-hidden rounded-lg bg-black ring-1 ring-line shadow-xl"
              style={{ aspectRatio: `${width} / ${height}`, height: '100%' }}
            >
              {frameUrl && <img src={frameUrl} alt="" className="h-full w-full object-contain" />}
            </div>
          )}
        </div>

        {/* Таймлайн */}
        <div className="h-[220px] shrink-0 border-t border-line-soft bg-surface">
          <ComposeTimeline
            adding={adding}
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

        <div className="space-y-2 border-t border-line-soft px-4 py-3">
          <Button
            tone="primary"
            className="w-full py-2.5"
            disabled={busy || !clips}
            onClick={() => void build()}
          >
            <Play size={15} />
            Собрать видео
          </Button>
          <Button
            className="w-full"
            disabled={!clips}
            onClick={() => {
              if (confirm('Убрать с таймлайна все клипы? Сами файлы останутся на месте.')) {
                clearAll()
              }
            }}
          >
            <Trash2 size={14} />
            Очистить таймлайн
          </Button>
        </div>
      </aside>

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
