import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, CheckCircle2, Gauge, RefreshCw, XCircle } from 'lucide-react'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import type { ToolInfo } from '../lib/types'
import { useStore } from '../store'
import { Button, Modal, NumberField, QuietHints, Section, Segmented, Select, Spinner, Toggle } from './ui'

/** Инструменты, которые протухают и требуют обновления. */
const UPDATABLE = new Set(['yt-dlp', 'gallery-dl'])

type UpdateInfo = { current: string | null; latest: string | null; state: string }

/** Столбик замеров: сколько заняла пробная пачка при каждом значении. */
function MeasuredTable({
  title,
  rows,
  best,
  count,
  forms,
}: {
  title: string
  rows: { level: number; seconds: number }[]
  best: number
  count: number
  forms: [string, string, string]
}) {
  if (!rows.length) return null
  const slowest = Math.max(...rows.map((row) => row.seconds))
  return (
    <div>
      <span className="label">{title}</span>
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.level} className="flex items-center gap-2 text-[11px]">
            <span className={`w-14 shrink-0 tabular-nums ${row.level === best ? 'text-ok' : 'text-ink-faint'}`}>
              по {row.level}
            </span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3">
              <span
                className={`block h-full rounded-full ${row.level === best ? 'bg-ok' : 'bg-ink-faint/40'}`}
                style={{ width: `${(row.seconds / slowest) * 100}%` }}
              />
            </span>
            <span className="w-12 shrink-0 text-right tabular-nums text-ink-faint">
              {row.seconds.toFixed(1)} с
            </span>
          </div>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-ink-faint">
        Одна и та же пачка из {count} {plural(count, forms)} при разном числе задач. Чем
        короче полоска, тем быстрее.
      </p>
    </div>
  )
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useStore((state) => state.settings)
  const status = useStore((state) => state.status)
  const toast = useStore((state) => state.toast)
  const refreshSettings = useStore((state) => state.refreshSettings)
  const refreshStatus = useStore((state) => state.refreshStatus)
  const refreshLibrary = useStore((state) => state.refreshLibrary)

  const jobs = useStore((state) => state.jobs)
  const setQueueOpen = useStore((state) => state.setQueueOpen)

  const [benchId, setBenchId] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [updating, setUpdating] = useState<string | null>(null)
  const [versions, setVersions] = useState<Record<string, UpdateInfo>>({})
  const [checking, setChecking] = useState(false)

  // Спрашиваем PyPI только когда окно настроек открыли — не на каждом запуске.
  useEffect(() => {
    if (!open) return
    setChecking(true)
    api
      .toolUpdates()
      .then(setVersions)
      .catch(() => setVersions({}))
      .finally(() => setChecking(false))
  }, [open])

  // Замер идёт обычной задачей очереди, поэтому его состояние приходит
  // оттуда же, что и у остальных, — отдельного опроса не нужно.
  const bench = benchId ? jobs.find((job) => job.id === benchId) : undefined
  const benchRunning = bench?.status === 'queued' || bench?.status === 'running'
  const measured = bench?.status === 'done' ? bench.meta : null

  // Очереди получают своё число задач при запуске программы. Если настройку
  // с тех пор поменяли, показываем, чем живёт очередь сейчас, и предлагаем
  // применить — перезапускать программу ради этого не нужно.
  const pools = status?.pools
  const pending =
    Boolean(pools) &&
    (pools!.encode !== settings?.export.concurrency ||
      pools!.image !== settings?.export.image_concurrency)

  if (!settings) return null

  async function applyPools() {
    setApplying(true)
    try {
      await api.applyPools()
      await refreshStatus()
      toast('Настройки применены — перезапускать программу не нужно', 'ok')
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setApplying(false)
    }
  }

  async function measure() {
    try {
      const job = await api.benchmark()
      setBenchId(job.id)
      setQueueOpen(true)
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }

  async function applyMeasured() {
    if (!measured) return
    await patch({
      export: {
        concurrency: measured.videoBest,
        image_concurrency: measured.imageBest,
      },
    })
    setBenchId(null)
    await applyPools()
  }

  // Приписку применяем, когда поле оставили: на каждую букву переписывать
  // настройки незачем.
  const [suffixDraft, setSuffixDraft] = useState<string | null>(null)

  async function patch(value: Record<string, unknown>) {
    try {
      await api.patchSettings(value)
      await refreshSettings()
      void refreshLibrary()
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }

  /** Перепроверяет инструменты и версии, а результат озвучивает. */
  async function recheck() {
    setChecking(true)
    try {
      await refreshStatus()
      const fresh = await api.toolUpdates(true)
      setVersions(fresh)

      const outdated = Object.entries(fresh)
        .filter(([, info]) => info.state === 'outdated')
        .map(([name]) => name)
      if (outdated.length) {
        toast(`Есть обновление: ${outdated.join(', ')}`, 'info')
      } else {
        toast('Все инструменты на месте и актуальны', 'ok')
      }
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setChecking(false)
    }
  }

  async function upgrade(tool: string) {
    setUpdating(tool)
    try {
      const result = await api.updateTool(tool)
      toast(
        result.ok ? `${tool} обновлён до ${result.version}` : 'Обновление не удалось',
        result.ok ? 'ok' : 'error',
      )
      await refreshStatus()
      setVersions(await api.toolUpdates(true))
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setUpdating(null)
    }
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title="Настройки" wide>
        <div className="grid gap-7 md:grid-cols-2">
          <div className="space-y-7">
            <Section title="Инструменты">
              <div className="space-y-1.5">
                {/* Только то, что обновлять нужно: загрузчики ломаются вместе
                    с сайтами. ffmpeg и Deno от сайтов не зависят — их видно,
                    только если с ними беда. */}
                {Object.entries(status?.tools ?? {})
                  .filter(([name, tool]) => UPDATABLE.has(name) || !tool.available)
                  .map(([name, tool]) => (
                  <ToolRow
                    key={name}
                    tool={tool}
                    update={versions[name]}
                    checking={checking && UPDATABLE.has(name)}
                    updating={updating === name}
                    onUpdate={UPDATABLE.has(name) ? () => void upgrade(name) : undefined}
                  />
                ))}
              </div>
              <Button onClick={() => void recheck()} disabled={checking} className="w-full">
                {checking ? <Spinner size={13} /> : <RefreshCw size={13} />}
                Проверить обновления
              </Button>
            </Section>

            <Section title="Обработка">
              <NumberField
                label="Видео одновременно"
                value={settings.export.concurrency}
                min={1}
                max={8}
                suffix="шт."
                onChange={(value) => void patch({ export: { concurrency: value } })}
                hint="Кодирование видео занимает процессор целиком, поэтому больше одного за раз помогает не всем."
              />
              <NumberField
                label="Картинок одновременно"
                value={settings.export.image_concurrency}
                min={1}
                max={16}
                suffix="шт."
                onChange={(value) => void patch({ export: { image_concurrency: value } })}
                hint="Картинка маленькая, и на хорошем процессоре их идёт много. Подберите под свой компьютер."
              />

              {pending && (
                <div className="space-y-2 rounded-xl bg-warn/10 px-3 py-2.5 ring-1 ring-warn/25">
                  <p className="text-[11.5px] leading-snug text-warn">
                    Очередь пока работает по-старому: видео по {pools?.encode}, картинки по{' '}
                    {pools?.image}. Новые числа начнут действовать, когда вы их примените.
                  </p>
                  <Button
                    tone="primary"
                    onClick={() => void applyPools()}
                    disabled={applying}
                    className="w-full"
                  >
                    {applying ? <Spinner size={13} /> : <Check size={13} />}
                    Применить настройку
                  </Button>
                  <p className="text-[11px] leading-snug text-ink-faint">
                    Файлы, которые уже обрабатываются, спокойно дойдут до конца — новое
                    число подхватят следующие.
                  </p>
                </div>
              )}

              <div className="space-y-2 rounded-xl bg-surface-2 px-3 py-2.5">
                <Button
                  onClick={() => void measure()}
                  disabled={benchRunning}
                  className="w-full"
                >
                  {benchRunning ? <Spinner size={13} /> : <Gauge size={13} />}
                  {benchRunning ? 'Идёт замер…' : 'Подобрать под мой компьютер'}
                </Button>

                {benchRunning && (
                  <p className="text-[11px] leading-snug text-ink-faint">
                    {bench?.message || 'Запускаю'} · {Math.round((bench?.progress ?? 0) * 100)}%
                    <br />
                    Займёт около минуты. Программа прогонит пробную пачку при разном числе
                    задач и выберет, где прирост заканчивается.
                  </p>
                )}

                {bench?.status === 'error' && (
                  <p className="text-[11px] leading-snug text-danger">
                    Замер не удался: {bench.error}
                  </p>
                )}

                {measured && (
                  <div className="space-y-2">
                    <MeasuredTable
                      title="Видео"
                      rows={measured.video ?? []}
                      best={measured.videoBest}
                      count={measured.clips ?? 4}
                      forms={['ролик', 'ролика', 'роликов']}
                    />
                    <MeasuredTable
                      title="Картинки"
                      rows={measured.image ?? []}
                      best={measured.imageBest}
                      count={measured.images ?? 12}
                      forms={['картинка', 'картинки', 'картинок']}
                    />
                    <p className="text-[11px] leading-snug text-ink-faint">
                      Выбрано не самое быстрое число, а самое маленькое из тех, что почти не
                      уступают: разница в пару процентов не стоит того, чтобы занимать
                      компьютер сильнее.
                    </p>
                    <div className="flex gap-2">
                      <Button tone="primary" onClick={() => void applyMeasured()} className="flex-1">
                        Поставить {measured.videoBest} и {measured.imageBest}
                      </Button>
                      <Button onClick={() => setBenchId(null)}>Не менять</Button>
                    </div>
                  </div>
                )}

                {!benchRunning && !measured && bench?.status !== 'error' && (
                  <p className="text-[11px] leading-snug text-ink-faint">
                    Программа сама прогонит пробную пачку и подберёт числа под ваш
                    процессор. Занимает около минуты; очередь при этом должна быть пуста.
                  </p>
                )}
              </div>
            </Section>
          </div>

          <div className="space-y-7">
            <Section title="Загрузка">
              <CookiesField />

              <QuietHints>
                <Toggle
                  checked={settings.download.proxy_enabled}
                  onChange={(value) => void patch({ download: { proxy_enabled: value } })}
                  label="Качать через прокси"
                  hint="Адрес сохраняется, даже когда переключатель выключен — стирать его не нужно."
                />
              </QuietHints>
              <input
                className="field font-mono text-[12px]"
                value={settings.download.proxy ?? ''}
                placeholder="Пример: socks5://127.0.0.1:1080"
                disabled={!settings.download.proxy_enabled}
                onChange={(event) => void patch({ download: { proxy: event.target.value || null } })}
              />
            </Section>

            <Section title="Название создаваемой подпапки">
              <input
                className="field font-mono text-[12px]"
                value={settings.export.output_folder}
                onChange={(event) => void patch({ export: { output_folder: event.target.value } })}
              />
            </Section>

            {/* Пусто — по пресету: «_баланс», «_avif» и т. п. Заданная
                приписка одна на всё: видео, звук и картинки. */}
            <Section title="Приписка для обработанных файлов">
              <input
                className="field font-mono text-[12px]"
                value={suffixDraft ?? settings.export.file_suffix ?? ''}
                placeholder="По пресету: _баланс, _avif, _jpg…"
                onChange={(event) => setSuffixDraft(event.target.value)}
                onBlur={() => {
                  if (suffixDraft === null) return
                  void patch({ export: { file_suffix: suffixDraft } })
                  setSuffixDraft(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
                }}
              />
            </Section>

            <Section title="Доп настройки">
              <Toggle
                checked={settings.hints ?? true}
                onChange={(value) => void patch({ hints: value })}
                label="Подсказки"
                hint="Включает или отключает отображение всплывающих подсказок при наведении на объект интерфейса."
              />
            </Section>

          </div>
        </div>
      </Modal>

    </>
  )
}

function ToolRow({
  tool,
  update,
  checking,
  updating,
  onUpdate,
}: {
  tool: ToolInfo
  update?: UpdateInfo
  checking: boolean
  updating: boolean
  onUpdate?: () => void
}) {
  const outdated = update?.state === 'outdated'

  let note: string
  if (!tool.available) note = tool.error ?? 'не найден'
  else if (!onUpdate) note = tool.version ?? ''
  else if (checking) note = `${tool.version} · проверяю свежесть…`
  else if (outdated) note = `${tool.version} → доступна ${update?.latest}`
  else if (update?.state === 'current') note = `${tool.version} · актуальная версия`
  else note = tool.version ?? ''

  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2">
      {tool.available ? (
        <CheckCircle2 size={14} className={`shrink-0 ${outdated ? 'text-warn' : 'text-ok'}`} />
      ) : (
        <XCircle size={14} className="shrink-0 text-danger" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] font-medium">{tool.name}</p>
        <p
          className={`truncate text-[10.5px] ${outdated ? 'text-warn' : 'text-ink-faint'}`}
          title={tool.path ?? tool.error ?? ''}
        >
          {note}
        </p>
      </div>
      {/* Кнопка появляется только когда обновляться действительно есть куда. */}
      {onUpdate && (outdated || !tool.available) && (
        <button
          type="button"
          onClick={onUpdate}
          disabled={updating}
          className="shrink-0 rounded-lg bg-accent/20 px-2 py-1 text-[11px] text-accent-soft hover:bg-accent/30 disabled:opacity-40"
        >
          {updating ? <Spinner size={11} /> : 'Обновить'}
        </button>
      )}
    </div>
  )
}


/**
 * Доступ к сайтам, которые не отдают файлы кому попало.
 *
 * Слово «куки» человеку знакомо только по всплывашкам «сайт использует
 * cookie», поэтому объясняем не термин, а причину: сайты научились отличать
 * браузер от программы и требуют доказательства, что запрос от вошедшего
 * пользователя. Способа два — прочитать Firefox или взять файл, и они
 * разведены переключателем, а не свалены в один список.
 */
function CookiesField() {
  const settings = useStore((state) => state.settings)
  const refreshSettings = useStore((state) => state.refreshSettings)
  const toast = useStore((state) => state.toast)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Что ответил сам YouTube на проверку. Разбор файла говорит лишь о том, что
  // в нём лежит; действителен ли вход, знает только сайт. Состояние объявлено
  // до выхода по пустым настройкам: хуки нельзя прятать за условием.
  const [checked, setChecked] = useState<{ state: string; message: string } | null>(null)
  const [checking, setChecking] = useState(false)

  async function check() {
    setChecking(true)
    setChecked(null)
    try {
      setChecked(await api.checkCookies())
    } catch (error) {
      setChecked({ state: 'unknown', message: (error as Error).message })
    } finally {
      setChecking(false)
    }
  }

  if (!settings) return null
  const file = settings.download.cookies_file
  // «Годится» — это не «файл есть»: YouTube смотрит на свою метку входа, а
  // его собственный ответ на проверку важнее любого разбора файла.
  const youtubeReady = checked
    ? checked.state === 'ok'
    : settings.cookiesYoutube === 'ok'
  const browser = settings.download.cookies_from_browser
  const mode: 'off' | 'firefox' | 'file' = file ? 'file' : browser ? 'firefox' : 'off'

  async function choose(next: 'off' | 'firefox' | 'file') {
    setChecked(null)
    if (next === 'file') {
      inputRef.current?.click()
      return
    }
    setBusy(true)
    try {
      if (file) await api.clearCookies()
      await api.patchSettings({
        download: { cookies_from_browser: next === 'firefox' ? 'firefox' : null },
      })
      await refreshSettings()
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function upload(chosen: File) {
    setBusy(true)
    // Ответ на прежний файл к новому отношения не имеет: он висел и после
    // замены кук, и выходило, что программа ругается на то, чего уже нет.
    setChecked(null)
    try {
      const result = await api.uploadCookies(chosen)
      await refreshSettings()
      toast(`Файл принят (${Math.round(result.size / 1024)} КБ)`, 'ok')
      // Меняют куки ровно затем, чтобы вход заработал, — значит и спросить
      // YouTube надо сразу, не дожидаясь неудачной загрузки.
      void check()
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div>
      <p className="mb-3 text-[11px] leading-snug text-ink-faint">
        YouTube очень внимательно следит за тем, чтобы видео с их платформы никто
        не мог скачать. Все подозрительные запросы тут же отклоняются. Чтобы
        обойти систему защиты, программе необходимо притвориться пользователем.
        Здесь-то и пригодятся cookies.
      </p>

      <span className="label">Откуда программе брать cookies?</span>
      {/* Переключение убирает загруженный файл — так задумано, чтобы не
          гадать, какой из двух способов сработал. Об этом — в подсказке. */}
      <Segmented<'off' | 'firefox' | 'file'>
        value={mode}
        onChange={(value) => void choose(value)}
        options={[
          { value: 'off', label: 'Без них', title: 'Пока всё качается — можно не трогать' },
          {
            value: 'firefox',
            label: 'Firefox',
            title: 'Программа сама прочитает ваш Firefox. Загруженный файл при этом убирается из программы',
          },
          {
            value: 'file',
            label: 'Файл',
            title: 'Подходит любому браузеру. Выбор другого способа потом уберёт файл из программы — ваш исходный файл останется на месте',
          },
        ]}
      />

      {mode === 'file' && (
        <>
          <div
            className={`mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-ink-dim ring-1 ${
              youtubeReady ? 'bg-ok/10 ring-ok/25' : 'bg-warn/10 ring-warn/30'
            }`}
          >
            {youtubeReady ? (
              <CheckCircle2 size={14} className="shrink-0 text-ok" />
            ) : (
              <AlertTriangle size={14} className="shrink-0 text-warn" />
            )}
            <span className="min-w-0 flex-1">
              {settings.cookiesYoutube === 'missing'
                ? 'Файл не найден — выберите его заново'
                : youtubeReady
                  ? 'Файл загружен и используется'
                  : 'Файл загружен, но YouTube его не примет'}
            </span>
            <button
              type="button"
              onClick={() => void check()}
              disabled={busy || checking}
              className="shrink-0 text-ink-faint hover:text-ink disabled:opacity-40"
            >
              {checking ? 'Спрашиваю…' : 'Проверить'}
            </button>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="shrink-0 text-ink-faint hover:text-ink disabled:opacity-40"
            >
              Заменить
            </button>
          </div>
          {/* Ответ самого YouTube. Куки стареют молча: в файле они значатся
              годными ещё год, а вход уже отозван — понять это можно только
              спросив у сайта. */}
          {checked && (
            <p
              className={`mt-1.5 text-[11px] leading-snug ${
                checked.state === 'ok' ? 'text-ok' : 'text-warn'
              }`}
            >
              {checked.message}
            </p>
          )}
          {/* Сказать про это надо здесь и сразу: иначе человек узнаёт о беде
              только когда ролик не скачался, и думает на программу. */}
          {!youtubeReady && !checked && settings.cookiesYoutube !== 'missing' && (
            <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
              В файле нет метки входа в YouTube — по таким кукам он видит гостя.
              Она появляется, только если куки выгружены прямо со страницы
              youtube.com, где выполнен вход: откройте её, проверьте, что вверху
              справа ваш значок, и выгрузите куки заново.
            </p>
          )}
        </>
      )}

      {mode === 'firefox' && (
        <p className="mt-2 text-[11px] leading-snug text-ink-faint">
          Недостаточно лишь скачать браузер. Для корректной работы вы также
          должны быть авторизованы на странице, откуда собираетесь скачивать
          медиафайл. К сожалению, другие браузеры шифруют cookies, так что они
          не подойдут.
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".txt,text/plain"
        className="hidden"
        onChange={(event) => {
          const chosen = event.target.files?.[0]
          if (chosen) void upload(chosen)
        }}
      />

      <details className="mt-2 text-[11px] leading-snug text-ink-faint" open={mode === 'file' && !file}>
        <summary className="cursor-pointer select-none hover:text-ink-dim">
          Как получить файл
        </summary>
        <ol className="mt-1.5 list-decimal space-y-1.5 pl-4">
          <li>
            Установите расширение{' '}
            <button
              type="button"
              onClick={() => void api.openLink('cookies-extension-chrome')}
              className="text-accent-soft underline decoration-dotted underline-offset-2 hover:text-accent"
            >
              Get cookies.txt LOCALLY
            </button>{' '}
            для браузера. Для Firefox есть своя{' '}
            <button
              type="button"
              onClick={() => void api.openLink('cookies-extension-firefox')}
              className="text-accent-soft underline decoration-dotted underline-offset-2 hover:text-accent"
            >
              версия
            </button>
            .
          </li>
          <li>Откройте расширение.</li>
          <li>
            Нажмите <span className="text-ink-dim">«Export All Cookies»</span>.
          </li>
          <li>Скачанный файл скормите программе через кнопку «Файл».</li>
        </ol>
      </details>
    </div>
  )
}
