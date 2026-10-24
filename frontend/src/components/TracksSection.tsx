import type { MediaInfo } from '../lib/types'
import { Choice } from './ComposeRender'
import { Section, Toggle } from './ui'

type AudioTrack = NonNullable<MediaInfo['audioTracks']>[number]
type SubtitleTrack = NonNullable<MediaInfo['subtitleTracks']>[number]

/** Что человек выбрал в разделе. Номера — по счёту среди звуковых и субтитров. */
export interface TrackChoice {
  /** Одна дорожка, когда «несколько» выключено. */
  track: number
  /** Брать несколько звуковых дорожек. */
  multi: boolean
  /** Какие из них — при ``multi``. */
  picked: number[]
  /** Свести выбранные в одну. */
  merge: boolean
  /** Субтитры внутрь файла и отдельными файлами. */
  embed: boolean
  extract: boolean
  /** Какие субтитры, -1 — все. */
  subtitle: number
}

/** Начальный выбор: дорожки «по умолчанию» из самого файла, иначе первые. */
export function initialTracks(media: MediaInfo | null | undefined): TrackChoice {
  const audio = media?.audioTracks ?? []
  const subs = media?.subtitleTracks ?? []
  return {
    track: audio.find((item) => item.default)?.index ?? 0,
    multi: false,
    picked: audio.map((item) => item.index),
    merge: false,
    embed: false,
    extract: false,
    subtitle: subs.find((item) => item.default)?.index ?? 0,
  }
}

/** Языки, которые чаще всего встречаются. Остальные показываем как есть. */
const LANGUAGES: Record<string, string> = {
  rus: 'Русский', ru: 'Русский',
  eng: 'Английский', en: 'Английский',
  jpn: 'Японский', ja: 'Японский',
  ukr: 'Украинский', uk: 'Украинский',
  kor: 'Корейский', ko: 'Корейский',
  chi: 'Китайский', zho: 'Китайский', zh: 'Китайский',
  ger: 'Немецкий', deu: 'Немецкий', de: 'Немецкий',
  fre: 'Французский', fra: 'Французский', fr: 'Французский',
  spa: 'Испанский', es: 'Испанский',
  ita: 'Итальянский', it: 'Итальянский',
  por: 'Португальский', pt: 'Португальский',
}

const CODECS: Record<string, string> = {
  eac3: 'E-AC-3', ac3: 'AC-3', aac: 'AAC', opus: 'Opus', mp3: 'MP3', flac: 'FLAC',
  dts: 'DTS', truehd: 'TrueHD', vorbis: 'Vorbis', pcm_s16le: 'PCM', pcm_s24le: 'PCM',
  subrip: 'SRT', ass: 'ASS', ssa: 'SSA', webvtt: 'VTT', mov_text: 'Текст MP4',
  hdmv_pgs_subtitle: 'PGS', dvd_subtitle: 'DVD',
}

/** Названия дорожек, которые просто повторяют язык. */
const SAME_AS_LANGUAGE = new Set([
  ...Object.values(LANGUAGES).map((name) => name.toLowerCase()),
  'english', 'japanese', 'russian', 'ukrainian', 'korean', 'chinese', 'german',
  'french', 'spanish', 'italian', 'portuguese',
])

function language(code: string | null): string | null {
  if (!code || code === 'und') return null
  return LANGUAGES[code] ?? code
}

/**
 * Подпись звуковой дорожки: «5. Русский · E-AC-3 · 5.1». Номер — сама
 * дорожка, а не «5 из 7»: так было непонятно, возьмутся пять дорожек или
 * одна пятая.
 */
export function audioLabel(track: AudioTrack): string {
  const parts: string[] = []
  const name = language(track.language)
  if (name) parts.push(name)
  // Название часто повторяет язык («Japanese») — тогда оно лишнее.
  if (track.title && !SAME_AS_LANGUAGE.has(track.title.trim().toLowerCase())) parts.push(track.title)
  if (track.codec) parts.push(CODECS[track.codec] ?? track.codec.toUpperCase())
  const channels = track.channels
  if (channels === 1) parts.push('моно')
  else if (channels === 2) parts.push('стерео')
  else if (channels === 6) parts.push('5.1')
  else if (channels === 8) parts.push('7.1')
  else if (channels) parts.push(`${channels} кан.`)
  return `${track.index + 1}. ${parts.join(' · ') || 'Дорожка'}`
}

/** Подпись субтитров: «1. Русский · Russian | Full | Netflix · SRT». */
export function subtitleLabel(track: SubtitleTrack): string {
  const parts: string[] = []
  const name = language(track.language)
  if (name) parts.push(name)
  if (track.title) parts.push(track.title)
  if (track.codec) parts.push(CODECS[track.codec] ?? track.codec.toUpperCase())
  return `${track.index + 1}. ${parts.join(' · ') || 'Субтитры'}`
}

/**
 * Раздел «Дорожки и субтитры»: какие звуковые дорожки взять, свести ли их в
 * одну и что сделать с субтитрами. Виден, только когда выбирать есть из чего.
 */
export function TracksSection({
  media,
  value,
  onChange,
  streamCopy,
  container,
}: {
  media: MediaInfo | null | undefined
  value: TrackChoice
  onChange: (value: TrackChoice) => void
  /** «Без сжатия»: звук копируется как есть, свести его нельзя. */
  streamCopy: boolean
  /** Контейнер результата — от него зависит, какие субтитры в него влезут. */
  container: string
}) {
  const audio = media?.audioTracks ?? []
  const subs = media?.subtitleTracks ?? []
  if (audio.length < 2 && subs.length === 0) return null

  const set = (patch: Partial<TrackChoice>) => onChange({ ...value, ...patch })
  const picked = value.multi ? value.picked : [value.track]
  const chosenSubs = value.subtitle < 0 ? subs : subs.filter((item) => item.index === value.subtitle)
  const lostSubs = value.embed && container !== 'mkv' && chosenSubs.some((item) => item.bitmap)

  const summary = [
    audio.length > 1 && (value.multi ? `звук: ${picked.length}${value.merge ? ' в одну' : ''}` : `звук ${value.track + 1}`),
    value.embed && 'субтитры внутри',
    value.extract && 'субтитры файлом',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Section title="Дорожки и субтитры" id="export.tracks" summary={summary}>
      {audio.length > 1 && (
        <div className="space-y-1 rounded-xl bg-surface-2 px-3 py-2.5">
          <Toggle
            checked={value.multi}
            onChange={(multi) => set({ multi })}
            label="Несколько звуковых дорожек"
            hint="Положить в готовый файл не одну дорожку, а несколько — например, оригинал и озвучку. Какие именно — отметьте ниже."
          />
          {value.multi ? (
            <>
              <div className="ml-1 space-y-0.5 border-l border-line-soft pl-2">
                {audio.map((track) => (
                  <Toggle
                    key={track.index}
                    checked={value.picked.includes(track.index)}
                    onChange={(on) =>
                      set({
                        picked: on
                          ? [...value.picked, track.index].sort((a, b) => a - b)
                          : value.picked.filter((item) => item !== track.index),
                      })
                    }
                    label={audioLabel(track)}
                  />
                ))}
              </div>
              <Toggle
                checked={value.merge && !streamCopy}
                onChange={(merge) => set({ merge })}
                disabled={streamCopy || value.picked.length < 2}
                label="Свести в одну дорожку"
                hint={
                  streamCopy
                    ? 'В режиме без сжатия звук копируется как есть — свести дорожки можно только с пересжатием.'
                    : 'Выбранные дорожки смешаются в одну: голос, музыка и шумы, записанные раздельно, станут одним звуком. Монтажные программы тогда кладут одну звуковую дорожку, а не несколько.'
                }
              />
            </>
          ) : (
            <Choice
              label="Звуковая дорожка"
              hint="Какую дорожку взять в готовый файл. Сначала стоит та, что отмечена в самом файле как основная."
              value={String(value.track)}
              options={audio.map((track) => ({ value: String(track.index), label: audioLabel(track) }))}
              onChange={(track) => set({ track: Number(track) })}
            />
          )}
        </div>
      )}

      {subs.length > 0 && (
        <div className="space-y-1 rounded-xl bg-surface-2 px-3 py-2.5">
          <Toggle
            checked={value.embed}
            onChange={(embed) => set({ embed })}
            label="Вшить субтитры"
            hint="Субтитры лягут в файл отдельной дорожкой — плеер включает и выключает их сам, картинка не меняется. В MP4 у субтитров ASS пропадёт оформление (шрифты, цвета) — для них выберите контейнер MKV."
          />
          <Toggle
            checked={value.extract}
            onChange={(extract) => set({ extract })}
            label="Субтитры отдельным файлом"
            hint="Субтитры сохранятся рядом отдельным файлом: «Серия.rus.srt». С пресетом «Без сжатия» и без отрезка появятся только субтитры — копия видео рядом не нужна."
          />
          {(value.embed || value.extract) && (
            <Choice
              label="Какие субтитры"
              value={String(value.subtitle)}
              options={[
                ...subs.map((track) => ({ value: String(track.index), label: subtitleLabel(track) })),
                { value: '-1', label: 'Все' },
              ]}
              onChange={(subtitle) => set({ subtitle: Number(subtitle) })}
            />
          )}
          {lostSubs && (
            <p className="px-1 text-[11px] leading-snug text-warn">
              Субтитры картинками (PGS, DVD) в {container.toUpperCase()} не кладутся — внутрь они попадут
              только в MKV. Отдельным файлом их сохранить можно.
            </p>
          )}
        </div>
      )}
    </Section>
  )
}
