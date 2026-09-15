import { useEffect, useRef, useState } from 'react'
import { Film, FolderOpen, Play, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { timecode } from '../lib/format'
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
import { Button, Empty, Section, Segmented, Select, Toggle } from './ui'

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
  const clearAll = useCompose((state) => state.clearAll)

  const toast = useStore((state) => state.toast)
  const setQueueOpen = useStore((state) => state.setQueueOpen)
  const presets = useStore((state) => state.presets)

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
      }
      addClip(clip, trackId)
      // Игла переезжает на положенный клип: иначе она осталась бы на пустом
      // месте, и окно просмотра показало бы чёрный кадр — как будто файл
      // не добавился вовсе.
      useCompose.getState().setPlayhead(clip.start + Math.min(0.2, clip.duration / 2))
    } catch (error) {
      toast((error as Error).message, 'error')
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
      })
      setQueueOpen(true)
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const videoPresets = presets.video ?? []
  // Ищем по списку дорожек, а не через getState(): иначе панель справа не
  // узнает, что клип подвинули или растянули, — снимок хранилища не
  // подписывает компонент на изменения.
  const current = tracks.flatMap((track) => track.clips).find((clip) => clip.id === selected)

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Окно просмотра */}
        <div className="flex min-h-0 flex-1 items-center justify-center bg-black/40 p-4">
          {!clips ? (
            <Empty
              icon={<Film size={44} />}
              title="Перетащите файлы из медиатеки"
              hint="Картинки, видео и звук ложатся на дорожку внизу. Картинку можно растянуть за край — столько она и будет висеть на экране. Клип режется клавишей S под иглой, удаляется — Delete."
            />
          ) : frameError ? (
            <p className="max-w-md text-center text-[12px] leading-snug text-danger">{frameError}</p>
          ) : frameUrl ? (
            <img
              src={frameUrl}
              alt=""
              className="max-h-full max-w-full rounded-lg object-contain shadow-lg"
              style={{ aspectRatio: `${width} / ${height}` }}
            />
          ) : (
            <div
              className="rounded-lg bg-surface-2"
              style={{ aspectRatio: `${width} / ${height}`, width: '60%' }}
            />
          )}
        </div>

        {/* Таймлайн */}
        <div className="h-[220px] shrink-0 border-t border-line-soft bg-surface">
          <ComposeTimeline onDropFile={(path, at, trackId) => void dropFile(path, at, trackId)} />
        </div>
      </div>

      {/* Правая панель */}
      <aside className="flex w-[300px] shrink-0 flex-col border-l border-line-soft bg-surface">
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
          <Section title="Кадр проекта">
            <div>
              <span className="label">Качество</span>
              <Segmented
                columns={3}
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
              <>
                <div>
                  <span className="label">Форма</span>
                  <Segmented
                    columns={4}
                    value={shape}
                    onChange={setShape}
                    options={FRAME_SHAPES.map((item) => ({
                      value: item.value,
                      label: item.label,
                      title: item.hint,
                    }))}
                  />
                </div>
                <Toggle
                  checked={turned}
                  onChange={setTurned}
                  disabled={shape === '1:1'}
                  label="Повернуть кадр"
                  hint="Меняет форму местами: из 16:9 получается 9:16 — вертикальное видео для телефона."
                />
              </>
            )}

            <div className="space-y-1 rounded-lg bg-surface-2 px-3 py-2 text-[11.5px]">
              <div className="flex items-center justify-between">
                <span className="text-ink-faint">Размер кадра</span>
                <span className="font-mono tabular-nums text-ink-dim">
                  {width}×{height}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-faint">Длительность</span>
                <span className="font-mono tabular-nums text-ink-dim">
                  {timecode(duration, true)}
                </span>
              </div>
            </div>
            <p className="text-[11px] leading-snug text-ink-faint">
              Файлы другой формы впишутся внутрь кадра с чёрными полями — обрезать их
              программа не станет.
            </p>
          </Section>

          <Section title="Выбранный клип">
            {current ? (
              <ClipInfo clip={current} />
            ) : (
              <p className="text-[11.5px] leading-snug text-ink-faint">
                Клип не выбран. Нажмите на него на дорожке — здесь появятся его данные.
              </p>
            )}
          </Section>

          <Section title="Сборка">
            <Select
              label="Насколько сильно жать"
              value={presetId}
              options={videoPresets.map((preset) => ({ value: preset.id, label: preset.label }))}
              onChange={setPresetId}
              hint="Те же пресеты, что и в медиатеке. Размер кадра берётся из настроек проекта."
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
                title={outputDir ?? 'Рядом с первым файлом монтажа'}
              >
                <FolderOpen size={14} className="shrink-0 text-accent-soft" />
                <span className="min-w-0 flex-1 truncate text-[11.5px]">
                  {outputDir ?? 'Рядом с первым файлом'}
                </span>
              </button>
              {outputDir && (
                <button
                  type="button"
                  onClick={() => setOutputDir(null)}
                  className="mt-1 text-[11px] text-ink-faint hover:text-ink-dim"
                >
                  Вернуть «рядом с первым файлом»
                </button>
              )}
            </div>
          </Section>
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

/** Что показываем про выбранный клип. */
function ClipInfo({ clip }: { clip: ComposeClip }) {
  const removeClip = useCompose((state) => state.removeClip)
  const updateClip = useCompose((state) => state.updateClip)
  const update = (patch: Partial<ComposeClip>) => updateClip(clip.id, patch)
  return (
    <div className="space-y-2">
      <p className="truncate text-[12.5px] font-medium text-ink" title={clip.name}>
        {clip.name}
      </p>
      <dl className="space-y-1 rounded-lg bg-surface-2 px-3 py-2 text-[11.5px]">
        <Row label="Начало" value={timecode(clip.start, true)} />
        <Row label="Длительность" value={timecode(clip.duration, true)} />
        {clip.kind !== 'image' && <Row label="Взято с" value={timecode(clip.sourceIn, true)} />}
        <Row
          label="Тип"
          value={clip.kind === 'image' ? 'картинка' : clip.kind === 'audio' ? 'звук' : 'видео'}
        />
      </dl>
      <p className="text-[11px] leading-snug text-ink-faint">
        {clip.kind === 'image'
          ? 'Тяните за края на дорожке — столько картинка и будет висеть.'
          : 'Тяните за края, чтобы отрезать лишнее с начала или с конца.'}
      </p>

      {/* Звук есть у музыки и у роликов с дорожкой. У картинки его нет. */}
      {(clip.kind === 'audio' || (clip.kind === 'video' && clip.hasAudio)) && (
        <div className="space-y-2 rounded-lg bg-surface-2 px-3 py-2.5">
          <div>
            <div className="flex items-center justify-between">
              <span className="label">Громкость</span>
              <span className="font-mono text-[11px] tabular-nums text-ink-dim">
                {clip.muted ? 'выкл' : `${Math.round(clip.volume * 100)}%`}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={200}
              step={5}
              disabled={clip.muted}
              value={Math.round(clip.volume * 100)}
              onChange={(event) => update({ volume: Number(event.target.value) / 100 })}
              className="w-full"
            />
          </div>

          <div className="flex gap-2">
            <label className="flex-1">
              <span className="label">Появление</span>
              <input
                type="number"
                className="field"
                min={0}
                max={30}
                step={0.5}
                value={clip.fadeIn}
                onChange={(event) => update({ fadeIn: Math.max(0, Number(event.target.value)) })}
              />
            </label>
            <label className="flex-1">
              <span className="label">Уход</span>
              <input
                type="number"
                className="field"
                min={0}
                max={30}
                step={0.5}
                value={clip.fadeOut}
                onChange={(event) => update({ fadeOut: Math.max(0, Number(event.target.value)) })}
              />
            </label>
          </div>
          <p className="text-[11px] leading-snug text-ink-faint">
            Секунды плавного нарастания и затухания по краям клипа.
          </p>

          {clip.kind === 'video' && (
            <Toggle
              checked={clip.muted}
              onChange={(value) => update({ muted: value })}
              label="Без звука"
              hint="Выбросить родную дорожку ролика — например, когда под видео кладут свою музыку."
            />
          )}
        </div>
      )}
      <Button className="w-full" onClick={() => removeClip(clip.id)}>
        <Trash2 size={14} />
        Убрать с дорожки
      </Button>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="font-mono tabular-nums text-ink-dim">{value}</dd>
    </div>
  )
}
