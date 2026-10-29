import { useState } from 'react'
import { ArrowLeftRight, AudioLines, ChevronDown, Zap } from 'lucide-react'
import { SliderNumber } from './ComposeTextPanel'
import { useCompose } from '../composeStore'
import { Dropdown, MarkIcons, Section, Segmented, Toggle } from './ui'

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
  /** Какая подпись шкалы битрейта у набора: 0 — экономно, 1 — обычно, 2 — с запасом. */
  bitrateLevel: number
  /** Чем собирается — бледной строкой под названием, как у пресетов обработки. */
  tech: string
}

/** Размер кадра проекта — по нему считаются подписи битрейта. */
export type Frame = { width: number; height: number }

/** Как называется набор, с которым совпадают настройки, — или «Свои настройки». */
export function presetName(value: RenderSettings, frame: Frame): string {
  const found = BUILTIN_PRESETS.find((preset) => sameAs(value, preset, frame))
  return found ? found.label : 'Свои настройки'
}

/** Готовые наборы. Их не переписать — только взять за основу. */

export const BUILTIN_PRESETS: RenderPreset[] = [
  {
    id: 'av1-best',
    label: 'Лучшее качество · AV1',
    tech: 'AV1 · Opus 192 · MP4',
    videoCodec: 'av1_svt',
    crf: 22,
    bitrateKbps: 0,
    bitrateLevel: 2,
    speedPreset: '5',
    useGpu: false,
    audioCodec: 'opus',
    audioBitrateKbps: 192,
    container: 'mp4',
  },
  {
    id: 'h264-best',
    label: 'Лучшее качество · H.264',
    tech: 'H.264 · AAC 256 · MP4',
    videoCodec: 'h264',
    crf: 16,
    bitrateKbps: 0,
    bitrateLevel: 2,
    speedPreset: 'slow',
    useGpu: false,
    audioCodec: 'aac',
    audioBitrateKbps: 256,
    container: 'mp4',
  },
  {
    id: 'audio-mp3',
    label: 'Только звук',
    tech: 'MP3 320',
    videoCodec: 'h264',
    crf: 16,
    bitrateKbps: 0,
    bitrateLevel: 1,
    speedPreset: 'slow',
    useGpu: false,
    audioCodec: 'mp3',
    audioBitrateKbps: 320,
    container: 'mp4',
    audioOnly: true,
  },
]

/** Настройки набора; битрейт — по размеру кадра проекта. */
function settingsOf(preset: RenderPreset, frame: Frame): RenderSettings {
  const { id: _id, label: _label, tech: _tech, bitrateLevel, ...settings } = preset
  return { ...settings, bitrateKbps: bitrateMarks(settings.videoCodec, frame)[bitrateLevel].value }
}

/**
 * Совпадают ли нынешние настройки с набором — по этому его и подсвечиваем.
 *
 * Способ задания веса в счёт не идёт: набор — это кодеки и их настройки, а
 * чем крутить вес, человек решает отдельно. Поэтому сравнивается то, чем вес
 * задан сейчас: битрейт — с битрейтом набора, качество — с качеством. У
 * одного звука не важно и всё, что про картинку.
 */
export function sameAs(value: RenderSettings, preset: RenderPreset, frame: Frame): boolean {
  const settings = settingsOf(preset, frame)
  if (Boolean(value.audioOnly) !== Boolean(settings.audioOnly)) return false
  const picture: (keyof RenderSettings)[] = ['videoCodec', 'crf', 'bitrateKbps', 'speedPreset', 'container']
  const unused: keyof RenderSettings = value.bitrateKbps > 0 ? 'crf' : 'bitrateKbps'
  // Видеокарта — дополнительная настройка, не часть набора.
  return (Object.keys(settings) as (keyof RenderSettings)[])
    .filter((key) => key !== unused && key !== 'audioOnly' && key !== 'useGpu' && !(settings.audioOnly && picture.includes(key)))
    .every((key) => value[key] === settings[key])
}

/** Каким файлом выйдет сборка одного звука — по кодеку звука. */
export const AUDIO_FILE: Record<string, string> = { mp3: 'MP3', aac: 'M4A', opus: 'Opus', flac: 'FLAC' }

const VIDEO_CODECS = [
  {
    value: 'av1_svt', label: 'AV1',
    title: 'Лучшее качество при меньшем весе: из трёх кодеков файл самый лёгкий. Кодируется дольше остальных, а совсем старые телефоны и телевизоры могут его не открыть',
  },
  {
    value: 'h265', label: 'H.265',
    title: 'Файл примерно в полтора раза легче, чем у H.264 с той же картинкой, а кодируется быстрее AV1. Телефоны и телевизоры играют его хорошо, а браузерам и Windows иногда нужно расширение',
  },
  {
    value: 'h264', label: 'H.264',
    title: 'Самый совместимый: открывается на любом устройстве и в любой программе, в том числе в монтажных. Кодируется быстро, но файл тяжелее, чем у AV1 и H.265',
  },
  { value: 'none', label: 'Нет', title: 'Без картинки — соберётся только звук: MP3, M4A, Opus или FLAC по кодеку звука' },
]

/**
 * Кодеки звука и подписи битрейта у каждого свои: 96 кбит/с у Opus — обычный
 * выбор, а у MP3 — уже слышно.
 */
/** Подписи битрейта звука — буквами, как у видео; что они значат — в подсказке. */
function soundMarks(small: number, medium: number, large: number) {
  return [
    { value: small, label: 'S', hint: 'S — для речи: голос разборчив, музыка звучит глуховато' },
    { value: medium, label: 'M', hint: 'M — обычно: и речь, и музыка звучат чисто' },
    { value: large, label: 'L', hint: 'L — с запасом: музыка без потерь на слух даже в наушниках, файл чуть тяжелее' },
  ]
}

export const AUDIO_CODECS: {
  value: string
  label: string
  title: string
  min: number
  max: number
  normal: number
  marks: { value: number; label: string; hint?: string }[]
}[] = [
  {
    value: 'opus', label: 'Opus',
    title: 'Лучший звук при малом весе: на 128 кбит/с звучит как MP3 на 192–256. Совсем старые плееры и некоторые монтажные программы его не открывают',
    min: 32, max: 320, normal: 160,
    marks: soundMarks(64, 128, 192),
  },
  {
    value: 'aac', label: 'AAC',
    title: 'Обычный звук для MP4: открывается на всех телефонах, в браузерах и монтажных программах. При том же весе звучит лучше MP3',
    min: 64, max: 320, normal: 192,
    marks: soundMarks(96, 160, 256),
  },
  {
    value: 'mp3', label: 'MP3',
    title: 'Самый старый и совместимый формат: его откроет любой плеер, даже автомагнитола. Чтобы звучать как AAC или Opus, ему нужен битрейт выше',
    min: 96, max: 320, normal: 256,
    marks: soundMarks(128, 192, 320),
  },
  {
    value: 'flac', label: 'FLAC',
    title: 'Без потерь: звук сохраняется в точности, но весит в несколько раз больше. Для архива и дальнейшей обработки; внутри MP4 открывается не каждым плеером',
    min: 0, max: 0, normal: 0, marks: [],
  },
  { value: 'none', label: 'Нет', title: 'Без звука', min: 0, max: 0, normal: 0, marks: [] },
]

/** Что можно положить в WebM. */
const webmVideo = (codec: string) => codec === 'av1_svt' || codec === 'none'
const webmAudio = (codec: string) => codec === 'opus' || codec === 'none'

/**
 * Контейнер — «коробка», в которую кладутся видео и звук. На картинку и вес
 * почти не влияет, влияет на то, что файл откроет.
 */
export const CONTAINERS = [
  { value: 'mp4', label: 'MP4', title: 'Универсальный контейнер: проигрывается на большинстве устройств' },
  {
    value: 'mkv', label: 'MKV',
    title: 'Служебных данных чуть меньше, чем у MP4, но на вес это почти не влияет — меньше процента. Файл не портится, если запись оборвалась. Телефоны, браузеры и монтажные программы открывают его хуже, чем MP4',
  },
  {
    value: 'webm', label: 'WebM',
    title: 'Открытый формат для сайтов: браузеры играют его сами, без расширений. Внутри только AV1 и Opus — остальные кодеки при нём выключены',
  },
]

/**
 * Шкала битрейта — по кодеку и по размеру кадра проекта.
 *
 * AV1 той же картинке нужно вдвое меньше, чем H.264, а 480p — втрое меньше,
 * чем 1080p: одни подписи на все случаи врали бы. Обычный битрейт для 1080p
 * у каждого кодека свой, для другого кадра он пересчитывается по числу
 * точек в степени 0.75 — вес растёт медленнее площади. Подписи —
 * «экономно», «обычно», «с запасом»; края шкалы — от половины экономного до
 * полутора «с запасом», чтобы подписи не жались в один угол.
 */
const NORMAL_1080: Record<string, number> = { av1_svt: 4500, h265: 6000, h264: 8000 }

/**
 * Подсказки описывают сам готовый файл, а не сравнение с исходником: на
 * таймлайне бывают и 4K, и 360p разом, и сравнивать не с чем.
 */
const BITRATE_HINTS = {
  S: 'S — мало данных на секунду видео. Файл лёгкий, но на быстром движении, зерне и мелких деталях появятся размытость и квадратики',
  M: 'M — обычно для такого кодека и размера кадра. Чистая картинка на большинстве сцен, вес средний',
  L: 'L — вдвое больше данных, чем M. Чисто даже на быстром движении и зерне, файл примерно вдвое тяжелее',
}

function round250(value: number): number {
  return Math.max(250, Math.round(value / 250) * 250)
}

export function bitrateMarks(codec: string, frame: Frame): { value: number; label: string; hint: string }[] {
  const pixels = Math.max(1, frame.width * frame.height)
  const normal = (NORMAL_1080[codec] ?? NORMAL_1080.h264) * Math.pow(pixels / (1920 * 1080), 0.75)
  return [
    // Буквы, а не слова: слова не помещались в строку и шли лесенкой в два
    // ряда — шкала занимала втрое больше места. S — экономно, M — обычно,
    // L — с запасом; словами — в подсказке.
    { value: round250(normal * 0.55), label: 'S', hint: BITRATE_HINTS.S },
    { value: round250(normal), label: 'M', hint: BITRATE_HINTS.M },
    { value: round250(normal * 2), label: 'L', hint: BITRATE_HINTS.L },
  ]
}

/**
 * Кадр, по которому считается шкала битрейта. У «Своего» размера — как у
 * 1080p: размер человек набирает сам, бывает любым, и шкала по нему то
 * сжималась в угол, то улетала за край, утаскивая битрейт за собой.
 */
export function scaleFrame(frame: Frame, custom: boolean): Frame {
  return custom ? { width: 1920, height: 1080 } : frame
}

/** Обычный битрейт для кодека и кадра — его ставим при смене кодека. */
export function bitrateNormal(codec: string, frame: Frame): number {
  return bitrateMarks(codec, frame)[1].value
}

export function bitrateRange(codec: string, frame: Frame): { min: number; max: number } {
  const marks = bitrateMarks(codec, frame)
  return { min: round250(marks[0].value / 2), max: Math.ceil((marks[2].value * 1.5) / 500) * 500 }
}

/**
 * Битрейт под новый кадр: стоял на подписи — встаёт на ту же подпись нового
 * кадра, иначе пересчитывается в той же доле от обычного.
 */
export function bitrateForFrame(value: number, codec: string, from: Frame, to: Frame): number {
  const before = bitrateMarks(codec, from)
  const after = bitrateMarks(codec, to)
  const level = before.findIndex((mark) => Math.abs(mark.value - value) <= mark.value * 0.03)
  if (level >= 0) return after[level].value
  return round250((value * after[1].value) / before[1].value)
}

/**
 * Шкала качества у каждого кодека своя: одно и то же число у AV1 и H.264 —
 * разная картинка. Ползунок перевёрнут (вправо — лучше), подписей по три —
 * в узкой колонке больше не помещается. Подсказки — о готовом файле, без
 * сравнения с исходником: исходников на таймлайне может быть сколько угодно.
 * При заданном качестве вес зависит от картинки: спокойная сцена весит
 * мало, быстрая и зернистая — много.
 */
const QUALITY_HINTS = {
  L: 'Low — низкое качество. Файл лёгкий, но заметны размытость и квадратики, особенно в движении',
  M: 'Medium — среднее. Чистая картинка на большинстве сцен, мелкие детали чуть сглажены',
  H: 'High — высокое. Чисто и в деталях, и в движении; файл заметно тяжелее, чем на M',
}
const qualityMarks = (low: number, mid: number, high: number) => [
  { crf: low, label: 'L', hint: QUALITY_HINTS.L },
  { crf: mid, label: 'M', hint: QUALITY_HINTS.M },
  { crf: high, label: 'H', hint: QUALITY_HINTS.H },
]
const QUALITY_SCALE: Record<string, { best: number; worst: number; marks: { crf: number; label: string; hint: string }[] }> = {
  av1_svt: { best: 16, worst: 52, marks: qualityMarks(46, 35, 24) },
  h265: { best: 14, worst: 40, marks: qualityMarks(34, 27, 20) },
  h264: { best: 12, worst: 38, marks: qualityMarks(32, 25, 18) },
}

export function qualityScale(codec: string) {
  return QUALITY_SCALE[codec] ?? QUALITY_SCALE.h264
}

/** Слово для нынешнего качества: середины между подписями — границы. */
export function qualityWord(codec: string, crf: number): string {
  const [low, mid, high] = qualityScale(codec).marks
  if (crf <= high.crf - 3) return 'наивысшее'
  if (crf <= (high.crf + mid.crf) / 2) return 'высокое'
  if (crf <= (mid.crf + low.crf) / 2) return 'среднее'
  return 'низкое'
}


/**
 * Скорость кодирования. Это не скорость видео, а сколько кодировщик
 * старается: медленнее — при том же весе картинка чуть лучше (или при той же
 * картинке файл легче), быстрее — готово раньше. У AV1 это числа, у
 * остальных — слова.
 */
export const SPEED_HINTS = [
  'Программа потратит больше всего времени на кодирование — в несколько раз дольше обычного. Картинка при том же весе станет чуть чище, а файл при том же качестве — чуть легче',
  'Кодирование заметно дольше обычного. Картинка при том же весе немного чище, файл при том же качестве немного легче',
  'Обычное время кодирования, хорошая картинка и разумный вес файла. Подходит почти всегда',
  'Кодирование быстрее обычного, но картинка при том же весе немного хуже, а файл при том же качестве немного тяжелее',
  'Программа потратит меньше всего времени на кодирование, но пострадает качество картинки, а итоговый файл будет заметно тяжелее',
]
export function speedOptions(codec: string): { value: string; label: string; title: string }[] {
  const values = codec.startsWith('av1') ? ['2', '4', '5', '7', '9'] : ['veryslow', 'slow', 'medium', 'fast', 'veryfast']
  const labels = ['Очень медленно', 'Медленно', 'Обычно', 'Быстро', 'Очень быстро']
  return values.map((value, index) => ({ value, label: labels[index], title: SPEED_HINTS[index] }))
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
export function Choice({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string
  value: string
  /** ``short`` — подпись на самой кнопке, если полная в неё не влезает. */
  options: { value: string; label: string; short?: string; title?: string; disabled?: boolean }[]
  onChange: (value: string) => void
  /** Что это за настройка — подсказка у заголовка. */
  hint?: string
}) {
  const chosen = options.find((item) => item.value === value)
  return (
    <div className="min-w-0 flex-1">
      <span className="label" title={hint}>{label}</span>
      <Dropdown
        value={value}
        options={options}
        onChange={onChange}
        className="field flex w-full items-center gap-1 text-left text-[12.5px] hover:border-line"
      >
        <span className="min-w-0 flex-1 truncate">
          {chosen?.short ?? chosen?.label ?? value}
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
  const width = useCompose((state) => state.width)
  const height = useCompose((state) => state.height)
  const custom = useCompose((state) => state.custom)
  const frame = scaleFrame({ width, height }, custom)
  const range = bitrateRange(value.videoCodec, frame)
  const set = (patch: Partial<RenderSettings>) => onChange({ ...value, ...patch })
  const sound = AUDIO_CODECS.find((item) => item.value === value.audioCodec) ?? AUDIO_CODECS[0]
  const byBitrate = value.bitrateKbps > 0
  const scale = qualityScale(value.videoCodec)
  // Ползунок качества перевёрнут: вправо — лучше, а у кодека меньше число —
  // лучше картинка.
  const flip = (crf: number) => scale.best + scale.worst - crf
  // Последние значения обоих способов — переключение туда и обратно их не теряет.
  const [last, setLast] = useState({ bitrate: value.bitrateKbps || bitrateNormal(value.videoCodec, frame), crf: value.crf })

  // WebM держит только AV1 и Opus. Собирают один звук — контейнера нет.
  const webm = value.container === 'webm' && !value.audioOnly
  /** Смена кодека видео. */
  const videoPatch = (codec: string): Partial<RenderSettings> => {
    if (codec === value.videoCodec) return { videoCodec: codec }
    // Стояли на подписи (S/M/L, L/M/H) — у нового кодека встаём на ту же:
    // одно и то же число у AV1 и H.264 значит разную картинку. Между
    // подписями — на обычную для кодека.
    const bitrateLevel = bitrateMarks(value.videoCodec, frame).findIndex(
      (mark) => Math.abs(mark.value - value.bitrateKbps) <= mark.value * 0.03,
    )
    const qualityLevel = qualityScale(value.videoCodec).marks.findIndex((mark) => mark.crf === value.crf)
    const crf = qualityScale(codec).marks[qualityLevel >= 0 ? qualityLevel : 2].crf
    const bitrate = bitrateMarks(codec, frame)[bitrateLevel >= 0 ? bitrateLevel : 1].value
    // Запомненные числа второго способа — тоже нового кодека.
    setLast({ bitrate, crf })
    return {
      videoCodec: codec,
      // У AV1 и H.264 скорости называются по-разному: чужое имя кодировщик
      // не примет.
      speedPreset: speedOptions(codec)[2].value,
      crf,
      ...(byBitrate ? { bitrateKbps: bitrate } : {}),
    }
  }

  // Способ задания веса — маленькой кнопкой на месте названия: отдельная
  // строка ради переключателя занимала место в узкой колонке.
  const modeButton = (
    <button
      type="button"
      onClick={() => (byBitrate ? set({ bitrateKbps: 0, crf: last.crf }) : set({ bitrateKbps: last.bitrate }))}
      title={
        byBitrate
          ? 'Вес задан битрейтом: на каждую секунду видео уходит примерно одинаково данных, и вес файла известен заранее. На простых сценах этого хватает с запасом, а на быстрых и зернистых может не хватить — там картинка станет хуже. Нажмите — задавать качеством'
          : 'Вес задан качеством: картинка везде одинаково хорошая, а данных на сложные сцены уходит больше, на простые — меньше, поэтому вес заранее неизвестен. Нажмите — задавать битрейтом'
      }
      className="inline-flex items-center gap-1 rounded-md border border-line-soft px-1.5 py-0.5 text-[11.5px] text-ink-dim transition-colors hover:border-line hover:text-ink"
    >
      {byBitrate ? 'Битрейт' : 'Качество'}
      <ArrowLeftRight size={11} className="text-ink-faint" />
    </button>
  )

  return (
    <>
    <Section title="Шаблоны" id="compose.render" summary={presetName(value, frame)}>
      <div className="grid gap-1.5">
        {BUILTIN_PRESETS.map((preset) => {
          const picked = sameAs(value, preset, frame)
          return (
            <button
              key={preset.id}
              type="button"
              // Видеокарта — своя настройка человека, шаблон её не трогает.
              onClick={() => {
                const settings = settingsOf(preset, frame)
                // Шаблон не переключает способ задания веса: задан качеством —
                // берётся качество шаблона, битрейтом — его битрейт. Второе
                // запоминается, чтобы переключатель показал число шаблона.
                setLast({ bitrate: settings.bitrateKbps, crf: settings.crf })
                onChange({
                  ...settings,
                  bitrateKbps: byBitrate ? settings.bitrateKbps : 0,
                  useGpu: value.useGpu,
                })
              }}
              className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                picked
                  ? 'border-accent/60 bg-accent/10 shadow-[0_0_8px_rgba(22,156,145,0.1)]'
                  : 'border-line-soft bg-surface-2 hover:border-line hover:bg-surface-3'
              }`}
            >
              <span className="block text-[13px] font-medium text-ink">{preset.label}</span>
              <span className="mt-0.5 block font-mono text-[10px] text-ink-faint/60">{preset.tech}</span>
            </button>
          )
        })}
      </div>
    </Section>

    <Section
      title="Видео"
      id="compose.video"
      summary={
        value.audioOnly
          ? 'нет'
          : `${VIDEO_CODECS.find((item) => item.value === value.videoCodec)?.label ?? value.videoCodec} · ${
              byBitrate ? `${value.bitrateKbps} кбит/с` : qualityWord(value.videoCodec, value.crf)
            }`
      }
    >
      {/* «Нет» — собрать один звук: так же, как «Нет» у звука. */}
      <Segmented
        columns={4}
        value={value.audioOnly ? 'none' : value.videoCodec}
        options={VIDEO_CODECS.map((item) => ({ ...item, disabled: webm && !webmVideo(item.value) }))}
        onChange={(codec) =>
          codec === 'none'
            ? set({
                audioOnly: true,
                ...(value.audioCodec === 'none' ? { audioCodec: 'mp3', audioBitrateKbps: 256 } : {}),
              })
            : set({ audioOnly: false, ...videoPatch(codec) })
        }
      />
      {!value.audioOnly &&
        (byBitrate ? (
          <SliderNumber
            stacked
            label={modeButton}
            unit="кбит/с"
            value={value.bitrateKbps}
            min={range.min}
            max={range.max}
            step={250}
            reset={bitrateNormal(value.videoCodec, frame)}
            marks={bitrateMarks(value.videoCodec, frame)}
            // Набрать число можно и за пределами шкалы: шкала — подсказка,
            // а не предел. Ограничение только то, что примет сервер.
            entryLimits={[200, 200000]}
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
            marks={scale.marks.map((mark) => ({ value: flip(mark.crf), label: mark.label, hint: mark.hint }))}
            onChange={(position) => {
              const crf = Math.round(flip(position))
              setLast((was) => ({ ...was, crf }))
              set({ crf })
            }}
          />
        ))}
      {!value.audioOnly && (
        <div className="flex gap-2">
          <Choice
            label="Скорость"
            hint="Сколько кодировщик старается. На само видео (длину, скорость воспроизведения) не влияет: медленнее — дольше ждать, но файл чуть лучше"
            value={value.speedPreset}
            options={speedOptions(value.videoCodec)}
            onChange={(speedPreset) => set({ speedPreset })}
          />
          <Choice
            label="Контейнер"
            hint="Формат файла — «коробка», в которую кладутся видео и звук. Если не знаете, что выбрать, — MP4"
            value={value.container}
            options={CONTAINERS}
            onChange={(container) =>
              set({
                container,
                // В WebM кладутся только AV1 и Opus: чужие кодеки меняем сами,
                // а кнопки их выключены, пока выбран WebM.
                ...(container === 'webm' && value.videoCodec !== 'av1_svt' ? videoPatch('av1_svt') : {}),
                ...(container === 'webm' && !webmAudio(value.audioCodec)
                  ? { audioCodec: 'opus', audioBitrateKbps: AUDIO_CODECS[0].normal }
                  : {}),
              })
            }
          />
        </div>
      )}
    </Section>

    <Section
      title="Звук"
      id="compose.audio"
      summary={
        sound.value === 'none'
          ? 'нет'
          : `${sound.label}${sound.max > 0 ? ` · ${value.audioBitrateKbps} кбит/с` : ''}`
      }
    >
      <Segmented
        columns={value.audioOnly ? 4 : 5}
        value={sound.value}
        options={AUDIO_CODECS.filter((item) => !value.audioOnly || item.value !== 'none').map((item) => ({
          value: item.value,
          label: item.label,
          title: item.title,
          disabled: webm && !webmAudio(item.value),
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
    </Section>

    {/* Видеокарта и выравнивание — не про набор, а про сборку вообще: наборы
        их не трогают и подсветку набора они не гасят. */}
    <Section
      title="Доп настройки"
      id="compose.renderExtra"
      // Свёрнутый раздел показывает значками, что в нём включено.
      summary={
        <MarkIcons
          marks={[
            ...(!value.audioOnly && value.useGpu ? [{ icon: Zap, label: 'Кодировать на видеокарте' }] : []),
            ...(loudnorm ? [{ icon: AudioLines, label: 'Выровнять громкость' }] : []),
          ]}
        />
      }
    >
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
    </>
  )
}

/** Настройки по умолчанию — в конце файла: им нужна шкала битрейта, объявленная выше. */
export const DEFAULT_RENDER: RenderSettings = settingsOf(BUILTIN_PRESETS[0], { width: 1280, height: 720 })
