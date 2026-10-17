import { useEffect, useMemo, useState } from 'react'
import { AudioLines, FileX2, FolderInput, Gauge, Headphones, Play, Terminal, Zap } from 'lucide-react'
import { api } from '../lib/api'
import { parentDir, plural, timecode } from '../lib/format'
import { loadPrefs, savePrefs, SPEED_LABELS, speedPreset } from '../lib/prefs'
import type { AudioOptions, FileInfo, Preset, VideoOptions } from '../lib/types'
import { useStore } from '../store'
import type { TrimState } from './MediaEditor'
import type { Fades } from './Timeline'
import { SliderNumber } from './ComposeTextPanel'
import { Button, MarkIcons, QuietHints, Section, Segmented, Select, Toggle } from './ui'

const DEFAULT_VIDEO: VideoOptions = {
  codec: 'av1_svt',
  crf: 43,
  speed_preset: '6',
  max_height: 720,
  max_fps: 30,
  tempo: 1,
  container: 'mp4',
  use_gpu: false,
  faststart: true,
  strip_video: false,
}

const DEFAULT_AUDIO: AudioOptions = {
  codec: 'opus',
  bitrate_kbps: 96,
  track: 0,
  volume: 1,
  loudnorm: true,
  loudnorm_i: -16,
  loudnorm_tp: -1.5,
  loudnorm_lra: 11,
  fade_in: 0,
  fade_out: 0,
  mono: false,
}

/**
 * Панель экспорта видео и звука.
 *
 * Здесь намеренно нет кодеков, CRF и контейнеров: всё это спрятано в пресеты.
 * Наружу вынесено только то, что человек может осмысленно решить сам — что
 * сделать со звуком и как назвать файл.
 */
/** Понятная подпись дорожки: язык, название, число каналов. */
function trackLabel(
  track: { index: number; codec: string | null; channels: number | null; language: string | null; title: string | null },
  total: number,
): string {
  const parts: string[] = [`${track.index + 1} из ${total}`]
  const language = track.language && track.language !== 'und' ? LANGUAGES[track.language] ?? track.language : null
  if (language) parts.push(language)
  if (track.title) parts.push(track.title)
  if (track.channels === 1) parts.push('моно')
  else if (track.channels === 2) parts.push('стерео')
  else if (track.channels) parts.push(`${track.channels} кан.`)
  return parts.join(' · ')
}

/** Языки, которые реально встречаются в паках. Остальные показываем как есть. */
const LANGUAGES: Record<string, string> = {
  rus: 'русский', ru: 'русский',
  eng: 'английский', en: 'английский',
  jpn: 'японский', ja: 'японский',
  ukr: 'украинский', uk: 'украинский',
}

/**
 * Звук: кодек и битрейт под готовыми наборами. Подписи шкалы — у каждого
 * кодека свои: 96 кбит/с у Opus — обычный выбор, а у MP3 — уже слышно.
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
    value: 'opus', label: 'Opus', title: 'Лучше всех звучит на малом весе. Играет в SIGame',
    min: 32, max: 256, normal: 96,
    marks: [{ value: 48, label: 'речь' }, { value: 96, label: 'обычно' }, { value: 128, label: 'музыка' }, { value: 192, label: 'отлично' }],
  },
  {
    value: 'aac', label: 'AAC', title: 'Читается почти везде, весит чуть больше Opus',
    min: 64, max: 320, normal: 128,
    marks: [{ value: 96, label: 'речь' }, { value: 128, label: 'обычно' }, { value: 192, label: 'музыка' }, { value: 256, label: 'отлично' }],
  },
  {
    value: 'mp3', label: 'MP3', title: 'Играет везде, даже в старом',
    min: 96, max: 320, normal: 192,
    marks: [{ value: 128, label: 'речь' }, { value: 192, label: 'обычно' }, { value: 256, label: 'музыка' }, { value: 320, label: 'максимум' }],
  },
  {
    value: 'flac', label: 'FLAC', title: 'Без потерь: для архива, а не для пака — весит в разы больше',
    min: 0, max: 0, normal: 0, marks: [],
  },
]

/**
 * GIF можно перегнать и в видео, и в движущийся WebP — второе стоит в том же
 * списке отдельным пресетом. Свой список у GIF нужен потому, что SIQuester
 * считает GIF картинкой (предел 1 МБ), а видео того же движения весит в разы
 * меньше; WebP же гифку часто раздувает.
 */
const GIF_WEBP: Preset = {
  id: 'gif_webp',
  kind: 'image',
  label: 'Движущаяся картинка WebP',
  hint: 'Останется картинкой, а не видео. Часто весит больше исходного GIF — видео обычно легче в разы.',
  tech: 'WebP · качество 80',
  accent: '',
  options: { image: { format: 'webp', quality: 80, max_dimension: 0, effort: 4 } },
}

export function ExportPanel({
  file,
  trim,
  fades,
  trackVolume,
  onDone,
}: {
  file: FileInfo
  trim: TrimState
  fades: Fades
  /** Громкость дорожки с таймлайна: 1 — как есть, 0 — без звука. */
  trackVolume: number
  onDone?: () => void
}) {
  const presets = useStore((state) => state.presets)
  const checked = useStore((state) => state.checked)
  const files = useStore((state) => state.files)
  const toast = useStore((state) => state.toast)
  const setQueueOpen = useStore((state) => state.setQueueOpen)
  const status = useStore((state) => state.status)

  const isAudio = file.kind === 'audio'
  // GIF обрабатывается как ролик: звука нет, обрезать незачем, а пресеты —
  // видео плюс движущийся WebP.
  const gif = file.kind === 'image' && file.ext.toLowerCase() === 'gif'
  const kindPresets: Preset[] = useMemo(
    () =>
      gif
        ? [...(presets.video ?? []).filter((preset) => !preset.options.stream_copy), GIF_WEBP]
        : ((isAudio ? presets.audio : presets.video) ?? []),
    [presets, isAudio, gif],
  )

  const [presetId, setPresetId] = useState<string>('')
  const [video, setVideo] = useState<VideoOptions>(() => {
    const prefs = loadPrefs()
    return {
      ...DEFAULT_VIDEO,
      use_gpu: prefs.use_gpu ?? DEFAULT_VIDEO.use_gpu,
      max_height: prefs.max_height ?? DEFAULT_VIDEO.max_height,
    }
  })
  const [audio, setAudio] = useState<AudioOptions>(() => {
    const prefs = loadPrefs()
    return {
      ...DEFAULT_AUDIO,
      loudnorm: prefs.loudnorm ?? DEFAULT_AUDIO.loudnorm,
      mono: prefs.mono ?? DEFAULT_AUDIO.mono,
    }
  })
  const [streamCopy, setStreamCopy] = useState(false)
  const [suffix, setSuffix] = useState('_sig')
  // Своя приписка из настроек важнее приписки пресета.
  const fixedSuffix = useStore((state) => state.settings?.export.file_suffix ?? '')
  // Скорость кодирования поверх пресета: нет — как задано в пресете.
  const [speed, setSpeed] = useState<number | null>(() => loadPrefs().videoSpeed ?? null)

  // Приписка к имени по основным пресетам: в папке потом сразу видно, чем
  // сжимали, — иначе три версии одного ролика различаются только весом.
  const PRESET_SUFFIX: Record<string, string> = {
    pack_balanced: '_баланс',
    pack_quality: '_качество',
    pack_economy: '_экономия',
  }
  const [busy, setBusy] = useState(false)
  const [command, setCommand] = useState<string | null>(null)
  // Складывать в подпапку или прямо рядом с исходником. Запоминаем: выбор
  // делают один раз под свою привычку раскладывать файлы.
  const [intoSubfolder, setIntoSubfolder] = useState(
    () => loadPrefs().subfolder ?? localStorage.getItem('sgh.outputSubfolder') !== 'off',
  )
  const [deleteOriginal, setDeleteOriginal] = useState(() => loadPrefs().mediaReplace ?? false)

  // При первом показе (и при смене типа файла) берём пресет по умолчанию.
  useEffect(() => {
    const prefs = loadPrefs()
    const remembered = gif ? prefs.gifPreset : isAudio ? prefs.audioPreset : prefs.videoPreset
    const first =
      kindPresets.find((preset) => preset.id === remembered && preset.available !== false) ??
      kindPresets.find((preset) => preset.available !== false)
    if (first && !kindPresets.some((preset) => preset.id === presetId)) {
      applyPreset(first)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindPresets])

  function applyPreset(preset: Preset) {
    setPresetId(preset.id)
    savePrefs(
      gif
        ? { gifPreset: preset.id }
        : preset.kind === 'audio'
          ? { audioPreset: preset.id }
          : { videoPreset: preset.id },
    )
    if (preset.options.video) {
      // Разрешение выбирает человек отдельно — пресет отвечает только за силу
      // сжатия, поэтому его max_height мы не подхватываем.
      setVideo((current) => ({
        ...DEFAULT_VIDEO,
        ...preset.options.video,
        // Разрешение и выбор «процессор или видеокарта» человек делает сам —
        // пресет отвечает только за силу сжатия.
        max_height: preset.options.stream_copy
          ? 0
          : (preset.options.video?.max_height === 0 ? 0 : current.max_height),
        use_gpu: current.use_gpu,
      } as VideoOptions))
    }
    // Галочки звука пользователь ставит сам — пресет их не перебивает.
    if (preset.options.audio) {
      setAudio((current) => ({
        ...DEFAULT_AUDIO,
        ...preset.options.audio,
        loudnorm: current.loudnorm,
        mono: current.mono,
      } as AudioOptions))
    }
    setStreamCopy(Boolean(preset.options.stream_copy))
    // Имя, которое человек уже поправил руками, не трогаем.
    setSuffix((current) =>
      current === '_sig' || Object.values(PRESET_SUFFIX).includes(current)
        ? PRESET_SUFFIX[preset.id] ?? '_sig'
        : current,
    )
  }

  const activePreset = kindPresets.find((preset) => preset.id === presetId)
  const toWebp = gif && presetId === GIF_WEBP.id

  // Дорожки есть только у открытого файла: к отмеченным в пачке выбор не
  // применяется — у них своя разметка, и номер оттуда ничего не значит.
  const tracks = file.media?.audioTracks ?? []

  const buildRequest = (source: string, withTrim: boolean) => ({
    source,
    kind: gif ? (toWebp ? ('image' as const) : ('video' as const)) : file.kind,
    ...(toWebp ? { image: { ...GIF_WEBP.options.image, boxes: [], box_color: 'black', crop: null } } : {}),
    // Без подпапки результат кладём прямо в папку исходника.
    output_dir: intoSubfolder ? null : parentDir(source),
    trim: withTrim ? { start: trim.in, end: trim.out } : { start: null, end: null },
    // Затухания нарисованы на дорожках открытого файла — в пакет их не тащим.
    video: {
      ...video,
      ...(speed !== null ? { speed_preset: speedPreset(video.codec, speed) } : {}),
      fade_in: withTrim ? fades.video.in : 0,
      fade_out: withTrim ? fades.video.out : 0,
    },
    audio: {
      ...audio,
      fade_in: withTrim ? fades.audio.in : 0,
      fade_out: withTrim ? fades.audio.out : 0,
      // Громкость и выбор дорожки — про открытый файл, к пачке их не тащим.
      volume: withTrim ? trackVolume : 1,
      track: withTrim ? audio.track ?? 0 : 0,
    },
    stream_copy: streamCopy,
    replace_original: deleteOriginal,
    suffix: fixedSuffix || (toWebp ? '_webp' : suffix),
    preset_label: activePreset?.label,
  })

  // Отмеченные в медиатеке файлы того же типа обрабатываются одной кнопкой.
  const others = checked.filter(
    (path) =>
      path !== file.path &&
      (files.find((item) => item.path === path)?.kind ?? '') === file.kind &&
      // К гифке в пачку идут только гифки: обычные картинки в видео не
      // перегоняют.
      (!gif || path.toLowerCase().endsWith('.gif')),
  )
  // Снятая галочка означает «этот файл не трогать» — даже если он открыт.
  // Раньше открытый файл попадал в обработку всегда, и при включённом
  // удалении оригинала терялся файл, который человек намеренно оставил.
  const openChecked = checked.includes(file.path)
  const batch = openChecked ? [file.path, ...others] : others
  // Ничего не отмечено — кнопка обрабатывает открытый файл.
  const single = batch.length === 0

  async function run() {
    setBusy(true)
    try {
      if (single) {
        await api.export(buildRequest(file.path, true))
      } else {
        // Метки и затухания относятся к открытому файлу, к остальным — нет.
        const items = batch.map((path) => buildRequest(path, path === file.path))
        const result = await api.exportBatch(items)
        if (result.errors.length) toast(result.errors[0].error, 'error')
        toast(
          `Обрабатываю ${result.jobs.length} ${plural(result.jobs.length, ['файл', 'файла', 'файлов'])}`,
          'ok',
        )
        // Отправленные файлы из отметок убираем: иначе следующая пачка
        // прихватила бы их снова. Отметки других типов остаются.
        const sent = new Set(batch)
        const store = useStore.getState()
        store.setChecked(store.checked.filter((path) => !sent.has(path)))
      }
      setQueueOpen(true)
      onDone?.()
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function loadCommand() {
    if (command !== null) {
      setCommand(null)
      return
    }
    try {
      const preview = await api.exportPreview(buildRequest(file.path, true))
      setCommand(preview.command ?? '')
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }

  // Пока консоль открыта, команда пересобирается под текущие настройки.
  // Это же и способ вернуть всё как было: сломали строку — переключите
  // пресет, и появится рабочая.
  useEffect(() => {
    if (command === null) return
    let cancelled = false
    api
      .exportPreview(buildRequest(file.path, true))
      .then((preview) => !cancelled && setCommand(preview.command ?? ''))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetId, video, audio, streamCopy, trim.in, trim.out, intoSubfolder])

  /** Запускает команду в том виде, в каком её оставил пользователь. */
  async function runRaw() {
    if (!command?.trim()) return
    setBusy(true)
    try {
      await api.exportRaw(command, file.path)
      setQueueOpen(true)
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const sourceHeight = file.media?.height ?? 0
  // Программа никогда не растягивает видео вверх, поэтому итог — минимум из двух.
  const outputHeight = video.max_height
    ? sourceHeight
      ? Math.min(video.max_height, sourceHeight)
      : video.max_height
    : sourceHeight

  const total = file.media?.duration ?? 0
  const cutting =
    (trim.in !== null && trim.in > 0.05) ||
    (trim.out !== null && total > 0 && trim.out < total - 0.05)

  const resolutions = [
    { value: '0', label: 'Оригинал', title: 'Оставить разрешение исходника' },
    { value: '2160', label: '4K' },
    { value: '1440', label: '1440p' },
    { value: '1080', label: '1080p' },
    { value: '720', label: '720p' },
    { value: '480', label: '480p' },
  ]

  return (
    <QuietHints>
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {!streamCopy && !isAudio && !toWebp && (
          <Section
            title="Разрешение"
            id="export.resolution"
            summary={resolutions.find((item) => item.value === String(video.max_height))?.label}
            hint={
              sourceHeight
                ? outputHeight && outputHeight < sourceHeight
                  ? `Исходник ${sourceHeight}p уменьшится до ${outputHeight}p — это сильнее всего режет вес.`
                  : `Исходник ${sourceHeight}p — увеличивать его программа не станет, останется как есть.`
                : 'Мелкое видео растянуто вверх не будет — только уменьшение.'
            }
          >
            <Segmented
              columns={3}
              value={String(video.max_height)}
              onChange={(value) => {
                setVideo({ ...video, max_height: Number(value) })
                savePrefs({ max_height: Number(value) })
              }}
              options={resolutions}
            />
          </Section>
        )}

        <Section
          title={gif ? 'Перевести GIF' : 'Пресеты сжатия'}
          id="export.presets"
          summary={activePreset?.label ?? 'свои настройки'}
          hint={
            gif
              ? 'SIQuester считает GIF картинкой, а у картинок предел 1 МБ. Видео с тем же движением весит в разы меньше. Превью AV1 SIQuester не показывает — для него берите H.264.'
              : undefined
          }
        >
          <div className="grid gap-1.5">
            {kindPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                disabled={preset.available === false}
                onClick={() => applyPreset(preset)}
                // Описание — при наведении: знающему оно только занимает место,
                // а важные галочки из-за него уезжали за прокрутку.
                title={
                  preset.available === false
                    ? 'Этот способ недоступен на вашем компьютере'
                    : preset.hint
                }
                className={`rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                  presetId === preset.id
                    ? 'border-accent/60 bg-accent/10'
                    : 'border-line-soft bg-surface-2 hover:border-line hover:bg-surface-3'
                }`}
              >
                <span className="block text-[13px] font-medium text-ink">{preset.label}</span>
                {/* Чем именно жмём — бледной строкой: снимает вопрос «а чем
                    Баланс отличается от Качества». */}
                {preset.tech && preset.available !== false && (
                  <span className="mt-0.5 block font-mono text-[10px] text-ink-faint/60">
                    {preset.tech}
                  </span>
                )}
              </button>
            ))}
          </div>
        </Section>


        {isAudio && !streamCopy && (
          <AudioCodecSection
            audio={audio}
            // Тронули кодек или битрейт — набор погас: это уже свои настройки.
            onChange={(next) => {
              setAudio(next)
              setPresetId('')
            }}
          />
        )}

        <Section
          title="Доп настройки"
          id="export.other"
          // Свёрнутый раздел не должен прятать то, о чём легко забыть: удаление
          // оригинала горит красным, остальное включённое — значками.
          summary={
            <MarkIcons
              marks={[
                ...(deleteOriginal ? [{ icon: FileX2, label: 'Оригинал уйдёт в корзину', danger: true }] : []),
                ...(!streamCopy && !isAudio && status?.gpuAvailable && video.use_gpu
                  ? [{ icon: Zap, label: 'Кодировать на видеокарте' }]
                  : []),
                ...(!streamCopy && !isAudio && !toWebp && speed !== null
                  ? [{ icon: Gauge, label: `Скорость: ${SPEED_LABELS[speed].toLowerCase()}` }]
                  : []),
                ...(!streamCopy && !gif && audio.loudnorm ? [{ icon: AudioLines, label: 'Выравнивание звука' }] : []),
                ...(!streamCopy && !gif && audio.mono ? [{ icon: Headphones, label: 'Звук в моно' }] : []),
                ...(intoSubfolder ? [{ icon: FolderInput, label: 'Результат — в подпапку' }] : []),
                ...(command !== null ? [{ icon: Terminal, label: 'Своя команда ffmpeg' }] : []),
              ]}
            />
          }
        >
          <div className="space-y-1 rounded-xl bg-surface-2 px-3 py-2.5">
            {!streamCopy && !isAudio && !toWebp && (
              <Select
                label="Скорость"
                value={speed === null ? 'preset' : String(speed)}
                options={[
                  { value: 'preset', label: 'Как в пресете' },
                  ...SPEED_LABELS.map((label, index) => ({ value: String(index), label })),
                ]}
                onChange={(value) => {
                  const next = value === 'preset' ? null : Number(value)
                  setSpeed(next)
                  savePrefs({ videoSpeed: next })
                }}
                hint="Сколько кодировщик старается. Медленнее — дольше ждать, но картинка чище при том же весе или файл легче при той же картинке. Быстрее — наоборот."
              />
            )}
            {!streamCopy && !isAudio && status?.gpuAvailable && (
              <Toggle
                checked={video.use_gpu}
                onChange={(value) => {
                  setVideo({ ...video, use_gpu: value })
                  savePrefs({ use_gpu: value })
                }}
                label="Кодировать на видеокарте"
                hint="Высокая скорость, но в теории могут появиться незначительные артефакты. Полезно для больших видео, когда важно время."
              />
            )}
            {tracks.length > 1 && !gif && (
              <Select
                label="Звуковая дорожка"
                value={String(audio.track ?? 0)}
                options={tracks.map((track) => ({
                  value: String(track.index),
                  label: trackLabel(track, tracks.length),
                }))}
                onChange={(value) => setAudio({ ...audio, track: Number(value) })}
                disabled={streamCopy}
                hint="В файле несколько дорожек — например, оригинал и озвучка. Программа берёт первую, если не выбрать другую."
              />
            )}
            {!gif && (
              <>
            <Toggle
              checked={audio.loudnorm}
              onChange={(value) => {
                setAudio({ ...audio, loudnorm: value })
                savePrefs({ loudnorm: value })
              }}
              disabled={streamCopy}
              label="Выравнивание звука"
              hint="У всех источников с этой настройкой будет одинаковый предел громкости."
            />
            <Toggle
              checked={audio.mono}
              onChange={(value) => {
                setAudio({ ...audio, mono: value })
                savePrefs({ mono: value })
              }}
              disabled={streamCopy}
              label="Перевести звук в моно"
              hint="Делает звук более плоским, но и понижает вес файла примерно на треть."
            />
              </>
            )}
            <Toggle
              checked={intoSubfolder}
              onChange={(value) => {
                setIntoSubfolder(value)
                savePrefs({ subfolder: value })
              }}
              label="Положить результат в подпапку"
              hint="Программа создаст подпапку рядом с оригиналом и сложит файл туда. Имя подпапки задаётся в настройках. Если выключить — результат ляжет в ту же папку, где лежит оригинал."
            />
            <Toggle
              checked={deleteOriginal}
              onChange={(value) => {
                setDeleteOriginal(value)
                savePrefs({ mediaReplace: value })
              }}
              label="Удалить оригинал"
              hint="После успешной обработки исходный файл уйдёт в корзину Windows — оттуда его можно вернуть. Если обработка не удалась, исходник остаётся на месте. По умолчанию выключено."
            />
            <Toggle
              checked={command !== null}
              onChange={(value) => (value ? void loadCommand() : setCommand(null))}
              label="Задать параметры в консоли ffmpeg"
              hint="Для тех, кто знает ffmpeg: показывает готовую команду, её можно поправить и запустить как есть."
            />
          </div>
          {command !== null && (
          <div className="space-y-2">
            <textarea
              className="field h-40 resize-y font-mono text-[10.5px] leading-relaxed"
              spellCheck={false}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
            <p className="text-[11px] leading-snug text-ink-faint">
              Команду можно править и запускать как есть — это на случай, когда нужна
              тонкая настройка, которой нет в интерфейсе. Последнее слово в строке —
              путь к результату. Запускается только ffmpeg, ничего другого.
            </p>
            <Button onClick={() => void runRaw()} disabled={busy} className="w-full">
              <Terminal size={14} />
              Запустить эту команду
            </Button>
          </div>
        )}
          {streamCopy && (
            <p className="text-[11px] leading-snug text-ink-faint">
              Выбран режим без сжатия — звук копируется как есть, поэтому галочки
              звука ни на что не влияют.
            </p>
          )}
        </Section>


      </div>

      {/* Нижняя панель действий */}
      <div className="space-y-2 border-t border-line-soft bg-surface px-4 py-3">
        {/* Отрезок пишем, только когда метки что-то отрезают: «весь файл»
            и его вес и так видны над плеером. */}
        {cutting && !gif && (
          <p className="text-[11px] text-ink-faint">
            Отрезок:{' '}
            <span className="tabular-nums text-ink-dim">
              {timecode(trim.in ?? 0, true)} → {timecode(trim.out ?? total, true)}
            </span>
          </p>
        )}

        <Button tone="primary" onClick={() => void run()} disabled={busy} className="w-full py-2.5">
          <Play size={15} />
          {!single
            ? `Обработать ${batch.length} ${plural(batch.length, ['файл', 'файла', 'файлов'])}`
            : gif
              ? toWebp
                ? 'Сжать в WebP'
                : 'Перевести в видео'
              : streamCopy
              ? 'Обрезать без сжатия'
              : 'Обрезать и сжать'}
        </Button>

        {others.length > 0 && (
          <p className="text-center text-[11px] leading-snug text-ink-faint">
            К отмеченным файлам применится тот же пресет, но без обрезки — метки стоят
            только на открытом файле.
            {!openChecked && ' Открытый файл не отмечен, его программа не тронет.'}
          </p>
        )}
      </div>
    </div>
    </QuietHints>
  )
}

/** Кодек и битрейт звука — под готовыми наборами. */
function AudioCodecSection({
  audio,
  onChange,
}: {
  audio: AudioOptions
  onChange: (audio: AudioOptions) => void
}) {
  const current = AUDIO_CODECS.find((item) => item.value === audio.codec) ?? AUDIO_CODECS[0]
  return (
    <Section
      title="Кодек и битрейт"
      id="export.audioCodec"
      summary={current.max ? `${current.label} · ${audio.bitrate_kbps} кбит/с` : current.label}
    >
      <Segmented
        columns={4}
        value={current.value}
        options={AUDIO_CODECS.map((item) => ({ value: item.value, label: item.label, title: item.title }))}
        onChange={(value) => {
          const next = AUDIO_CODECS.find((item) => item.value === value)!
          onChange({ ...audio, codec: value, bitrate_kbps: next.normal || audio.bitrate_kbps })
        }}
      />
      {current.max > 0 && (
        <SliderNumber
          stacked
          label="Битрейт"
          unit="кбит/с"
          value={audio.bitrate_kbps}
          min={current.min}
          max={current.max}
          step={8}
          reset={current.normal}
          marks={current.marks}
          onChange={(value) => onChange({ ...audio, bitrate_kbps: value })}
        />
      )}
    </Section>
  )
}
