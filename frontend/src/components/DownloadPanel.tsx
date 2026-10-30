import { useEffect, useState } from 'react'
import {
  ClipboardPaste,
  Download,
  Film,
  FileX2,
  FolderInput,
  FolderOpen,
  Images,
  ListVideo,
  Loader2,
  Plus,
  Eraser,
  Scissors,
  Tags,
  Trash2,
  X,
  ZoomIn,
} from 'lucide-react'
import { api } from '../lib/api'
import { plural, timecode } from '../lib/format'
import { loadPrefs, savePrefs } from '../lib/prefs'
import type { GalleryItem, Preset } from '../lib/types'
import { useStore } from '../store'
import { Choice } from './ComposeRender'
import { FolderPicker } from './FolderPicker'
import { LinkPreview } from './LinkPreview'
import { Button, MarkIcons, Modal, QuietHints, Section, Segmented, Toggle } from './ui'

/**
 * Обработка пресетом сразу после скачивания — выключена. Качество и кодек
 * теперь выбираются при самой загрузке, и сжимать уже сжатое незачем.
 * Раздел целиком на месте и собирается вместе с программой: чтобы вернуть
 * его, достаточно поставить здесь true. Список пресетов сам подстраивается
 * под «Что скачать», после обработки можно убрать оригинал и выбрать, куда
 * положить результат (`_chain_processing` на сервере).
 */
const PRESETS_AFTER_DOWNLOAD = false

type Container = 'mp4' | 'mkv' | 'webm' | 'auto'
type Sound = 'any' | 'aac' | 'opus'

const SOUNDS: { value: Sound; label: string; title: string }[] = [
  { value: 'any', label: 'Лучший', title: 'Звук, который сайт отдаёт к видео. В MP4 — AAC, в MKV и WebM обычно Opus' },
  { value: 'aac', label: 'AAC', title: 'Открывается везде, в том числе в монтажных программах и старых плеерах' },
  { value: 'opus', label: 'Opus', title: 'Чуть лучше звучит при том же весе, но старые программы и монтажные его не всегда открывают' },
]

/** Битрейт при скачивании одного звука. «Лучшее» — сколько даёт сайт. */
const AUDIO_QUALITIES = [
  { value: '0', label: 'Лучшее', title: 'Сколько даёт сайт, без потерь при перекодировании' },
  { value: '320', label: '320 кбит/с' },
  { value: '192', label: '192 кбит/с' },
  { value: '128', label: '128 кбит/с' },
  { value: '96', label: '96 кбит/с' },
]
type Codec = 'any' | 'h264' | 'vp9' | 'av1'

/** Предел качества при скачивании. Больше исходника сайт всё равно не даст. */
const HEIGHTS = [
  { value: '0', label: 'Максимальное', short: 'Макс.', title: 'Лучшее, что есть у сайта' },
  { value: '2160', label: '4K' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
  { value: '360', label: '360p' },
]

const CONTAINERS: { value: Container; label: string; title: string }[] = [
  { value: 'mp4', label: 'MP4', title: 'Открывается везде, в том числе во встроенном плеере программы' },
  { value: 'mkv', label: 'MKV', title: 'Берёт любые дорожки сайта без переупаковки. Телефоны и монтажные программы открывают его хуже' },
  { value: 'webm', label: 'WebM', title: 'Для сайтов: внутри только VP9 или AV1 с Opus. Если у ролика таких дорожек нет, файл соберётся в MKV' },
  { value: 'auto', label: 'Как у сайта', title: 'Без приведения: файл в том виде, в каком его отдаёт сайт' },
]

const CODECS: { value: Codec; label: string; title: string }[] = [
  {
    value: 'any',
    label: 'Лучший',
    title: 'Самое большое разрешение, каким бы кодеком оно ни было. У YouTube это обычно AV1, у части роликов — VP9 (бывает крупнее AV1, если тот есть только в меньшем размере), у других сайтов — чаще всего H.264',
  },
  {
    value: 'h264',
    label: 'H.264',
    title: 'Для монтажных программ и старых устройств — не придётся перегонять. У YouTube H.264 есть только до 1080p и при том же размере выглядит хуже AV1. Если у ролика H.264 нет, скачается лучшее, что есть',
  },
  {
    value: 'vp9',
    label: 'VP9',
    title: 'Кодек YouTube до AV1: у многих роликов он есть в большем размере, чем AV1, а играется почти везде, кроме самых старых устройств. Если у ролика VP9 нет, скачается лучшее, что есть',
  },
  { value: 'av1', label: 'AV1', title: 'Лучшее сжатие: файл легче при той же картинке. Если у ролика AV1 нет, скачается лучшее, что есть' },
]

type Mode = 'auto' | 'video' | 'audio' | 'images'

interface Row {
  id: number
  url: string
  start: number | null
  end: number | null
}

let nextId = 1
const emptyRow = (url = ''): Row => ({ id: nextId++, url, start: null, end: null })

/** «1:23» / «83» / «1:02:03» -> секунды. Пустая строка -> null. */
function parseTime(raw: string): number | null {
  const text = raw.trim().replace(',', '.')
  if (!text) return null
  const parts = text.split(':').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part))) return null
  return parts.reduce((total, part) => total * 60 + part, 0)
}

export function DownloadPanel() {
  const settings = useStore((state) => state.settings)
  const presets = useStore((state) => state.presets)
  const toast = useStore((state) => state.toast)
  const revealQueue = useStore((state) => state.revealQueue)
  const status = useStore((state) => state.status)
  const refreshSettings = useStore((state) => state.refreshSettings)

  const [rows, setRows] = useState<Row[]>([emptyRow()])
  const [mode, setMode] = useState<Mode>('auto')
  // Настройки загрузки запоминаются: их выбирают под свою привычку, а не под
  // конкретную ссылку.
  const [maxHeight, setMaxHeight] = useState(() => loadPrefs().downloadHeight ?? 0)
  const [container, setContainer] = useState<Container>(
    () => loadPrefs().downloadContainer ?? (settings?.download.force_mp4 === false ? 'auto' : 'mp4'),
  )
  const [codec, setCodec] = useState<Codec>(() => loadPrefs().downloadCodec ?? 'any')
  const [keepOriginal, setKeepOriginal] = useState(() => loadPrefs().downloadKeepOriginal ?? true)
  const [processSubfolder, setProcessSubfolder] = useState(() => loadPrefs().downloadSubfolder ?? true)
  // H.264 в WebM не кладётся — тогда собираем в MP4.
  const shownContainer: Container = container === 'webm' && codec === 'h264' ? 'mp4' : container
  const [audioFormat, setAudioFormat] = useState<'opus' | 'mp3' | 'm4a' | 'best'>(
    () => loadPrefs().downloadAudioFormat ?? 'opus',
  )
  const [audioQuality, setAudioQuality] = useState(() => loadPrefs().downloadAudioQuality ?? 0)
  const [sound, setSound] = useState<Sound>(() => loadPrefs().downloadSound ?? 'any')
  // Увеличенная картинка поста — чтобы разглядеть, прежде чем выбрать.
  const [zoomed, setZoomed] = useState<string | null>(null)
  const [autoPreset, setAutoPreset] = useState('')
  const [busy, setBusy] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewRow, setPreviewRow] = useState<number | null>(null)

  const [gallery, setGallery] = useState<{ url: string; items: GalleryItem[] } | null>(null)
  const [picked, setPicked] = useState<number[]>([])
  const [probing, setProbing] = useState(false)
  const [folderPicker, setFolderPicker] = useState(false)

  const filled = rows.filter((row) => row.url.trim())
  const ytdlpReady = status?.tools['yt-dlp']?.available ?? false
  const galleryReady = status?.tools['gallery-dl']?.available ?? false

  // Показываем только те пресеты, которые подходят к выбранному типу
  // загрузки: выбрав «Кадры», человек раньше видел в списке сжатие видео
  // и звука, выбирал его — и не понимал, почему ничего не происходит.
  //
  // «Без сжатия» в списке не нужен вовсе: это то же самое, что «Просто
  // скачать». К видео добавляем звук — бывает, что из ролика нужен один звук.
  const videoPresets = (presets.video ?? []).filter((preset) => !preset.options.stream_copy)
  const groups: { title: string; items: Preset[] }[] =
    mode === 'images'
      ? [{ title: 'Картинки', items: presets.image ?? [] }]
      : mode === 'audio'
        ? [{ title: 'Звук', items: presets.audio ?? [] }]
        : mode === 'video'
          ? [
              { title: 'Видео', items: videoPresets },
              { title: 'Звук', items: presets.audio ?? [] },
            ]
          // В «Авто» тип заранее неизвестен — всё, но разложенное по видам.
          : [
              { title: 'Видео', items: videoPresets },
              { title: 'Звук', items: presets.audio ?? [] },
              { title: 'Картинки', items: presets.image ?? [] },
            ]
  const autoPresets = groups.flatMap((group) => group.items)

  // Сменили тип — выбранный пресет мог стать неподходящим, снимаем его.
  useEffect(() => {
    if (autoPreset && !autoPresets.some((preset) => preset.id === autoPreset)) {
      setAutoPreset('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  function patchRow(id: number, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  function removeRow(id: number) {
    setRows((current) => {
      const next = current.filter((row) => row.id !== id)
      return next.length ? next : [emptyRow()]
    })
  }

  /** Вставка нескольких ссылок разом раскладывается по отдельным строкам. */
  function handlePaste(id: number, text: string) {
    const links = text
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (links.length < 2) return false

    setRows((current) => {
      const index = current.findIndex((row) => row.id === id)
      const inserted = links.map((link) => emptyRow(link))
      const next = [...current]
      next.splice(index, 1, ...inserted)
      return next
    })
    return true
  }

  /** Раскладывает ссылки из текста по строкам. Возвращает, сколько нашлось. */
  function addLinks(text: string): number {
    const links = text
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => /^https?:\/\//i.test(item))

    if (!links.length) return 0

    setRows((current) => {
      const next = current.map((row) => ({ ...row }))
      const queue = [...links]
      for (const row of next) {
        if (!row.url.trim() && queue.length) row.url = queue.shift() as string
      }
      return [...next, ...queue.map((link) => emptyRow(link))]
    })
    return links.length
  }

  // Ctrl+V где угодно на вкладке — ссылка попадает в список. Целиться мышью
  // в узкую строчку каждый раз неудобно, а событие вставки приходит и без
  // разрешения на чтение буфера.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      // В поле ввода вставку обрабатывает само поле.
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return

      const text = event.clipboardData?.getData('text') ?? ''
      const count = addLinks(text)
      if (count) {
        event.preventDefault()
        toast(`Добавлено ссылок: ${count}`, 'ok')
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Кладёт ссылки из буфера обмена в свободные строки. */
  async function pasteFromClipboard() {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      toast('Нет доступа к буферу обмена — вставьте ссылку через Ctrl+V', 'error')
      return
    }
    const links = text
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => /^https?:\/\//i.test(item))

    if (!links.length) {
      toast('В буфере обмена нет ссылок', 'error')
      return
    }

    setRows((current) => {
      // Сначала заполняем пустые строки, остальные добавляем в конец.
      const next = current.map((row) => ({ ...row }))
      const queue = [...links]
      for (const row of next) {
        if (!row.url.trim() && queue.length) row.url = queue.shift() as string
      }
      return [...next, ...queue.map((link) => emptyRow(link))]
    })
    toast(`Добавлено ссылок: ${links.length}`, 'ok')
  }

  // Ссылку стёрли или поменяли — список её картинок больше не про неё.
  useEffect(() => {
    if (gallery && !filled.some((row) => row.url.trim() === gallery.url)) {
      setGallery(null)
      setPicked([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  /** Сохраняет настройку загрузки и сразу перечитывает их с сервера. */
  async function patchDownload(value: Record<string, unknown>) {
    try {
      await api.patchSettings({ download: value })
      await refreshSettings()
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }

  // Общие для любой загрузки: кодек, формат файла и что делать с оригиналом
  // после пресета.
  const downloadOptions = {
    container: shownContainer,
    video_codec: codec,
    audio_codec: sound,
    audio_quality: audioFormat === 'best' ? 0 : audioQuality,
    keep_original: keepOriginal,
    process_subfolder: processSubfolder,
  }

  async function start() {
    if (!filled.length) {
      toast('Вставьте хотя бы одну ссылку', 'error')
      return
    }

    // Одна ссылка на пост с несколькими вложениями — сначала спрашиваем,
    // что именно скачивать. Для пачки ссылок так делать нельзя: человек
    // утонет в окнах выбора, поэтому там качаем всё.
    if (filled.length === 1 && galleryReady && mode !== 'video' && mode !== 'audio') {
      setProbing(true)
      try {
        const found = await api.probeGallery(filled[0].url.trim())
        if (found.items.length > 1) {
          setGallery({ url: found.url, items: found.items })
          setPicked(found.items.map((item) => item.index))
          return
        }
      } catch {
        // Не пост с картинками — качаем обычным путём.
      } finally {
        setProbing(false)
      }
    }

    setBusy(true)
    try {
      const result = await api.download({
        items: filled.map((row) => ({ url: row.url.trim(), start: row.start, end: row.end })),
        mode,
        max_height: maxHeight,
        audio_format: audioFormat,
        auto_process_preset: autoPreset || null,
        ...downloadOptions,
      })
      if (result.errors.length) toast(result.errors[0].error, 'error')
      toast(
        `В очередь добавлено ${result.jobs.length} ${plural(result.jobs.length, ['ссылка', 'ссылки', 'ссылок'])}`,
        'ok',
      )
      revealQueue()
      // Ссылки намеренно оставляем на месте: из одного ролика часто нужно
      // вырезать несколько кусков, и вбивать адрес заново каждый раз —
      // лишняя работа. Ненужную строку можно убрать крестиком.
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function loadGallery(url: string) {
    // Старый список убираем сразу: иначе он висит на экране, пока грузится
    // новый, и кажется, что кнопка не сработала.
    setGallery(null)
    setPicked([])
    setProbing(true)
    try {
      const result = await api.probeGallery(url)
      if (!result.items.length) {
        toast('В этом посте не нашлось изображений', 'error')
        return
      }
      setGallery({ url: result.url, items: result.items })
      setPicked(result.items.map((item) => item.index))
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setProbing(false)
    }
  }

  async function downloadGallerySelection() {
    if (!gallery) return
    setBusy(true)
    try {
      await api.download({
        items: [{ url: gallery.url }],
        mode: 'images',
        selection: picked,
        auto_process_preset: autoPreset || null,
        ...downloadOptions,
      })
      toast('Выбранные картинки добавлены в очередь', 'ok')
      revealQueue()
      setGallery(null)
      setPicked([])
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Слева — ссылки и картинки, справа — настройки и кнопка.
          Так же устроена медиатека, и кнопка «Скачать» перестаёт
          ездить по экрану при прокрутке. */}
      <div className="min-w-0 flex-1 space-y-5 overflow-y-auto px-6 py-6">
      {/* Список ссылок */}
      <div className="space-y-2">
        {rows.map((row, index) => (
          <LinkRow
            key={row.id}
            number={index + 1}
            row={row}
            disabled={!ytdlpReady}
            onChange={(patch) => patchRow(row.id, patch)}
            onPasteMany={(text) => handlePaste(row.id, text)}
            onRemove={() => removeRow(row.id)}
            onPreview={() => {
              setPreviewUrl(row.url.trim())
              setPreviewRow(row.id)
            }}
            onGallery={() => void loadGallery(row.url.trim())}
            galleryReady={galleryReady}
            probing={probing}
          />
        ))}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void pasteFromClipboard()}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-dashed border-line py-2 text-[12px] text-ink-dim transition-colors hover:border-ink-faint hover:text-ink"
          >
            <ClipboardPaste size={13} />
            Вставить из буфера
          </button>
          <button
            type="button"
            onClick={() => setRows((current) => [...current, emptyRow()])}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-dashed border-line py-2 text-[12px] text-ink-faint transition-colors hover:text-ink-dim"
          >
            <Plus size={13} />
            Пустая строка
          </button>
          <button
            type="button"
            disabled={!filled.length && rows.length < 2}
            onClick={() => {
              setRows([emptyRow()])
              setGallery(null)
              setPicked([])
            }}
            title="Стереть все ссылки"
            className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-line px-3 py-2 text-[12px] text-ink-faint transition-colors hover:border-danger/50 hover:text-danger disabled:opacity-35 disabled:hover:border-line disabled:hover:text-ink-faint"
          >
            <Eraser size={13} />
            Очистить
          </button>
        </div>
      </div>

      {gallery && (
        <div className="animate-in-up space-y-3 rounded-xl bg-surface-2 p-3 ring-1 ring-line-soft">
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] font-medium">Найдено файлов: {gallery.items.length}</span>
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                className="text-ink-dim hover:text-ink"
                onClick={() => setPicked(gallery.items.map((item) => item.index))}
              >
                Выбрать все
              </button>
              <button type="button" className="text-ink-dim hover:text-ink" onClick={() => setPicked([])}>
                Снять выбор
              </button>
              <button
                type="button"
                title="Закрыть выбор"
                className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
                onClick={() => {
                  setGallery(null)
                  setPicked([])
                }}
              >
                <X size={13} />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {gallery.items.map((item) => {
              const active = picked.includes(item.index)
              return (
                <button
                  key={item.index}
                  type="button"
                  onClick={() =>
                    setPicked(
                      active ? picked.filter((i) => i !== item.index) : [...picked, item.index],
                    )
                  }
                  className={`relative aspect-square overflow-hidden rounded-lg ring-2 transition-all ${
                    active ? 'ring-accent' : 'ring-transparent opacity-55 hover:opacity-85'
                  }`}
                >
                  <img
                    src={item.url}
                    alt=""
                    className="h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                  <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[10px] font-semibold">
                    {item.index}
                  </span>
                  <span
                    role="button"
                    title="Увеличить"
                    onClick={(event) => {
                      event.stopPropagation()
                      setZoomed(item.url)
                    }}
                    className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded bg-black/70 text-white/80 hover:bg-black/90 hover:text-white"
                  >
                    <ZoomIn size={13} />
                  </span>
                </button>
              )
            })}
          </div>
          <p className="text-[11px] text-ink-faint">
            Превью подгружаются напрямую с сайта-источника. Если картинки не отображаются — это
            защита от чужих ссылок, на само скачивание она не влияет.
          </p>
        </div>
      )}

      </div>

      <QuietHints>
      <aside className="flex w-[clamp(260px,22vw,340px)] shrink-0 flex-col border-l border-line-soft bg-surface">
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5">
          <Section title="Что скачать">
            <Segmented<Mode>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'auto', label: 'Авто', title: 'Определить по ссылке: пост с картинками — картинки, остальное — видео' },
                { value: 'video', label: 'Видео' },
                { value: 'audio', label: 'Звук' },
                {
                  // «Кадры» — как в фильтре медиатеки: «Картинки» не влезали.
                  value: 'images',
                  label: 'Кадры',
                  title: 'Картинки: по ссылке на пост — его картинки, по ссылке на видео — превью ролика',
                },
              ]}
            />
          </Section>

          {mode === 'audio' ? (
            <Section title="Звук">
              <Segmented
                value={audioFormat}
                onChange={(value) => {
                  setAudioFormat(value)
                  savePrefs({ downloadAudioFormat: value })
                }}
                options={[
                  { value: 'opus', label: 'Opus', title: 'Минимальный вес' },
                  { value: 'mp3', label: 'MP3', title: 'Совместимость со всем' },
                  {
                    value: 'm4a',
                    label: 'AAC',
                    title: 'Открывается везде. Файл будет с расширением .m4a — это обычная обёртка для AAC: в ней хранятся название, обложка и разметка для перемотки',
                  },
                  { value: 'best', label: 'Авто', title: 'Оставить формат источника — без перекодирования' },
                ]}
              />
              {audioFormat !== 'best' && (
                <Choice
                  label="Качество"
                  hint="Битрейт звука после перевода в выбранный формат. Выше, чем отдаёт сайт, лучше не станет"
                  value={String(audioQuality)}
                  options={AUDIO_QUALITIES}
                  onChange={(value) => {
                    setAudioQuality(Number(value))
                    savePrefs({ downloadAudioQuality: Number(value) })
                  }}
                />
              )}
            </Section>
          ) : mode !== 'images' ? (
            <Section
              title="Видео"
              id="download.video"
              summary={`${HEIGHTS.find((item) => item.value === String(maxHeight))?.label ?? ''} · ${
                CONTAINERS.find((item) => item.value === shownContainer)?.label
              }${codec !== 'any' ? ` · ${codec === 'h264' ? 'H.264' : 'AV1'}` : ''}`}
            >
              <div className="flex gap-2">
                <Choice
                  label="Качество"
                  hint="Предел качества. Если у ролика меньше, скачается то, что есть"
                  value={String(maxHeight)}
                  options={HEIGHTS}
                  onChange={(value) => {
                    setMaxHeight(Number(value))
                    savePrefs({ downloadHeight: Number(value) })
                  }}
                />
                <Choice
                  label="Формат файла"
                  hint="«Коробка», в которую сложатся видео и звук. Если не знаете, что выбрать, — MP4"
                  value={shownContainer}
                  options={CONTAINERS.map((item) => ({
                    ...item,
                    disabled: item.value === 'webm' && codec === 'h264',
                  }))}
                  onChange={(value) => {
                    setContainer(value as Container)
                    savePrefs({ downloadContainer: value as Container })
                  }}
                />
              </div>
              <div>
                <span className="label">Кодек</span>
                <Segmented<Codec>
                  value={codec}
                  onChange={(value) => {
                    setCodec(value)
                    savePrefs({ downloadCodec: value })
                  }}
                  options={CODECS}
                />
              </div>
              <div>
                <span className="label">Звук</span>
                <Segmented<Sound>
                  value={sound}
                  onChange={(value) => {
                    setSound(value)
                    savePrefs({ downloadSound: value })
                  }}
                  options={SOUNDS}
                />
              </div>
            </Section>
          ) : null}

          {PRESETS_AFTER_DOWNLOAD && (
          <Section
            title="После скачивания"
            id="download.process"
            summary={autoPresets.find((preset) => preset.id === autoPreset)?.label ?? 'просто скачать'}
          >
            <Choice
              label="Пресет"
              hint="Скачанный файл сразу уйдёт в обработку с этим пресетом"
              value={autoPreset}
              onChange={setAutoPreset}
              options={[
                { value: '', label: 'Просто скачать' },
                // Виды разделены строками, которые нельзя выбрать. Одного вида —
                // разделитель не нужен. Чем жмёт пресет — в подсказке пункта.
                ...groups.flatMap((group) => [
                  ...(groups.length > 1
                    ? [{ value: `--${group.title}`, label: `──── ${group.title} ────`, disabled: true }]
                    : []),
                  ...group.items.map((preset) => ({
                    value: preset.id,
                    label: preset.label,
                    title: preset.tech ? `${preset.tech}. ${preset.hint}` : preset.hint,
                  })),
                ]),
              ]}
            />
            {autoPreset && (
              <div className="space-y-1 rounded-xl bg-surface-2 px-3 py-2.5">
                <Toggle
                  checked={keepOriginal}
                  onChange={(value) => {
                    setKeepOriginal(value)
                    savePrefs({ downloadKeepOriginal: value })
                  }}
                  label="Оставить скачанный оригинал"
                  hint="Если выключить, после обработки скачанный файл уйдёт в корзину Windows и останется только обработанный. Если обработка не удалась или результат вышел тяжелее, оригинал останется."
                />
                <Toggle
                  checked={processSubfolder}
                  onChange={(value) => {
                    setProcessSubfolder(value)
                    savePrefs({ downloadSubfolder: value })
                  }}
                  label="Положить результат в подпапку"
                  hint="Обработанный файл ляжет в подпапку рядом со скачанным. Имя подпапки задаётся в настройках. Если выключить — рядом со скачанным."
                />
              </div>
            )}
          </Section>
          )}

          <Section title="Куда скачивать">
            {/* Папку меняют часто — значит она должна быть на виду,
                а не строчкой мелким шрифтом под кнопкой. */}
            <button
              type="button"
              onClick={() => setFolderPicker(true)}
              className="flex w-full items-center gap-2 rounded-xl border border-line-soft bg-surface-2 px-3 py-2.5 text-left transition-colors hover:border-line hover:bg-surface-3"
            >
              <FolderOpen size={14} className="shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-dim">
                {settings?.download.directory ?? `${settings?.resolvedWorkspace ?? ''}\Скачанное`}
              </span>
            </button>
          </Section>

          <Section
            title="Доп настройки"
            id="download.extra"
            summary={
              <MarkIcons
                marks={[
                  ...((settings?.download.embed_metadata ?? true) ? [{ icon: Tags, label: 'Метаданные и обложка' }] : []),
                  ...(settings?.download.download_playlists ? [{ icon: ListVideo, label: 'Плейлисты целиком' }] : []),
                  ...(autoPreset && !keepOriginal ? [{ icon: FileX2, label: 'Оригинал уйдёт в корзину', danger: true }] : []),
                  ...(autoPreset && processSubfolder ? [{ icon: FolderInput, label: 'Результат — в подпапку' }] : []),
                ]}
              />
            }
          >
            {/* Живут здесь, а не в общих настройках: их трогают ради
                конкретной ссылки, и бегать в другое окно неудобно. */}
            <div className="space-y-1 rounded-xl bg-surface-2 px-3 py-2.5">
              <Toggle
                checked={settings?.download.embed_metadata ?? true}
                onChange={(value) => void patchDownload({ embed_metadata: value })}
                label="Встраивать метаданные и обложку"
                hint="Внутрь файла записывается название, автор и картинка-обложка. Плееры показывают их вместо имени файла, а обложка видна в проводнике."
              />
              <Toggle
                checked={settings?.download.download_playlists ?? false}
                onChange={(value) => void patchDownload({ download_playlists: value })}
                label="Скачивать плейлисты целиком"
                hint="По умолчанию из ссылки на плейлист берётся только одно видео."
              />
            </div>
          </Section>

        </div>
        <div className="border-t border-line-soft bg-surface px-4 py-3">
        <Button
          tone="primary"
          className="w-full py-2.5"
          disabled={!filled.length || busy || probing || !ytdlpReady}
          onClick={() => void (gallery ? downloadGallerySelection() : start())}
        >
          {busy || probing ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Download size={15} />
          )}
          {probing
            ? 'Смотрю, что в посте…'
            : gallery
              ? `Скачать выбранные (${picked.length})`
              : `Скачать ${filled.length > 1 ? `(${filled.length})` : ''}`}
        </Button>
        </div>
      </aside>
      </QuietHints>

      <FolderPicker
        open={folderPicker}
        onClose={() => setFolderPicker(false)}
        title="Папка для скачанного"
        onPick={async (path) => {
          await api.patchSettings({ download: { directory: path } })
          await refreshSettings()
        }}
      />

      <Modal open={Boolean(zoomed)} onClose={() => setZoomed(null)} title="Картинка поста" wide>
        {zoomed && (
          <img
            src={zoomed}
            alt=""
            referrerPolicy="no-referrer"
            className="mx-auto max-h-[70vh] max-w-full object-contain"
          />
        )}
      </Modal>

      <LinkPreview
        url={previewUrl ?? ''}
        open={Boolean(previewUrl)}
        onClose={() => {
          setPreviewUrl(null)
          setPreviewRow(null)
        }}
        onApply={(start, end) => {
          if (previewRow !== null) patchRow(previewRow, { start, end })
        }}
        // Отрезок качается с теми же настройками, что выбраны справа.
        options={{ max_height: maxHeight, auto_process_preset: autoPreset || null, ...downloadOptions }}
      />
    </div>
  )
}

function LinkRow({
  number,
  row,
  disabled,
  onChange,
  onPasteMany,
  onRemove,
  onPreview,
  onGallery,
  galleryReady,
  probing,
}: {
  number: number
  row: Row
  disabled: boolean
  onChange: (patch: Partial<Row>) => void
  onPasteMany: (text: string) => boolean
  onRemove: () => void
  onPreview: () => void
  onGallery: () => void
  galleryReady: boolean
  probing: boolean
}) {
  const [editingTime, setEditingTime] = useState(false)

  const hasUrl = Boolean(row.url.trim())
  const hasSection = row.start !== null || row.end !== null
  const icon =
    'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-35'

  // Всё в одну строку: ссылка, отрезок и значки справа. Две строки на ссылку
  // съедали место, а ссылок за раз бывает много. Поля отрезка открываются
  // тут же, сдвигая ссылку, а не новой строкой.
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line-soft bg-surface-2 px-2.5 py-1.5">
      <span className="w-5 shrink-0 text-right text-[12px] font-semibold tabular-nums text-ink-faint">
        {number}
      </span>

      <input
        spellCheck={false}
        value={row.url}
        placeholder="https://…"
        className="field min-w-0 flex-1 py-1 font-mono text-[12px]"
        onChange={(event) => onChange({ url: event.target.value })}
        onPaste={(event) => {
          const text = event.clipboardData.getData('text')
          if (onPasteMany(text)) event.preventDefault()
        }}
      />

      {editingTime && (
        <>
          <TimeField label="с" value={row.start} onChange={(value) => onChange({ start: value })} />
          <TimeField label="по" value={row.end} onChange={(value) => onChange({ end: value })} />
        </>
      )}

      {hasSection && !editingTime && (
        <span className="flex shrink-0 items-center gap-1 rounded-lg bg-accent/15 py-0.5 pl-2 pr-1 font-mono text-[11px] text-accent-soft">
          {timecode(row.start ?? 0, true)} → {row.end !== null ? timecode(row.end, true) : 'конец'}
          <button
            type="button"
            onClick={() => onChange({ start: null, end: null })}
            title="Скачать целиком"
            className="rounded p-0.5 hover:bg-accent/25"
          >
            <X size={11} />
          </button>
        </span>
      )}

      <button
        type="button"
        disabled={!hasUrl || disabled}
        onClick={onPreview}
        title="Предпросмотр с разметкой: открыть видео здесь и выбрать отрезок"
        className={`${icon} text-ink-faint hover:bg-surface-3 hover:text-ink`}
      >
        <Film size={13} />
      </button>
      <button
        type="button"
        onClick={() => setEditingTime((value) => !value)}
        title="Указать тайминги вручную: 1:23 или 83, пусто — от начала или до конца"
        className={`${icon} ${
          editingTime || hasSection
            ? 'bg-accent/15 text-accent-soft hover:bg-accent/25'
            : 'text-ink-faint hover:bg-surface-3 hover:text-ink'
        }`}
      >
        <Scissors size={13} />
      </button>
      {galleryReady && (
        <button
          type="button"
          disabled={!hasUrl || probing}
          onClick={onGallery}
          title="Картинки поста: показать, что в нём есть, и выбрать нужные"
          className={`${icon} text-ink-faint hover:bg-surface-3 hover:text-ink`}
        >
          <Images size={13} />
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        title="Убрать строку"
        className={`${icon} text-ink-faint hover:bg-surface-3 hover:text-danger`}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

function TimeField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number | null
  onChange: (value: number | null) => void
}) {
  const [text, setText] = useState(value === null ? '' : timecode(value, true))

  return (
    <label className="flex shrink-0 items-center gap-1 text-[11px] text-ink-faint">
      {label}
      <input
        className="field w-[72px] py-1 text-center font-mono text-[12px]"
        value={text}
        placeholder="—"
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const parsed = parseTime(text)
          onChange(parsed)
          setText(parsed === null ? '' : timecode(parsed, true))
        }}
      />
    </label>
  )
}
