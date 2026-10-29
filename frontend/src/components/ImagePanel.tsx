import { useEffect, useMemo, useRef, useState } from 'react'
import { Eye, FileX2, FolderInput, Play, Terminal } from 'lucide-react'
import { api } from '../lib/api'
import { parentDir, plural } from '../lib/format'
import { imageEffort, loadPrefs, savePrefs, SPEED_LABELS } from '../lib/prefs'
import { Choice, SPEED_HINTS } from './ComposeRender'
import { strokesToPng } from '../lib/paint'
import type { FileInfo, ImageOptions, ImagePreview, Preset } from '../lib/types'
import { useStore } from '../store'
import type { ImageEdit } from './ImageEditorTop'
import { Button, MarkIcons, Modal, QuietHints, Section, Segmented, Toggle } from './ui'

const DEFAULT_IMAGE: ImageOptions = {
  format: 'avif',
  quality: 90,
  max_dimension: 0,
  effort: 4,
  boxes: [],
  box_color: 'black',
  crop: null,
}

type Format = 'avif' | 'jpg' | 'webp' | 'ico'

const FORMATS: { value: Format; label: string; title: string }[] = [
  { value: 'avif', label: 'AVIF', title: 'Жмёт лучше всех, держит прозрачность' },
  { value: 'jpg', label: 'JPEG', title: 'Открывается везде, прозрачность не держит' },
  { value: 'webp', label: 'WebP', title: 'Середина: жмёт хорошо, поддержки больше' },
  {
    value: 'ico',
    label: 'ICO',
    title: 'Значок для программ и ярлыков Windows: квадрат не больше 256 точек, прозрачность держит',
  },
]

/** Предел по длинной стороне. Маленькие картинки не растягиваются. */
const SIZES = [
  // На кнопке — коротко: в строку с «Скоростью» полное имя не влезает.
  { value: '0', label: 'Оригинальный файл', short: 'Оригинал', title: 'Размер не меняется' },
  { value: '2560', label: 'до 2560 px' },
  { value: '1920', label: 'до 1920 px' },
  { value: '1600', label: 'до 1600 px' },
  { value: '1280', label: 'до 1280 px' },
  { value: '1024', label: 'до 1024 px' },
  { value: '854', label: 'до 854 px', title: 'Как кадр 480p' },
  { value: '640', label: 'до 640 px', title: 'Как кадр 360p' },
  { value: '480', label: 'до 480 px' },
  { value: '256', label: 'до 256 px', title: 'Размер значка' },
  { value: '128', label: 'до 128 px' },
  { value: '64', label: 'до 64 px' },
]

/** Слева ползунок не уходит в нечитаемое месиво, справа — в бессмысленный вес. */
const MIN_QUALITY = 20
const MAX_QUALITY = 100

const SUFFIXES: Record<string, string> = { avif: '_avif', jpg: '_jpeg', webp: '_webp', ico: '_ico' }

/** Скорость с подсказками — те же, что у видео. */
const SPEED_OPTIONS = SPEED_LABELS.map((label, index) => ({
  value: String(index),
  label,
  title: SPEED_HINTS[index],
}))

/** Настройки, от которых зависит результат: остальные превью не пересчитывают. */
function encodeKey(options: ImageOptions) {
  return [options.format, options.quality, options.max_dimension, options.effort].join('|')
}

/**
 * Панель сжатия изображения.
 *
 * Две кнопки сверху — не отдельная ветка, а именованные положения тех же
 * ручных настроек: выбрали пресет — ползунки встали на его значения, тронули
 * ползунок — подсветка пресета погасла. Рассинхронизации быть не может.
 */
export function ImagePanel({
  file,
  edit,
  onPreview,
}: {
  file: FileInfo
  edit: ImageEdit
  /** Готовое превью уходит наверх: показывает его холст, а не эта панель. */
  onPreview: (preview: ImagePreview | null) => void
}) {
  const presets = useStore((state) => state.presets)
  const checked = useStore((state) => state.checked)
  const files = useStore((state) => state.files)
  const toast = useStore((state) => state.toast)
  const revealQueue = useStore((state) => state.revealQueue)

  const imagePresets: Preset[] = useMemo(() => presets.image ?? [], [presets])
  // Панель пересоздаётся при смене файла, поэтому выбор человека держим
  // в общем хранилище — иначе всё сбрасывалось бы на каждой картинке.
  const [options, setOptions] = useState<ImageOptions>(() => {
    const prefs = loadPrefs()
    const saved = { ...DEFAULT_IMAGE, ...prefs.image } as ImageOptions
    // Раньше по умолчанию стояло «до 1600 px», и оно запомнилось у всех, кто
    // ни разу не трогал размер. Теперь умолчание — «как есть»; переводим один
    // раз, дальше выбор человека снова запоминается как обычно.
    if (!prefs.imageSizeAsIs) {
      savePrefs({ imageSizeAsIs: true })
      if (saved.max_dimension === 1600) saved.max_dimension = 0
    }
    // «Рекомендуемое сжатие» было качеством 94, теперь 90. Запомненные 94 —
    // это прежний пресет, а не выбор человека: переводим один раз.
    if (!prefs.imageQuality90) {
      savePrefs({ imageQuality90: true })
      if (saved.format === 'avif' && saved.quality === 94) saved.quality = 90
    }
    return saved
  })
  // Удаление исходника — не настройка сжатия, а решение про файл, поэтому
  // живёт отдельно от options и уходит в запрос, а не в параметры кодека.
  const [deleteOriginal, setDeleteOriginal] = useState(() => loadPrefs().imageReplace ?? false)
  // Своя приписка из настроек важнее приписки формата.
  const fixedSuffix = useStore((state) => state.settings?.export.file_suffix ?? '')
  // Скорость (усилие) кодировщика: 2 — обычная.
  const [speed, setSpeed] = useState(() => loadPrefs().imageSpeed ?? 2)
  const [intoSubfolder, setIntoSubfolder] = useState(
    () => loadPrefs().subfolder ?? localStorage.getItem('sgh.outputSubfolder') !== 'off',
  )
  const [busy, setBusy] = useState(false)
  const [command, setCommand] = useState<string | null>(null)
  // Движущуюся картинку умеет сохранить только WebP: в AVIF и JPEG влезает
  // один кадр, и от анимации остался бы стоп-кадр. Формат за человека не
  // меняем — спрашиваем перед самой обработкой.
  const animated = Boolean(file.media?.animated)
  const [askSwitch, setAskSwitch] = useState(false)
  // Превью такой картинки в неподходящем формате не считается: задача на
  // сервере честно откажется, и в панели была бы красная строка вместо
  // объяснения, которое и так стоит рядом с форматами.
  const movingUnsupported = animated && options.format !== 'webp'
  const [showPreview, setShowPreview] = useState(() => loadPrefs().imagePreview ?? true)
  const [preview, setPreview] = useState<ImagePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // Пресет не хранится отдельно: он вычисляется из настроек. Иначе подсветка
  // рано или поздно разойдётся с тем, что реально уйдёт в кодировщик.
  const activePreset = imagePresets.find((preset) => {
    const values = preset.options.image
    return (
      !!values &&
      values.format === options.format &&
      values.quality === options.quality &&
      values.max_dimension === options.max_dimension
    )
  })

  // Настройки сжатия храним, а правки кадра — нет: они про конкретную картинку.
  useEffect(() => {
    savePrefs({
      image: {
        format: options.format,
        quality: options.quality,
        max_dimension: options.max_dimension,
      },
    })
  }, [options.format, options.quality, options.max_dimension])

  useEffect(() => {
    savePrefs({ imagePreview: showPreview })
  }, [showPreview])

  const hasEdits =
    Boolean(edit.crop) || edit.boxes.length > 0 || edit.strokes.length > 0 ||
    (edit.texts ?? []).some((mark) => mark.text.trim()) || Boolean(edit.rotate) || Boolean(edit.flipH)

  const editPayload = useMemo(
    () => ({
      crop: edit.crop,
      boxes: edit.boxes,
      // Пустые надписи ни к чему — их и рисовать нечем.
      texts: (edit.texts ?? []).filter((mark) => mark.text.trim()),
      // Мазки превращаем в прозрачный PNG размером с оригинал: описывать
      // каждый из них фильтрами ffmpeg сложнее и хуже, чем наложить слой.
      paint_png: edit.strokes.length
        ? strokesToPng(edit.strokes, file.media?.width ?? 0, file.media?.height ?? 0, '#000000')
        : null,
      rotate: edit.rotate ?? 0,
      flip_h: edit.flipH ?? false,
    }),
    [edit, file.media?.width, file.media?.height],
  )

  // Просчёт живёт с задержкой: человек возит ползунок быстрее, чем кодировщик
  // успевает, и без паузы мы бы запускали ffmpeg на каждый пиксель хода.
  const requestId = useRef(0)
  useEffect(() => {
    if (!showPreview || movingUnsupported) {
      setPreview(null)
      setPreviewError(null)
      onPreview(null)
      return
    }

    const mine = ++requestId.current
    const timer = setTimeout(() => {
      api
        .imagePreview({ source: file.path, image: { ...options, effort: imageEffort(speed), ...editPayload } })
        .then((result) => {
          if (mine !== requestId.current) return
          setPreview(result)
          setPreviewError(null)
          onPreview(result)
        })
        .catch((error: Error) => {
          if (mine !== requestId.current) return
          setPreview(null)
          setPreviewError(error.message)
          onPreview(null)
        })
    }, 350)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, encodeKey(options), speed, editPayload, showPreview])

  // Панель живёт до конца выбора файла — прибираем превью за собой.
  useEffect(() => () => onPreview(null), [onPreview])

  const buildRequest = (source: string, withEdits: boolean, switchFormats: boolean) => ({
    source,
    kind: 'image' as const,
    image: {
      ...options,
      effort: imageEffort(speed),
      // Правки нарисованы для конкретной картинки — в пакет их не тащим.
      crop: withEdits ? editPayload.crop : null,
      boxes: withEdits ? editPayload.boxes : [],
      texts: withEdits ? editPayload.texts : [],
      paint_png: withEdits ? editPayload.paint_png : null,
      rotate: withEdits ? editPayload.rotate : 0,
      flip_h: withEdits ? editPayload.flip_h : false,
    },
    // Без подпапки результат ложится прямо туда, где лежал оригинал.
    output_dir: intoSubfolder ? null : parentDir(source),
    suffix: fixedSuffix || (SUFFIXES[options.format] ?? '_сжатый'),
    preset_label: activePreset?.label,
    replace_original: deleteOriginal,
    allow_format_switch: switchFormats,
  })

  // Отмеченные в медиатеке картинки обрабатываются той же кнопкой.
  const others = checked.filter(
    (path) =>
      path !== file.path &&
      (files.find((item) => item.path === path)?.kind ?? '') === 'image',
  )
  // Снятая галочка означает «эту картинку не трогать» — даже если она открыта.
  const openChecked = checked.includes(file.path)
  const batch = openChecked ? [file.path, ...others] : others
  // Ничего не отмечено — кнопка сжимает открытую картинку.
  const single = batch.length === 0

  // Сколько отмеченных картинок движется — считается перед самой обработкой.
  // По одному расширению судить нельзя: так любой WebP сходил за движущийся,
  // и вопрос о движении всплывал на пачке обычных картинок. Сервер читает
  // заголовки файлов — несколько байт на файл, — и отвечает точно.
  const [movingCount, setMovingCount] = useState(0)
  const MAY_MOVE = ['.gif', '.webp', '.png', '.apng']

  async function start() {
    if (options.format === 'webp') return run()
    if (single) {
      if (!movingUnsupported) return run()
      setMovingCount(1)
      setAskSwitch(true)
      return
    }
    const candidates = batch.filter((path) =>
      MAY_MOVE.some((ext) => path.toLowerCase().endsWith(ext)),
    )
    if (candidates.length) {
      setBusy(true)
      const found = await api
        .movingImages(candidates)
        .then((answer) => answer.moving.length)
        // Спросить не вышло — пусть решает сервер: он сам откажется от
        // движущихся и напишет в очереди, какие именно.
        .catch(() => 0)
      setBusy(false)
      if (found > 0) {
        setMovingCount(found)
        setAskSwitch(true)
        return
      }
    }
    await run()
  }

  async function run(switchFormats = false) {
    setBusy(true)
    try {
      if (single) {
        await api.export(buildRequest(file.path, true, switchFormats))
      } else {
        // Правки кадра нарисованы для открытой картинки, к остальным их не тащим.
        const items = batch.map((path) =>
          buildRequest(path, path === file.path, switchFormats),
        )
        const result = await api.exportBatch(items)
        if (result.errors.length) toast(result.errors[0].error, 'error')
        toast(
          `Обрабатываю ${result.jobs.length} ${plural(result.jobs.length, ['картинку', 'картинки', 'картинок'])}`,
          'ok',
        )
        // Отправленные файлы из отметок убираем: иначе следующая пачка
        // прихватила бы их снова. Отметки других типов остаются.
        const sent = new Set(batch)
        const store = useStore.getState()
        store.setChecked(store.checked.filter((path) => !sent.has(path)))
      }
      revealQueue()
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }


  // Своя команда ffmpeg: пока поле открыто, оно пересобирается под настройки.
  // Сломали строку — тронули настройку, и появилась рабочая.
  async function loadCommand() {
    try {
      const preview = await api.exportPreview(buildRequest(file.path, true, false))
      setCommand(preview.command ?? '')
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }
  useEffect(() => {
    if (command === null) return
    let cancelled = false
    api
      .exportPreview(buildRequest(file.path, true, false))
      .then((preview) => !cancelled && setCommand(preview.command ?? ''))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encodeKey(options), speed, editPayload, intoSubfolder])

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

  // Нарисованное поверх команда не видит: программа кладёт его отдельным
  // проходом до неё.
  const drawn =
    edit.boxes.length > 0 || edit.strokes.length > 0 || (edit.texts ?? []).some((mark) => mark.text.trim())
  // У значка и PNG качества нет: они без потерь.
  const lossless = options.format === 'ico' || options.format === 'png'

  const formatLabel = FORMATS.find((item) => item.value === options.format)?.label ?? options.format
  const sizeLabel = SIZES.find((item) => item.value === String(options.max_dimension))?.label

  return (
    <QuietHints>
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <Section
          title="Пресеты сжатия"
          id="image.presets"
          summary={activePreset?.label ?? 'свои настройки'}
        >
          <div className="grid gap-1.5">
            {imagePresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() =>
                  setOptions((current) => ({
                    ...current,
                    ...preset.options.image,
                  }))
                }
                // Описание — при наведении, чтобы пресеты не занимали пол-колонки.
                title={preset.hint}
                className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                  activePreset?.id === preset.id
                    ? 'border-accent/60 bg-accent/10 shadow-[0_0_8px_rgba(22,156,145,0.1)]'
                    : 'border-line-soft bg-surface-2 hover:border-line hover:bg-surface-3'
                }`}
              >
                <span className="block text-[13px] font-medium text-ink">{preset.label}</span>
                {preset.tech && (
                  <span className="mt-0.5 block font-mono text-[10px] text-ink-faint/70">
                    {preset.tech}
                  </span>
                )}
              </button>
            ))}
          </div>
        </Section>

        <Section
          title="Настроить вручную"
          id="image.manual"
          summary={`${formatLabel}${lossless ? '' : ` · ${options.quality}`}${sizeLabel ? ` · ${sizeLabel}` : ''}`}
        >
          <Segmented<Format>
            value={options.format as Format}
            onChange={(value) => setOptions({ ...options, format: value })}
            options={FORMATS}
          />
          {animated && (
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-[11px] leading-snug text-ink-dim">
              Это движущаяся картинка. Сохранить движение умеет только WebP — в
              остальных форматах остался бы один кадр.
            </p>
          )}

          {options.format === 'ico' && (
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-[11px] leading-snug text-ink-dim">
              Значок получится квадратным, не больше 256 точек: картинка
              впишется целиком, а лишнее по краям останется прозрачным.
            </p>
          )}

          {!lossless && (
          <div>
            <div className="flex items-center justify-between">
              <span className="label">Качество</span>
              <span className="font-mono text-[11px] tabular-nums text-ink-dim">
                {options.quality}
              </span>
            </div>
            <input
              type="range"
              min={MIN_QUALITY}
              max={MAX_QUALITY}
              step={1}
              value={options.quality}
              onChange={(event) =>
                setOptions({ ...options, quality: Number(event.target.value) })
              }
              className="w-full"
            />
            <div className="flex justify-between text-[10px] text-ink-faint">
              <span>Экстрим</span>
              <span>Средне</span>
              <span>Лёгкое</span>
            </div>
          </div>
          )}

          {/* Размер и скорость — одной строкой, как скорость и контейнер у
              видео. У JPEG, PNG и значка скорости нет. */}
          <div className="flex gap-2">
            <Choice
              label="Размер"
              hint="Предел по длинной стороне. Уменьшает только слишком большие картинки, маленькие не растягивает"
              value={String(options.max_dimension)}
              options={SIZES}
              onChange={(value) => setOptions({ ...options, max_dimension: Number(value) })}
            />
            {(options.format === 'avif' || options.format === 'webp') && (
              <Choice
                label="Скорость"
                hint="Сколько кодировщик старается. Медленнее — дольше ждать, но при том же качестве файл чуть легче"
                value={String(speed)}
                options={SPEED_OPTIONS}
                onChange={(value) => {
                  setSpeed(Number(value))
                  savePrefs({ imageSpeed: Number(value) })
                }}
              />
            )}
          </div>
        </Section>

        {/* Вес результата виден на самой картинке — на кнопке «После» над ней,
            поэтому отдельного окошка «было → стало» здесь нет. Остаётся только
            ошибка просчёта: её больше показать негде. */}
        <Section
          title="Доп настройки"
          id="image.result"
          summary={
            <MarkIcons
              marks={[
                ...(deleteOriginal ? [{ icon: FileX2, label: 'Оригинал уйдёт в корзину', danger: true }] : []),
                ...(showPreview ? [{ icon: Eye, label: 'Показывать превью' }] : []),
                ...(intoSubfolder ? [{ icon: FolderInput, label: 'Результат — в подпапку' }] : []),
                ...(command !== null ? [{ icon: Terminal, label: 'Своя команда ffmpeg' }] : []),
              ]}
            />
          }
        >
          {showPreview && previewError && (
            <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[12px] text-danger ring-1 ring-line-soft">
              {previewError}
            </p>
          )}

          <Toggle
            checked={showPreview}
            onChange={setShowPreview}
            label="Показывать превью"
            hint="Каждое движение ползунка пересчитывает картинку по-настоящему. На слабой машине это заметно — тогда выключите."
          />
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
              savePrefs({ imageReplace: value })
            }}
            label="Удалить оригинал"
            hint="После успешного сжатия исходная картинка уйдёт в корзину Windows — оттуда её можно вернуть. По умолчанию выключено."
          />
          <Toggle
            checked={command !== null}
            onChange={(value) => (value ? void loadCommand() : setCommand(null))}
            label="Задать параметры в консоли ffmpeg"
            hint="Для тех, кто знает ffmpeg: показывает готовую команду, её можно поправить и запустить как есть."
          />
          {command !== null && (
            <div className="space-y-2">
              <textarea
                className="field h-40 resize-y font-code text-[10.5px] leading-relaxed"
                spellCheck={false}
                value={command}
                onChange={(event) => setCommand(event.target.value)}
              />
              <p className="text-[11px] leading-snug text-ink-faint">
                {drawn
                  ? 'Заливки, кисть и надписи в команду не входят: программа кладёт их отдельным шагом до неё. Обрезка, поворот и размер — входят. '
                  : ''}
                Последнее слово в строке — путь к результату. Запускается только ffmpeg, ничего другого.
              </p>
              <Button onClick={() => void runRaw()} disabled={busy} className="w-full">
                <Terminal size={14} />
                Запустить эту команду
              </Button>
            </div>
          )}
        </Section>

      </div>

      <div className="border-t border-line-soft bg-surface px-4 py-3">
        <Button tone="primary" onClick={() => void start()} disabled={busy} className="w-full py-2.5">
          <Play size={15} />
          {!single
            ? `Сжать ${batch.length} ${plural(batch.length, ['картинку', 'картинки', 'картинок'])}`
            : hasEdits
              ? 'Применить правки и сжать'
              : 'Сжать изображение'}
        </Button>
        {others.length > 0 && !openChecked && (
          <p className="mt-1.5 text-center text-[11px] leading-snug text-ink-faint">
            Открытая картинка не отмечена — её программа не тронет.
          </p>
        )}

        <Modal
          open={askSwitch}
          onClose={() => setAskSwitch(false)}
          title="Движущиеся картинки"
        >
          <div className="space-y-3 text-[12.5px] leading-snug text-ink-dim">
            <p>
              {single
                ? 'Эта картинка движется, а выбранный формат хранит только один кадр — от движения ничего не останется.'
                : `Среди отмеченных есть движущиеся картинки (${movingCount} шт.), а выбранный формат хранит только один кадр.`}
            </p>
            <p>
              Сохранить движение умеет только WebP. Ответ запомнится на всю эту
              пачку: все движущиеся файлы в ней пойдут в WebP, остальные — тем
              форматом, что выбран, как и задумано.
            </p>
            <div className="flex gap-2 pt-1">
              <Button
                tone="primary"
                className="flex-1"
                onClick={() => {
                  setAskSwitch(false)
                  void run(true)
                }}
              >
                Взять WebP для всех таких
              </Button>
              <Button
                onClick={() => {
                  setAskSwitch(false)
                  void run(false)
                }}
              >
                Оставить как есть
              </Button>
            </div>
            <p className="text-[11px] text-ink-faint">
              «Оставить как есть» — движущиеся файлы просто не обработаются, в
              очереди будет видно, какие именно. Что уже обрабатывается сейчас,
              это окно не останавливает.
            </p>
          </div>
        </Modal>
      </div>
    </div>
    </QuietHints>
  )
}
