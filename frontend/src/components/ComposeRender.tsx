import { useState } from 'react'
import { ArrowLeftRight, Check, ChevronDown } from 'lucide-react'
import { SliderNumber } from './ComposeTextPanel'
import { Dropdown, Section, Segmented, Toggle } from './ui'

/**
 * Настройки сборки монтажа — прямо в правой колонке, когда ничего не выбрано.
 *
 * Пресеты остальных вкладок сюда не годятся: они про то, как ужать чужой файл
 * до веса пака. Монтаж человек собирает начисто и сам решает, что ему нужно,
 * поэтому здесь три готовых набора и под ними все настройки. Своих наборов
 * нет: программа просто помнит последние настройки (`sgh.composeRender`).
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
  /** Собрать только звук: MP3, M4A, Opus или FLAC — без картинки. */
  audioOnly?: boolean
}

export interface RenderPreset extends RenderSettings {
  id: string
  label: string
}

/** Как называется набор, с которым совпадают настройки, — или «Свои настройки». */
export function presetName(value: RenderSettings): string {
  const found = BUILTIN_PRESETS.find((preset) => sameAs(value, preset))
  return found ? found.label : 'Свои настройки'
}

/** Готовые наборы. Их не переписать — только взять за основу. */

export const BUILTIN_PRESETS: RenderPreset[] = [
  {
    id: 'av1-best',
    label: 'AV1 · Opus — лучшее качество',
    videoCodec: 'av1_svt',
    crf: 22,
    bitrateKbps: 6000,
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
    bitrateKbps: 12000,
    speedPreset: 'slow',
    useGpu: false,
    audioCodec: 'aac',
    audioBitrateKbps: 256,
    container: 'mp4',
  },
  {
    id: 'audio-mp3',
    label: 'Только звук · MP3',
    videoCodec: 'h264',
    crf: 16,
    bitrateKbps: 12000,
    speedPreset: 'slow',
    useGpu: false,
    audioCodec: 'mp3',
    audioBitrateKbps: 320,
    container: 'mp4',
    audioOnly: true,
  },
]

export const DEFAULT_RENDER: RenderSettings = settingsOf(BUILTIN_PRESETS[0])

function settingsOf(preset: RenderPreset): RenderSettings {
  const { id: _id, label: _label, ...settings } = preset
  return settings
}

/**
 * Совпадают ли нынешние настройки с набором — по этому его и подсвечиваем.
 *
 * Способ задания веса в счёт не идёт: набор — это кодеки и их настройки, а
 * чем крутить вес, человек решает отдельно. Поэтому сравнивается то, чем вес
 * задан сейчас: битрейт — с битрейтом набора, качество — с качеством. У
 * одного звука не важно и всё, что про картинку.
 */
export function sameAs(value: RenderSettings, preset: RenderPreset): boolean {
  const settings = settingsOf(preset)
  if (Boolean(value.audioOnly) !== Boolean(settings.audioOnly)) return false
  const picture: (keyof RenderSettings)[] = ['videoCodec', 'crf', 'bitrateKbps', 'speedPreset', 'useGpu', 'container']
  const unused: keyof RenderSettings = value.bitrateKbps > 0 ? 'crf' : 'bitrateKbps'
  return (Object.keys(settings) as (keyof RenderSettings)[])
    .filter((key) => key !== unused && key !== 'audioOnly' && !(settings.audioOnly && picture.includes(key)))
    .every((key) => value[key] === settings[key])
}

/** Каким файлом выйдет сборка одного звука — по кодеку звука. */
export const AUDIO_FILE: Record<string, string> = { mp3: 'MP3', aac: 'M4A', opus: 'Opus', flac: 'FLAC' }

const VIDEO_CODECS = [
  { value: 'av1_svt', label: 'AV1', title: 'Меньше вес при том же качестве' },
  { value: 'h265', label: 'H.265', title: 'Между AV1 и H.264' },
  { value: 'h264', label: 'H.264', title: 'Играет везде, даже в старом' },
  { value: 'none', label: 'Нет', title: 'Без картинки — соберётся один звук: MP3, M4A, Opus или FLAC по кодеку звука' },
]

/**
 * Кодеки звука и подписи битрейта у каждого свои: 96 кбит/с у Opus — обычный
 * выбор, а у MP3 — уже слышно.
 */
const AUDIO_CODECS: {
  value: string
  label: string
  title: string
  min: number
  max: number
  normal: number
  marks: { value: number; label: string }[]
}[] = [
  {
    value: 'opus', label: 'Opus', title: 'Лучше всех при малом весе',
    min: 32, max: 320, normal: 160,
    marks: [{ value: 64, label: 'речь' }, { value: 128, label: 'обычно' }, { value: 192, label: 'музыка' }, { value: 256, label: 'отлично' }],
  },
  {
    value: 'aac', label: 'AAC', title: 'Играет везде',
    min: 64, max: 320, normal: 192,
    marks: [{ value: 96, label: 'речь' }, { value: 160, label: 'обычно' }, { value: 256, label: 'музыка' }, { value: 320, label: 'отлично' }],
  },
  {
    value: 'mp3', label: 'MP3', title: 'Играет везде, даже в старом',
    min: 96, max: 320, normal: 256,
    marks: [{ value: 128, label: 'речь' }, { value: 192, label: 'обычно' }, { value: 256, label: 'музыка' }, { value: 320, label: 'максимум' }],
  },
  { value: 'flac', label: 'FLAC', title: 'Без потерь — тяжёлый', min: 0, max: 0, normal: 0, marks: [] },
  { value: 'none', label: 'Нет', title: 'Без звука', min: 0, max: 0, normal: 0, marks: [] },
]

const CONTAINERS = [
  { value: 'mp4', label: 'MP4' },
  { value: 'mkv', label: 'MKV' },
  { value: 'webm', label: 'WebM' },
]

/**
 * Подписи к шкале битрейта.
 *
 * Голое число кбит/с ничего не говорит. Шкала кончается на четырнадцати
 * тысячах: это верх разумного для 1080p, а программой в основном собирают
 * именно его. Кому нужно больше — впишет число руками. Пока верх был
 * тридцать тысяч, три четверти ползунка занимали значения, которые никто не
 * ставит, а нужные подписи налезали друг на друга.
 */
const BITRATE_MAX = 16000
/**
 * Подписи битрейта у каждого кодека свои: AV1 той же картинке нужно вдвое
 * меньше, чем H.264, и одна шкала на всех врала бы двум из трёх. Подписей
 * по три и далеко друг от друга — в узкой колонке четыре налезали.
 */
const BITRATE_MARKS: Record<string, { value: number; label: string }[]> = {
  av1_svt: [
    { value: 2000, label: '720p' },
    { value: 4500, label: '1080p' },
    { value: 9000, label: 'с запасом' },
  ],
  h265: [
    { value: 3000, label: '720p' },
    { value: 6000, label: '1080p' },
    { value: 11000, label: 'с запасом' },
  ],
  h264: [
    { value: 4000, label: '720p' },
    { value: 8000, label: '1080p' },
    { value: 14000, label: 'с запасом' },
  ],
}

/**
 * Шкала качества у каждого кодека своя: одно и то же число у AV1 и H.264 —
 * разная картинка. Ползунок перевёрнут (вправо — лучше), подписей по три —
 * в узкой колонке больше не помещается. Слова описывают картинку, а не
 * сравнение с исходником: исходников на таймлайне может быть сколько угодно.
 */
const QUALITY_SCALE: Record<string, { best: number; worst: number; marks: { crf: number; label: string }[] }> = {
  av1_svt: { best: 16, worst: 52, marks: [{ crf: 46, label: 'низкое' }, { crf: 35, label: 'среднее' }, { crf: 24, label: 'высокое' }] },
  h265: { best: 14, worst: 40, marks: [{ crf: 34, label: 'низкое' }, { crf: 27, label: 'среднее' }, { crf: 20, label: 'высокое' }] },
  h264: { best: 12, worst: 38, marks: [{ crf: 32, label: 'низкое' }, { crf: 25, label: 'среднее' }, { crf: 18, label: 'высокое' }] },
}

function qualityScale(codec: string) {
  return QUALITY_SCALE[codec] ?? QUALITY_SCALE.h264
}

/** Слово для нынешнего качества: середины между подписями — границы. */
function qualityWord(codec: string, crf: number): string {
  const [low, mid, high] = qualityScale(codec).marks
  if (crf <= high.crf - 3) return 'наивысшее'
  if (crf <= (high.crf + mid.crf) / 2) return 'высокое'
  if (crf <= (mid.crf + low.crf) / 2) return 'среднее'
  return 'низкое'
}

/** Обычный битрейт для кодека — его ставим при смене кодека. */
function bitrateNormal(codec: string): number {
  return (BITRATE_MARKS[codec] ?? BITRATE_MARKS.h264)[1].value
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
  if (value.audioOnly) {
    return `Только звук · ${AUDIO_FILE[value.audioCodec] ?? 'M4A'} ${value.audioCodec === 'flac' ? '' : value.audioBitrateKbps + ' кбит/с'}`.trim()
  }
  const video = VIDEO_CODECS.find((item) => item.value === value.videoCodec)
  const name = video ? video.label : value.videoCodec
  const weight =
    value.bitrateKbps > 0
      ? `${value.bitrateKbps} кбит/с`
      : `качество ${qualityWord(value.videoCodec, value.crf)} (crf ${value.crf})`
  const sound =
    value.audioCodec === 'none'
      ? 'без звука'
      : `${value.audioCodec.toUpperCase()} ${value.audioBitrateKbps} кбит/с`
  return `${name} · ${weight} · ${sound} · ${value.container.toUpperCase()}`
}

/** Список-кнопка в строку: скорость, формат файла. */
function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div className="min-w-0 flex-1">
      <span className="label">{label}</span>
      <Dropdown
        value={value}
        options={options}
        onChange={onChange}
        className="field flex w-full items-center gap-1 text-left text-[12.5px] hover:border-line"
      >
        <span className="min-w-0 flex-1 truncate">
          {options.find((item) => item.value === value)?.label ?? value}
        </span>
        <ChevronDown size={13} className="shrink-0 text-ink-faint" />
      </Dropdown>
    </div>
  )
}

export function ComposeRenderPanel({
  value,
  onChange,
  loudnorm,
  onLoudnorm,
}: {
  value: RenderSettings
  onChange: (value: RenderSettings) => void
  loudnorm: boolean
  onLoudnorm: (value: boolean) => void
}) {
  const set = (patch: Partial<RenderSettings>) => onChange({ ...value, ...patch })
  const sound = AUDIO_CODECS.find((item) => item.value === value.audioCodec) ?? AUDIO_CODECS[0]
  const byBitrate = value.bitrateKbps > 0
  const scale = qualityScale(value.videoCodec)
  // Ползунок качества перевёрнут: вправо — лучше, а у кодека меньше число —
  // лучше картинка.
  const flip = (crf: number) => scale.best + scale.worst - crf
  // Последние значения обоих способов — переключение туда и обратно их не теряет.
  const [last, setLast] = useState({ bitrate: value.bitrateKbps || bitrateNormal(value.videoCodec), crf: value.crf })

  // Способ задания веса — маленькой кнопкой на месте названия: отдельная
  // строка ради переключателя занимала место в узкой колонке.
  const modeButton = (
    <button
      type="button"
      onClick={() => (byBitrate ? set({ bitrateKbps: 0, crf: last.crf }) : set({ bitrateKbps: last.bitrate }))}
      title={
        byBitrate
          ? 'Вес задан битрейтом: известен заранее, на сложных сценах картинка просядет. Нажмите — задавать качеством'
          : 'Вес задан качеством: картинка ровная, вес заранее неизвестен. Нажмите — задавать битрейтом'
      }
      className="inline-flex items-center gap-1 rounded-md border border-line-soft px-1.5 py-0.5 text-[11.5px] text-ink-dim transition-colors hover:border-line hover:text-ink"
    >
      {byBitrate ? 'Битрейт' : 'Качество'}
      <ArrowLeftRight size={11} className="text-ink-faint" />
    </button>
  )

  return (
    <Section title="Сборка" id="compose.render" summary={presetName(value)}>
      <div className="space-y-1">
        {BUILTIN_PRESETS.map((preset) => {
          const picked = sameAs(value, preset)
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => onChange(settingsOf(preset))}
              className={`flex w-full items-center gap-2 truncate rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                picked
                  ? 'border-accent bg-accent/15 text-accent-soft'
                  : 'border-line-soft text-ink-dim hover:border-line hover:text-ink'
              }`}
            >
              {picked && <Check size={13} className="shrink-0" />}
              <span className="truncate">{preset.label}</span>
            </button>
          )
        })}
      </div>

      <div className="space-y-2">
        <span className="label">Видео</span>
        {/* «Нет» — собрать один звук: так же, как «Нет» у звука. */}
        <Segmented
          columns={4}
          value={value.audioOnly ? 'none' : value.videoCodec}
          options={VIDEO_CODECS}
          onChange={(codec) =>
            codec === 'none'
              ? set({
                  audioOnly: true,
                  ...(value.audioCodec === 'none' ? { audioCodec: 'mp3', audioBitrateKbps: 256 } : {}),
                })
              : set({
                  audioOnly: false,
                  videoCodec: codec,
                  // У AV1 и H.264 скорости называются по-разному: чужое имя
                  // кодировщик не примет. Битрейт — обычный для кодека.
                  // Качество тоже своё у каждого — берём «высокое» его шкалы.
                  ...(codec !== value.videoCodec
                    ? {
                        speedPreset: speedOptions(codec)[2].value,
                        crf: qualityScale(codec).marks[2].crf,
                        ...(byBitrate ? { bitrateKbps: bitrateNormal(codec) } : {}),
                      }
                    : {}),
                })
          }
        />
        {!value.audioOnly &&
          (byBitrate ? (
            <SliderNumber
              stacked
              label={modeButton}
              unit="кбит/с"
              value={value.bitrateKbps}
              min={500}
              max={BITRATE_MAX}
              step={250}
              reset={bitrateNormal(value.videoCodec)}
              marks={BITRATE_MARKS[value.videoCodec] ?? BITRATE_MARKS.h264}
              onChange={(bitrate) => {
                const bitrateKbps = Math.max(200, Math.round(bitrate))
                setLast((was) => ({ ...was, bitrate: bitrateKbps }))
                set({ bitrateKbps })
              }}
            />
          ) : (
            <SliderNumber
              stacked
              label={modeButton}
              unit=""
              readout={
                <span className="shrink-0 text-[12px] text-ink" title={`crf ${value.crf}: меньше число — лучше картинка`}>
                  {qualityWord(value.videoCodec, value.crf)}
                </span>
              }
              value={flip(value.crf)}
              min={scale.best}
              max={scale.worst}
              reset={flip(scale.marks[2].crf)}
              marks={scale.marks.map((mark) => ({ value: flip(mark.crf), label: mark.label }))}
              onChange={(position) => {
                const crf = Math.round(flip(position))
                setLast((was) => ({ ...was, crf }))
                set({ crf })
              }}
            />
          ))}
      </div>

      <div className="space-y-2">
        <span className="label">Звук</span>
        <Segmented
          columns={value.audioOnly ? 4 : 5}
          value={sound.value}
          options={AUDIO_CODECS.filter((item) => !value.audioOnly || item.value !== 'none').map((item) => ({
            value: item.value,
            label: item.label,
            title: item.title,
          }))}
          onChange={(audioCodec) => {
            const next = AUDIO_CODECS.find((item) => item.value === audioCodec)!
            set({ audioCodec, ...(next.normal ? { audioBitrateKbps: next.normal } : {}) })
          }}
        />
        {sound.max > 0 && (
          <SliderNumber
            stacked
            label="Битрейт звука"
            unit="кбит/с"
            value={value.audioBitrateKbps}
            min={sound.min}
            max={sound.max}
            step={8}
            reset={sound.normal}
            marks={sound.marks}
            onChange={(audioBitrateKbps) => set({ audioBitrateKbps })}
          />
        )}
      </div>

      {!value.audioOnly && (
        <div className="flex gap-2">
          <Choice
            label="Скорость"
            value={value.speedPreset}
            options={speedOptions(value.videoCodec)}
            onChange={(speedPreset) => set({ speedPreset })}
          />
          <Choice
            label="Файл"
            value={value.container}
            options={CONTAINERS}
            onChange={(container) => set({ container })}
          />
        </div>
      )}

      <div className="space-y-1">
        {!value.audioOnly && (
          <Toggle
            checked={value.useGpu}
            onChange={(useGpu) => set({ useGpu })}
            label="Кодировать на видеокарте"
            hint="Быстрее в разы, но при том же качестве файл обычно тяжелее. Подходящий кодировщик программа подберёт сама."
          />
        )}
        <Toggle
          checked={loudnorm}
          onChange={onLoudnorm}
          label="Выровнять громкость"
          hint="Готовый файл получит обычную для видео в интернете громкость: тихий монтаж станет громче, слишком громкий — тише, и на пиках звук не захрипит. Слышно и в просмотре."
        />
      </div>
    </Section>
  )
}
