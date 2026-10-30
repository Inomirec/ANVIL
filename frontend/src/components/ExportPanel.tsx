import { useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, AudioLines, ChevronDown, FileX2, FolderInput, Headphones, Play, Speaker, Terminal, Zap } from 'lucide-react'
import { api } from '../lib/api'
import { parentDir, plural, timecode } from '../lib/format'
import { loadPrefs, savePrefs } from '../lib/prefs'
import {
  AUDIO_CODECS as SOUND_CODECS,
  bitrateMarks,
  bitrateNormal,
  bitrateRange,
  Choice,
  CONTAINERS,
  qualityScale,
  qualityWord,
  speedOptions,
  type Frame,
} from './ComposeRender'
import type { AudioOptions, FileInfo, Preset, VideoOptions } from '../lib/types'
import { useStore } from '../store'
import type { TrimState } from './MediaEditor'
import type { Fades } from './Timeline'
import { SliderNumber } from './ComposeTextPanel'
import { initialTracks, TracksSection, type TrackChoice } from './TracksSection'
import { Button, Dropdown, MarkIcons, QuietHints, Section, Segmented, Toggle } from './ui'

const DEFAULT_VIDEO: VideoOptions = {
  codec: 'av1_svt',
  crf: 43,
  speed_preset: '6',
  max_height: 720,
  max_fps: 0,
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
  stereo: false,
}

/**
 * Панель экспорта видео и звука.
 *
 * Здесь намеренно нет кодеков, CRF и контейнеров: всё это спрятано в пресеты.
 * Наружу вынесено только то, что человек может осмысленно решить сам — что
 * сделать со звуком и как назвать файл.
 */
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
  const revealQueue = useStore((state) => state.revealQueue)
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
      stereo: prefs.stereo ?? DEFAULT_AUDIO.stereo,
    }
  })
  const [streamCopy, setStreamCopy] = useState(false)
  const [suffix, setSuffix] = useState('_sig')
  // Высота, которая стоит на второй кнопке разрешения: последняя выбранная.
  const [listHeight, setListHeight] = useState(() => {
    const prefs = loadPrefs()
    return prefs.listHeight || prefs.max_height || 720
  })
  // Своя приписка из настроек важнее приписки пресета.
  const fixedSuffix = useStore((state) => state.settings?.export.file_suffix ?? '')
  // Скорость и контейнер выбирает человек, пресет их не трогает: пресет
  // отвечает за силу сжатия. Умолчание — «Обычно» и MP4.
  const [speed, setSpeed] = useState<number>(() => loadPrefs().videoSpeed ?? 2)
  const [container, setContainer] = useState(() => loadPrefs().videoContainer ?? 'mp4')

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
  // Дорожки и субтитры — свои у каждого файла, поэтому не запоминаются и
  // пресет их не трогает.
  const [tracksChoice, setTracksChoice] = useState<TrackChoice>(() => initialTracks(file.media))
  const trackCount = (file.media?.audioTracks?.length ?? 0) + (file.media?.subtitleTracks?.length ?? 0)
  useEffect(() => {
    setTracksChoice(initialTracks(file.media))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackCount])

  // При первом показе (и при смене типа файла) берём пресет по умолчанию.
  useEffect(() => {
    const prefs = loadPrefs()
    // «Архив» слит с «Качеством»: запомненный «Архив» открывается «Качеством».
    const saved = gif ? prefs.gifPreset : isAudio ? prefs.audioPreset : prefs.videoPreset
    const remembered = saved === 'archive_av1' ? 'pack_quality' : saved
    const first =
      kindPresets.find((preset) => preset.id === remembered && preset.available !== false) ??
      // «Качество» стоит в списке первым, но обычный выбор — «Баланс».
      kindPresets.find((preset) => preset.id === 'pack_balanced' && preset.available !== false) ??
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
        stereo: current.stereo,
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

  // WebM держит только AV1 и Opus: у пресетов на H.264 или с AAC он
  // недоступен, и тогда собираем в MP4.
  const webmFits = video.codec.startsWith('av1') && (audio.codec === 'opus' || audio.codec === 'none')

  // Кадр результата — по нему считается шкала битрейта у ручных настроек.
  const sourceWidth = file.media?.width ?? 0
  const frameHeight =
    (video.max_height && file.media?.height ? Math.min(video.max_height, file.media.height) : file.media?.height) || 1080
  const outputFrame: Frame = {
    width: sourceWidth && file.media?.height ? Math.round((sourceWidth * frameHeight) / file.media.height) : Math.round((frameHeight * 16) / 9),
    height: frameHeight,
  }
  const shownContainer = container === 'webm' && !webmFits ? 'mp4' : container

  // Выбор дорожек идёт всей пачке: у других серий дорожка ищется по языку
  // и названию — номер у них может значить другое.
  function audioTracks() {
    if (tracksChoice.track < 0) return { track: 0, tracks: [-1] }
    const chosen = file.media?.audioTracks?.find((item) => item.index === tracksChoice.track)
    return {
      track: tracksChoice.track,
      tracks: [],
      track_language: chosen?.language ?? null,
      track_title: chosen?.title ?? null,
    }
  }

  function subtitleRequest() {
    const { embed, extract, subtitle } = tracksChoice
    if (!embed && !extract) return { tracks: [], embed: false, extract: false }
    const chosen = file.media?.subtitleTracks?.find((item) => item.index === subtitle)
    return { tracks: [subtitle], embed, extract, language: chosen?.language ?? null, title: chosen?.title ?? null }
  }

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
      // Без пересжатия скорость и контейнер не нужны: файл копируется как есть.
      ...(streamCopy ? {} : { speed_preset: speedOptions(video.codec)[speed].value, container: shownContainer }),
      fade_in: withTrim ? fades.video.in : 0,
      fade_out: withTrim ? fades.video.out : 0,
      fade_in_curve: fades.video.inCurve ?? '',
      fade_out_curve: fades.video.outCurve ?? '',
    },
    audio: {
      ...audio,
      fade_in: withTrim ? fades.audio.in : 0,
      fade_out: withTrim ? fades.audio.out : 0,
      fade_in_curve: fades.audio.inCurve ?? '',
      fade_out_curve: fades.audio.outCurve ?? '',
      // Громкость — про открытый файл, к пачке её не тащим.
      volume: withTrim ? trackVolume : 1,
      ...audioTracks(),
    },
    subtitles: subtitleRequest(),
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
      revealQueue()
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
  }, [presetId, video, audio, streamCopy, trim.in, trim.out, intoSubfolder, tracksChoice])

  /** Запускает команду в том виде, в каком её оставил пользователь. */
  async function runRaw() {
    if (!command?.trim()) return
    setBusy(true)
    try {
      await api.exportRaw(command, file.path)
      revealQueue()
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const sourceHeight = file.media?.height ?? 0
  const total = file.media?.duration ?? 0
  const cutting =
    (trim.in !== null && trim.in > 0.05) ||
    (trim.out !== null && total > 0 && trim.out < total - 0.05)

  // Подсказка у каждого варианта своя: сравнивает исходник именно с ним.
  // Общая подсказка раздела описывала выбранный вариант, и над 720p при
  // выбранном «Оригинале» писала, что видео останется как есть.
  const resolutionHint = (height: number) =>
    !height
      ? sourceHeight
        ? `Оставить разрешение исходника — ${sourceHeight}p`
        : 'Оставить разрешение исходника'
      : !sourceHeight
        ? `Уменьшит до ${height}p, если видео больше. Мелкое растянуто не будет`
        : height < sourceHeight
          ? `Исходник ${sourceHeight}p уменьшится до ${height}p — это сильнее всего режет вес`
          : height === sourceHeight
            ? `Исходник и так ${sourceHeight}p — разрешение останется прежним`
            : `Исходник ${sourceHeight}p — увеличивать его до ${height}p программа не станет, останется ${sourceHeight}p`
  // Высоты кадра — с запасом во все промежутки до 4K: размер выбирают и под
  // пак, и под нейросети, и под совсем мелкий предпросмотр.
  const resolutions = [2160, 1440, 1080, 900, 720, 540, 480, 360, 240, 144].map((value) => ({
    value: String(value),
    label: value === 2160 ? '2160p (4K)' : `${value}p`,
    title: resolutionHint(value),
  }))
  const summaryResolution = video.max_height ? `${video.max_height}p` : 'Оригинал'

  return (
    <QuietHints>
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        {!streamCopy && !isAudio && !toWebp && (
          <Section
            title="Разрешение"
            id="export.resolution"
            summary={summaryResolution}
          >
            {/* Две кнопки: «Оригинал» и высота со списком рядом. Нажатие по
                высоте ставит её, стрелка открывает список всех высот. */}
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1">
              <button
                type="button"
                title={resolutionHint(0)}
                onClick={() => {
                  setVideo({ ...video, max_height: 0 })
                  savePrefs({ max_height: 0 })
                }}
                className={`rounded-lg px-1 py-1.5 text-[12px] font-medium transition-colors ${
                  video.max_height === 0 ? 'bg-surface-3 text-ink shadow-sm' : 'text-ink-faint hover:text-ink-dim'
                }`}
              >
                Оригинал
              </button>
              <div
                className={`flex items-center rounded-lg transition-colors ${
                  video.max_height ? 'bg-surface-3 text-ink shadow-sm' : 'text-ink-faint'
                }`}
              >
                <button
                  type="button"
                  title={resolutionHint(listHeight)}
                  onClick={() => {
                    setVideo({ ...video, max_height: listHeight })
                    savePrefs({ max_height: listHeight })
                  }}
                  className="min-w-0 flex-1 py-1.5 pl-2 text-[12px] font-medium tabular-nums hover:text-ink-dim"
                >
                  {listHeight}p
                </button>
                <Dropdown
                  value={String(listHeight)}
                  align="right"
                  title="Все высоты кадра"
                  options={resolutions}
                  onChange={(value) => {
                    const height = Number(value)
                    setListHeight(height)
                    setVideo({ ...video, max_height: height })
                    savePrefs({ max_height: height, listHeight: height })
                  }}
                  className="flex h-7 w-6 shrink-0 items-center justify-center hover:text-ink"
                >
                  <ChevronDown size={13} />
                </Dropdown>
              </div>
            </div>
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
                    ? 'border-accent/60 bg-accent/10 shadow-[0_0_8px_rgba(22,156,145,0.1)]'
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
          {!streamCopy && !isAudio && !toWebp && (
            <div className="flex gap-2">
              <Choice
                label="Скорость"
                hint="Сколько кодировщик старается. На само видео не влияет: медленнее — дольше ждать, но файл чуть лучше"
                value={speedOptions(video.codec)[speed].value}
                options={speedOptions(video.codec)}
                onChange={(value) => {
                  const level = speedOptions(video.codec).findIndex((item) => item.value === value)
                  setSpeed(level)
                  savePrefs({ videoSpeed: level })
                }}
              />
              <Choice
                label="Контейнер"
                hint="Формат файла — «коробка», в которую кладутся видео и звук. Если не знаете, что выбрать, — MP4"
                value={shownContainer}
                options={CONTAINERS.map((item) => ({
                  ...item,
                  // В WebM кладутся только AV1 и Opus.
                  disabled: item.value === 'webm' && !webmFits,
                }))}
                onChange={(value) => {
                  setContainer(value)
                  savePrefs({ videoContainer: value })
                }}
              />
            </div>
          )}
        </Section>


        {!isAudio && !gif && !streamCopy && (
          <ManualSection
            video={video}
            audio={audio}
            frame={outputFrame}
            // Тронули кодек или вес — пресет погас: это уже свои настройки.
            // Подгонку качества под разрешение выключаем: число значит ровно
            // то, что выставлено.
            onChange={(nextVideo, nextAudio) => {
              setVideo({ ...nextVideo, adapt_crf: false } as VideoOptions)
              setAudio(nextAudio)
              setPresetId('')
            }}
          />
        )}

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

        {!gif && (
          <TracksSection
            media={isAudio && file.media ? { ...file.media, subtitleTracks: [] } : file.media}
            value={tracksChoice}
            onChange={setTracksChoice}
            container={streamCopy ? video.container : shownContainer}
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
                ...(!streamCopy && !gif && audio.loudnorm ? [{ icon: AudioLines, label: 'Выравнивание звука' }] : []),
                ...(!streamCopy && !gif && audio.mono ? [{ icon: Headphones, label: 'Звук в моно' }] : []),
                ...(!streamCopy && !gif && !audio.mono && audio.stereo ? [{ icon: Speaker, label: 'Звук в стерео' }] : []),
                ...(intoSubfolder ? [{ icon: FolderInput, label: 'Результат — в подпапку' }] : []),
                ...(command !== null ? [{ icon: Terminal, label: 'Своя команда ffmpeg' }] : []),
              ]}
            />
          }
        >
          <div className="space-y-1 rounded-xl bg-surface-2 px-3 py-2.5">
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
            <Toggle
              checked={audio.stereo ?? false}
              onChange={(value) => {
                setAudio({ ...audio, stereo: value })
                savePrefs({ stereo: value })
              }}
              disabled={streamCopy || audio.mono}
              label="Звук в стерео"
              hint="Объёмный звук 5.1 и 7.1 сводится в обычные два канала. Монтажные программы кладут 5.1 несколькими дорожками, а стерео — одной. На обычный стереозвук не влияет."
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
              className="field h-40 resize-y font-code text-[10.5px] leading-relaxed"
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

/**
 * Видеокодеки ручных настроек — те же, что в монтаже. У каждого своя шкала
 * качества и битрейта (`qualityScale`, `bitrateMarks`).
 */
const VIDEO_CODECS = [
  {
    value: 'av1_svt', label: 'AV1',
    title: 'Лучшее качество при меньшем весе. Кодируется дольше H.264 и H.265, совсем старые телефоны и телевизоры могут его не открыть. Играет в SIGame',
  },
  {
    value: 'h265', label: 'H.265',
    title: 'Файл примерно в полтора раза легче, чем у H.264 с той же картинкой, а кодируется быстрее AV1. Телефоны и телевизоры играют его хорошо, а браузерам и Windows иногда нужно расширение',
  },
  {
    value: 'h264', label: 'H.264',
    title: 'Самый совместимый: открывается на любом устройстве и в любой программе, в том числе в монтажных. Кодируется быстро, но файл тяжелее, чем у AV1 и H.265',
  },
]

/** Что можно положить в WebM. */
const webmVideo = (codec: string) => codec.startsWith('av1')

/**
 * Ручные настройки видео и звука — как в монтаже, одним разделом: свернул —
 * исчезло всё разом. Ничего не трогали — работает пресет.
 */
function ManualSection({
  video,
  audio,
  frame,
  onChange,
}: {
  video: VideoOptions
  audio: AudioOptions
  frame: Frame
  onChange: (video: VideoOptions, audio: AudioOptions) => void
}) {
  const known = VIDEO_CODECS.find((item) => item.value === video.codec)
  // Пресет мог выбрать кодек, которого в списке нет, — показываем ближайший.
  const codec = known?.value ?? (video.codec.startsWith('av1') ? 'av1_svt' : 'h264')
  const byBitrate = (video.bitrate_kbps ?? 0) > 0
  const scale = qualityScale(codec)
  // Ползунок качества перевёрнут: вправо — лучше, а у кодека меньше — лучше.
  const flip = (crf: number) => scale.best + scale.worst - crf
  const range = bitrateRange(codec, frame)
  const sound = SOUND_CODECS.find((item) => item.value === audio.codec) ?? SOUND_CODECS[0]
  const setVideo = (patch: Partial<VideoOptions>) => onChange({ ...video, ...patch }, audio)
  const setAudio = (patch: Partial<AudioOptions>) => onChange(video, { ...audio, ...patch })

  /** Смена кодека: качество встаёт на ту же подпись L/M/H у нового кодека. */
  const pickCodec = (next: string) => {
    if (next === codec) return
    const level = scale.marks.findIndex((mark) => mark.crf === video.crf)
    const crf = qualityScale(next).marks[level >= 0 ? level : 1].crf
    setVideo({
      codec: next,
      crf,
      ...(byBitrate ? { bitrate_kbps: bitrateNormal(next, frame) } : {}),
    })
  }

  const modeButton = (
    <button
      type="button"
      onClick={() =>
        byBitrate ? setVideo({ bitrate_kbps: 0 }) : setVideo({ bitrate_kbps: bitrateNormal(codec, frame) })
      }
      title={
        byBitrate
          ? 'Вес задан битрейтом: на каждую секунду видео уходит примерно одинаково данных, и вес файла известен заранее. На быстрых и зернистых сценах картинка может стать хуже. Нажмите — задавать качеством'
          : 'Вес задан качеством: картинка везде одинаково хорошая, а данных на сложные сцены уходит больше, поэтому вес заранее неизвестен. Нажмите — задавать битрейтом'
      }
      className="inline-flex items-center gap-1 rounded-md border border-line-soft px-1.5 py-0.5 text-[11.5px] text-ink-dim transition-colors hover:border-line hover:text-ink"
    >
      {byBitrate ? 'Битрейт' : 'Качество'}
      <ArrowLeftRight size={11} className="text-ink-faint" />
    </button>
  )

  // У заголовка — коротко, иначе он переносится на вторую строку.
  const audioSummary = sound.value === 'none' ? 'без звука' : `${sound.label}${sound.max > 0 ? ` ${audio.bitrate_kbps}` : ''}`

  return (
    <Section
      title="Ручные настройки"
      id="export.manual"
      defaultFolded
      summary={`${known?.label ?? codec} · ${audioSummary}`}
    >
      <span className="label">Видео</span>
      <Segmented
        columns={3}
        value={codec}
        options={VIDEO_CODECS.map((item) => ({
          ...item,
          // В WebM кладётся только AV1 — с остальными файл соберётся в MP4.
          title: item.title + (webmVideo(item.value) ? '' : '. В WebM не кладётся — файл соберётся в MP4'),
        }))}
        onChange={pickCodec}
      />
      {byBitrate ? (
        <SliderNumber
          stacked
          label={modeButton}
          unit="кбит/с"
          value={video.bitrate_kbps ?? 0}
          min={range.min}
          max={range.max}
          step={250}
          reset={bitrateNormal(codec, frame)}
          marks={bitrateMarks(codec, frame)}
          entryLimits={[200, 200000]}
          onChange={(bitrate) => setVideo({ bitrate_kbps: Math.max(200, Math.round(bitrate)) })}
        />
      ) : (
        <SliderNumber
          stacked
          label={modeButton}
          unit=""
          readout={
            <span className="shrink-0 text-[12px] text-ink" title={`crf ${video.crf}: меньше число — лучше картинка`}>
              {qualityWord(codec, video.crf)}
            </span>
          }
          value={flip(video.crf)}
          min={scale.best}
          max={scale.worst}
          reset={flip(scale.marks[1].crf)}
          marks={scale.marks.map((mark) => ({ value: flip(mark.crf), label: mark.label, hint: mark.hint }))}
          onChange={(position) => setVideo({ crf: Math.round(flip(position)) })}
        />
      )}

      <span className="label pt-1">Звук</span>
      <Segmented
        columns={5}
        value={sound.value}
        options={SOUND_CODECS.map((item) => ({ value: item.value, label: item.label, title: item.title }))}
        onChange={(value) => {
          const next = SOUND_CODECS.find((item) => item.value === value)!
          setAudio({ codec: value, ...(next.normal ? { bitrate_kbps: next.normal } : {}) })
        }}
      />
      {sound.max > 0 && (
        <SliderNumber
          stacked
          label="Битрейт звука"
          unit="кбит/с"
          value={audio.bitrate_kbps}
          min={sound.min}
          max={sound.max}
          step={8}
          reset={sound.normal}
          marks={sound.marks}
          onChange={(bitrate_kbps) => setAudio({ bitrate_kbps })}
        />
      )}
    </Section>
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
