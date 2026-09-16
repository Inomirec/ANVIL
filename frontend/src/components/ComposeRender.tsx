import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../store'
import { Button, Modal, Select, Slider, Toggle } from './ui'

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
  crf: number
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
    speedPreset: 'slow',
    useGpu: false,
    audioCodec: 'aac',
    audioBitrateKbps: 256,
    container: 'mp4',
  },
]

export const DEFAULT_RENDER: RenderSettings = { ...BUILTIN_PRESETS[0] }

const VIDEO_CODECS = [
  { value: 'av1_svt', label: 'AV1 — меньше вес при том же качестве' },
  { value: 'h264', label: 'H.264 — играет везде, даже в старом' },
  { value: 'h265', label: 'H.265 — между ними' },
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

/** Названия скоростей: у AV1 это числа, у остальных — слова. */
function speedOptions(codec: string): { value: string; label: string }[] {
  if (codec === 'av1_svt') {
    return [
      { value: '2', label: 'Очень медленно — лучший вес' },
      { value: '4', label: 'Медленно' },
      { value: '5', label: 'Обычно' },
      { value: '7', label: 'Быстро' },
      { value: '9', label: 'Очень быстро' },
    ]
  }
  return [
    { value: 'veryslow', label: 'Очень медленно — лучший вес' },
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
  const sound =
    value.audioCodec === 'none'
      ? 'без звука'
      : `${value.audioCodec.toUpperCase()} ${value.audioBitrateKbps} кбит/с`
  return `${name} · качество ${value.crf} · ${sound} · ${value.container.toUpperCase()}`
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
    toast(`Пресет «${label}» сохранён`, 'ok')
  }

  const apply = (preset: RenderPreset) => {
    const { id: _id, label: _label, ...settings } = preset
    onChange(settings)
  }

  return (
    <Modal open={open} onClose={onClose} title="Настройки сборки">
      <div className="space-y-5">
        <div>
          <span className="label">Готовые наборы</span>
          <div className="space-y-1">
            {BUILTIN_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => apply(preset)}
                className="w-full rounded-lg border border-line-soft px-2.5 py-2 text-left text-[12.5px] text-ink-dim transition-colors hover:border-line hover:text-ink"
              >
                {preset.label}
              </button>
            ))}
            {mine.map((preset) => (
              <div key={preset.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => apply(preset)}
                  className="min-w-0 flex-1 truncate rounded-lg border border-line-soft px-2.5 py-2 text-left text-[12.5px] text-ink-dim transition-colors hover:border-line hover:text-ink"
                >
                  {preset.label}
                </button>
                <button
                  type="button"
                  title="Убрать свой пресет"
                  onClick={() => void keep(mine.filter((item) => item.id !== preset.id))}
                  className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-3 hover:text-danger"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
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
                // кодировщик не примет.
                speedPreset: speedOptions(codec)[2].value,
              })
            }
          />

          <Slider
            label="Качество"
            value={value.crf}
            min={0}
            max={value.videoCodec === 'av1_svt' ? 63 : 51}
            onChange={(crf) => set({ crf })}
            hint="Меньше число — лучше картинка и тяжелее файл. Ноль у H.264 означает без потерь."
          />

          <Select
            label="Скорость кодирования"
            value={value.speedPreset}
            options={speedOptions(value.videoCodec)}
            onChange={(speedPreset) => set({ speedPreset })}
          />

          <Toggle
            checked={value.useGpu}
            onChange={(useGpu) => set({ useGpu })}
            label="Кодировать на видеокарте"
            hint="Быстрее, но при том же качестве файл обычно тяжелее. Подходящий кодировщик программа подберёт сама."
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
            <span className="label">Сохранить нынешние настройки как свой набор</span>
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
