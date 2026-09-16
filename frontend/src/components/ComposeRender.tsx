import { useEffect, useState } from 'react'
import { Check, Pencil, Plus, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../store'
import { Button, Modal, Segmented, Select, Slider, Toggle } from './ui'

/**
 * Настройки сборки монтажа.
 *
 * Пресеты остальных вкладок сюда не годятся: они про то, как ужать чужой файл
 * до веса пака. Монтаж человек собирает начисто и сам решает, что ему нужно,
 * поэтому здесь настройки заданы прямо, а готовых наборов всего два — по
 * одному на каждый из привычных кодеков. Свои наборы человек складывает сам и
 * они лежат рядом с настройками программы.
 */
export interface RenderSettings {
  videoCodec: string
  /** Постоянное качество. Работает, пока не задан битрейт. */
  crf: number
  /** Целевой битрейт видео, кбит/с. Ноль — считать по качеству. */
  bitrateKbps: number
  speedPreset: string
  useGpu: boolean
  audioCodec: string
  audioBitrateKbps: number
  container: string
}

export interface RenderPreset extends RenderSettings {
  id: string
  label: string
}

/** Готовые наборы. Их не удалить и не переписать — только взять за основу. */
export const BUILTIN_PRESETS: RenderPreset[] = [
  {
    id: 'av1-best',
    label: 'AV1 · Opus — лучшее качество',
    videoCodec: 'av1_svt',
    crf: 22,
    bitrateKbps: 0,
    speedPreset: '5',
    useGpu: false,
    audioCodec: 'opus',
    audioBitrateKbps: 192,
    container: 'mp4',
  },
  {
    id: 'h264-best',
    label: 'H.264 · AAC — лучшее качество',
    videoCodec: 'h264',
    crf: 16,
    bitrateKbps: 0,
    speedPreset: 'slow',
    useGpu: false,
    audioCodec: 'aac',
    audioBitrateKbps: 256,
    container: 'mp4',
  },
]

export const DEFAULT_RENDER: RenderSettings = settingsOf(BUILTIN_PRESETS[0])

function settingsOf(preset: RenderPreset): RenderSettings {
  const { id: _id, label: _label, ...settings } = preset
  return settings
}

/** Совпадают ли нынешние настройки с набором — по этому его и подсвечиваем. */
function sameAs(value: RenderSettings, preset: RenderPreset): boolean {
  const settings = settingsOf(preset)
  return (Object.keys(settings) as (keyof RenderSettings)[]).every(
    (key) => value[key] === settings[key],
  )
}

const VIDEO_CODECS = [
  { value: 'av1_svt', label: 'AV1 — меньше вес при том же качестве' },
  { value: 'h265', label: 'H.265 (HEVC) — между AV1 и H.264' },
  { value: 'h264', label: 'H.264 — играет везде, даже в старом' },
]

const AUDIO_CODECS = [
  { value: 'opus', label: 'Opus — лучше всех при малом весе' },
  { value: 'aac', label: 'AAC — играет везде' },
  { value: 'mp3', label: 'MP3 — для совсем старого' },
  { value: 'flac', label: 'FLAC — без потерь, тяжёлый' },
  { value: 'none', label: 'Без звука' },
]

const CONTAINERS = [
  { value: 'mp4', label: 'MP4' },
  { value: 'mkv', label: 'MKV' },
  { value: 'webm', label: 'WebM' },
]

/**
 * Шкала качества у каждого кодека своя.
 *
 * Одно и то же число у AV1 и H.264 означает совсем разную картинку, и без
 * подписей понять, где ещё хорошо, а где уже сыпется, невозможно.
 */
const QUALITY_SCALE: Record<string, { max: number; marks: { at: number; label: string }[] }> = {
  av1_svt: {
    max: 63,
    marks: [
      { at: 18, label: 'как оригинал' },
      { at: 28, label: 'отлично' },
      { at: 38, label: 'хорошо' },
      { at: 48, label: 'заметно хуже' },
      { at: 58, label: 'сыпется' },
    ],
  },
  h265: {
    max: 51,
    marks: [
      { at: 16, label: 'как оригинал' },
      { at: 22, label: 'отлично' },
      { at: 28, label: 'хорошо' },
      { at: 34, label: 'заметно хуже' },
      { at: 42, label: 'сыпется' },
    ],
  },
  h264: {
    max: 51,
    marks: [
      { at: 14, label: 'как оригинал' },
      { at: 20, label: 'отлично' },
      { at: 26, label: 'хорошо' },
      { at: 32, label: 'заметно хуже' },
      { at: 40, label: 'сыпется' },
    ],
  },
}

/**
 * Подписи к шкале битрейта.
 *
 * Голое число кбит/с ничего не говорит: понятно оно только тем, кто и так
 * знает, сколько нужно. Поэтому рядом написано, для какой картинки это
 * обычно берут.
 */
const BITRATE_MARKS = [
  { at: 1500, label: 'мало' },
  { at: 4000, label: '720p' },
  { at: 9000, label: '1080p' },
  { at: 18000, label: '1440p' },
  { at: 30000, label: '4K' },
]

/** Какая подпись подходит нынешнему числу качества. */
function qualityWord(codec: string, crf: number): string {
  const scale = QUALITY_SCALE[codec] ?? QUALITY_SCALE.h264
  let word = scale.marks[0].label
  for (const mark of scale.marks) {
    if (crf >= mark.at) word = mark.label
  }
  return crf === 0 ? 'без потерь' : word
}

/** Названия скоростей: у AV1 это числа, у остальных — слова. */
function speedOptions(codec: string): { value: string; label: string }[] {
  if (codec === 'av1_svt') {
    return [
      { value: '2', label: 'Очень медленно' },
      { value: '4', label: 'Медленно' },
      { value: '5', label: 'Обычно' },
      { value: '7', label: 'Быстро' },
      { value: '9', label: 'Очень быстро' },
    ]
  }
  return [
    { value: 'veryslow', label: 'Очень медленно' },
    { value: 'slow', label: 'Медленно' },
    { value: 'medium', label: 'Обычно' },
    { value: 'fast', label: 'Быстро' },
    { value: 'veryfast', label: 'Очень быстро' },
  ]
}

/** Короткая строка под кнопкой: что получится, не открывая окно. */
export function renderSummary(value: RenderSettings): string {
  const video = VIDEO_CODECS.find((item) => item.value === value.videoCodec)
  const name = video ? video.label.split(' —')[0] : value.videoCodec
  const weight =
    value.bitrateKbps > 0
      ? `${value.bitrateKbps} кбит/с`
      : `качество ${value.crf} (${qualityWord(value.videoCodec, value.crf)})`
  const sound =
    value.audioCodec === 'none'
      ? 'без звука'
      : `${value.audioCodec.toUpperCase()} ${value.audioBitrateKbps} кбит/с`
  return `${name} · ${weight} · ${sound} · ${value.container.toUpperCase()}`
}

/**
 * Подписи под ползунком.
 *
 * Ближайшая к нынешнему значению подсвечена: по ней и понятно, что сейчас
 * выбрано, без оглядки на само число.
 */
function ScaleMarks({
  marks,
  min,
  max,
  at,
  active,
}: {
  marks: { at: number; label: string }[]
  min: number
  max: number
  at: number
  /** Подсветить именно эту подпись, а не ближайшую по расстоянию. */
  active?: string
}) {
  let near = marks[0]
  for (const mark of marks) {
    if (Math.abs(mark.at - at) < Math.abs(near.at - at)) near = mark
  }
  if (active) near = marks.find((mark) => mark.label === active) ?? near
  return (
    <div className="relative mt-1 h-7">
      {marks.map((mark) => (
        <span
          key={mark.at}
          className={`absolute top-0 -translate-x-1/2 whitespace-nowrap text-[9px] leading-tight ${
            mark === near ? 'text-accent-soft' : 'text-ink-faint/70'
          }`}
          style={{
            left: `${Math.min(94, Math.max(6, ((mark.at - min) / (max - min)) * 100))}%`,
          }}
        >
          <span className="block text-center">|</span>
          {mark.label}
        </span>
      ))}
    </div>
  )
}

export function ComposeRenderSettings({
  open,
  onClose,
  value,
  onChange,
}: {
  open: boolean
  onClose: () => void
  value: RenderSettings
  onChange: (value: RenderSettings) => void
}) {
  const toast = useStore((state) => state.toast)
  const [mine, setMine] = useState<RenderPreset[]>([])
  const [name, setName] = useState('')
  /** Какой набор сейчас переименовывают. */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renamed, setRenamed] = useState('')

  useEffect(() => {
    if (!open) return
    api
      .composeRenderPresets()
      .then((data) => setMine(data.presets ?? []))
      .catch(() => setMine([]))
  }, [open])

  const set = (patch: Partial<RenderSettings>) => onChange({ ...value, ...patch })

  async function keep(list: RenderPreset[]) {
    setMine(list)
    try {
      await api.composeRenderPresetsSave(list)
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }

  async function addMine() {
    const label = name.trim()
    if (!label) return
    const preset: RenderPreset = { ...value, id: `my-${Date.now().toString(36)}`, label }
    await keep([...mine.filter((item) => item.label !== label), preset])
    setName('')
    toast(`Набор «${label}» сохранён`, 'ok')
  }

  const scale = QUALITY_SCALE[value.videoCodec] ?? QUALITY_SCALE.h264
  const byBitrate = value.bitrateKbps > 0

  /** Кнопка набора: подсвечена, пока настройки совпадают с ним. */
  const presetRow = (preset: RenderPreset, own: boolean) => {
    const picked = sameAs(value, preset)
    return (
      <div key={preset.id} className="flex items-center gap-1">
        {renaming === preset.id ? (
          <>
            <input
              autoFocus
              className="field min-w-0 flex-1 py-1.5 text-[12.5px]"
              value={renamed}
              onChange={(event) => setRenamed(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setRenaming(null)
                if (event.key !== 'Enter') return
                const label = renamed.trim()
                if (label) {
                  void keep(
                    mine.map((item) =>
                      item.id === preset.id ? { ...item, label } : item,
                    ),
                  )
                }
                setRenaming(null)
              }}
            />
            <button
              type="button"
              title="Готово"
              onClick={() => {
                const label = renamed.trim()
                if (label) {
                  void keep(
                    mine.map((item) => (item.id === preset.id ? { ...item, label } : item)),
                  )
                }
                setRenaming(null)
              }}
              className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <Check size={14} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onChange(settingsOf(preset))}
              className={`flex min-w-0 flex-1 items-center gap-2 truncate rounded-lg border px-2.5 py-2 text-left text-[12.5px] transition-colors ${
                picked
                  ? 'border-accent bg-accent/15 text-accent-soft'
                  : 'border-line-soft text-ink-dim hover:border-line hover:text-ink'
              }`}
            >
              {picked && <Check size={13} className="shrink-0" />}
              <span className="truncate">{preset.label}</span>
            </button>
            {own && (
              <>
                <button
                  type="button"
                  title="Переименовать"
                  onClick={() => {
                    setRenaming(preset.id)
                    setRenamed(preset.label)
                  }}
                  className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-3 hover:text-ink"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  title="Убрать свой набор"
                  onClick={() => void keep(mine.filter((item) => item.id !== preset.id))}
                  className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-3 hover:text-danger"
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </>
        )}
      </div>
    )
  }

  const known = [...BUILTIN_PRESETS, ...mine].some((preset) => sameAs(value, preset))

  return (
    <Modal open={open} onClose={onClose} title="Настройки сборки">
      <div className="space-y-5">
        <div>
          <span className="label">Наборы настроек</span>
          <div className="space-y-1">
            {BUILTIN_PRESETS.map((preset) => presetRow(preset, false))}
            {mine.map((preset) => presetRow(preset, true))}
            {!known && (
              <p className="px-1 pt-1 text-[11px] text-ink-faint">
                Настройки изменены вручную — сохраните их своим набором, чтобы вернуться
                к ним потом.
              </p>
            )}
          </div>
        </div>

        <div className="space-y-3 border-t border-line-soft pt-4">
          <Select
            label="Кодек видео"
            value={value.videoCodec}
            options={VIDEO_CODECS}
            onChange={(codec) =>
              set({
                videoCodec: codec,
                // У AV1 и H.264 скорости называются по-разному: чужое имя
                // кодировщик не примет. Качество тоже своё у каждого — берём
                // из середины его шкалы, чтобы число не значило вдруг другое.
                speedPreset: speedOptions(codec)[2].value,
                crf: (QUALITY_SCALE[codec] ?? QUALITY_SCALE.h264).marks[1].at,
              })
            }
          />

          <div>
            <span className="label">Чем задавать вес файла</span>
            <Segmented
              value={byBitrate ? 'bitrate' : 'quality'}
              onChange={(mode) =>
                set(mode === 'bitrate' ? { bitrateKbps: 6000 } : { bitrateKbps: 0 })
              }
              options={[
                {
                  value: 'quality',
                  label: 'Качеством',
                  title:
                    'Кодировщик сам решает, сколько потратить на каждый кадр. Вес заранее неизвестен, зато картинка ровная.',
                },
                {
                  value: 'bitrate',
                  label: 'Битрейтом',
                  title:
                    'Вес файла известен заранее: примерно битрейт, умноженный на длину. На сложных сценах картинка просядет.',
                },
              ]}
            />
          </div>

          {byBitrate ? (
            <div>
              <Slider
                label="Битрейт видео"
                value={value.bitrateKbps}
                min={500}
                max={40000}
                step={250}
                onChange={(bitrateKbps) => set({ bitrateKbps })}
                suffix=" кбит/с"
              />
              <ScaleMarks
                marks={BITRATE_MARKS}
                min={500}
                max={40000}
                at={value.bitrateKbps}
              />
            </div>
          ) : (
            <div>
              {/* Ползунок перевёрнут: вправо — лучше. Внутри у кодеков всё
                  наоборот, меньше число значит лучше картинку, но человеку
                  привычно, что «больше вправо» это «больше качества». */}
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="label mb-0">Качество</span>
                <span className="text-[12px] text-ink">
                  {qualityWord(value.videoCodec, value.crf)}
                </span>
              </div>
              <input
                type="range"
                className="w-full"
                min={0}
                max={scale.max}
                value={scale.max - value.crf}
                onChange={(event) => set({ crf: scale.max - Number(event.target.value) })}
              />
              <ScaleMarks
                marks={[...scale.marks].map((mark) => ({
                  at: scale.max - mark.at,
                  label: mark.label,
                }))}
                min={0}
                max={scale.max}
                at={scale.max - value.crf}
                active={qualityWord(value.videoCodec, value.crf)}
              />
            </div>
          )}

          <Select
            label="Скорость кодирования"
            value={value.speedPreset}
            options={speedOptions(value.videoCodec)}
            onChange={(speedPreset) => set({ speedPreset })}
            hint="На картинку не влияет — влияет на вес и время. Чем медленнее, тем лучше кодировщик ищет, как ужать: тот же кадр выйдет легче, но ждать дольше."
          />

          <Toggle
            checked={value.useGpu}
            onChange={(useGpu) => set({ useGpu })}
            label="Кодировать на видеокарте"
            hint="Быстрее в разы, но при том же качестве файл обычно тяжелее. Подходящий кодировщик программа подберёт сама."
          />

          <Select
            label="Кодек звука"
            value={value.audioCodec}
            options={AUDIO_CODECS}
            onChange={(audioCodec) => set({ audioCodec })}
          />

          {value.audioCodec !== 'none' && value.audioCodec !== 'flac' && (
            <Slider
              label="Битрейт звука"
              value={value.audioBitrateKbps}
              min={32}
              max={512}
              step={16}
              onChange={(audioBitrateKbps) => set({ audioBitrateKbps })}
              suffix=" кбит/с"
            />
          )}

          <Select
            label="Контейнер"
            value={value.container}
            options={CONTAINERS}
            onChange={(container) => set({ container })}
          />
        </div>

        <div className="flex items-end gap-2 border-t border-line-soft pt-4">
          <label className="flex-1">
            <span className="label">Сохранить нынешние настройки своим набором</span>
            <input
              className="field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void addMine()}
              placeholder="Например: для архива"
            />
          </label>
          <Button onClick={() => void addMine()} disabled={!name.trim()}>
            <Plus size={14} />
            Сохранить
          </Button>
        </div>

        <p className="text-[11px] text-ink-faint">{renderSummary(value)}</p>
      </div>
    </Modal>
  )
}
