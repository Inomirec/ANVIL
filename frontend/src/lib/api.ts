import type {
  AppSettings,
  BrowseResponse,
  FileInfo,
  GalleryItem,
  Job,
  LibraryResponse,
  Preset,
  FilmstripInfo,
  SceneInfo,
  ResolvedLink,
  SystemStatus,
  Waveform,
} from './types'

/** Ошибка запроса с человекочитаемым текстом от бэкенда. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    let detail = `Ошибка ${response.status}`
    try {
      const body = await response.json()
      detail = body?.detail ?? detail
      if (Array.isArray(detail)) {
        // Pydantic отдаёт список ошибок валидации — склеиваем в одну строку.
        detail = detail.map((item: any) => item?.msg ?? String(item)).join('; ')
      }
    } catch {
      /* тело может быть пустым — оставляем код статуса */
    }
    throw new ApiError(String(detail), response.status)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const api = {
  status: (refresh = false) => request<SystemStatus>(`/api/status?refresh=${refresh}`),
  windowState: () => request<{ custom: boolean; maximized: boolean }>('/api/window/state'),
  windowAction: (action: 'drag' | 'resize-top' | 'minimize' | 'maximize' | 'close') =>
    post<{ done: boolean }>(`/api/window/${action}`),
  presets: () => request<Record<string, Preset[]>>('/api/presets'),
  updateTool: (tool: string) =>
    post<{ ok: boolean; output: string; version: string | null }>(`/api/tools/${tool}/update`),
  installFfmpeg: () => post<Job>('/api/tools/ffmpeg/install'),
  clearThumbnails: () => post<{ removed: number }>('/api/cache/thumbnails/clear'),
  toolUpdates: (refresh = false) =>
    request<Record<string, { current: string | null; latest: string | null; state: string }>>(
      `/api/tools/updates?refresh=${refresh}`,
    ),

  settings: () => request<AppSettings>('/api/settings'),
  patchSettings: (patch: Record<string, unknown>) =>
    request<AppSettings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  uploadCookies: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return fetch('/api/settings/cookies', { method: 'POST', body: form }).then(async (response) => {
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error((data && data.detail) || `Ошибка ${response.status}`)
      return data as {
        ok: boolean
        path: string
        size: number
        // Годится ли файл для YouTube: он смотрит на свою метку входа.
        youtube?: 'ok' | 'no-login' | 'absent'
      }
    })
  },
  openLink: (name: string) => post<{ ok: boolean; url: string }>('/api/settings/open-link', { path: name }),
  clearCookies: () => post<{ ok: boolean }>('/api/settings/cookies/clear'),
  /** Спрашивает у YouTube, принимает ли он подключённые куки. */
  checkCookies: () =>
    post<{ state: 'ok' | 'rejected' | 'none' | 'broken' | 'network' | 'unknown'; message: string }>(
      '/api/settings/cookies/check',
    ),

  /** Папка это или файл — для путей, пришедших извне (перетащили в окно). */
  pathKind: (path: string) =>
    request<{ kind: 'file' | 'folder' | 'missing'; path: string }>(
      `/api/library/kind?path=${encodeURIComponent(path)}`,
    ),

  addWorkspace: (path: string) => post<AppSettings>('/api/settings/workspaces/add', { path }),
  removeWorkspace: (path: string) => post<AppSettings>('/api/settings/workspaces/remove', { path }),
  browse: (path?: string | null) =>
    request<BrowseResponse>(`/api/settings/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  pickFolder: () => post<{ supported: boolean; path: string | null }>('/api/settings/pick-folder'),
  /** Окно Windows для выбора файла — открывается в папке ``directory``. */
  pickFile: (directory?: string | null) =>
    post<{ supported: boolean; path: string | null }>('/api/settings/pick-file', { directory }),
  /** Готова ли ровная копия ролика после стабилизатора. */
  stabilizeStatus: (source: string, params: Record<string, number | string>) =>
    post<{ state: 'ready' | 'working' | 'error' | 'idle' | 'missing'; progress?: number; error?: string }>(
      '/api/compose/stabilize',
      { source, params },
    ),
  /** Какие файлы монтажа пропали и какие лежат вне рабочих папок. */
  composeCheck: (sources: string[]) =>
    post<{ missing: string[]; outside: string[] }>('/api/compose/check', { sources }),
  /** Ищет пропавшие файлы в папке, где нашёлся один из них. */
  composeFindNear: (folder: string, sources: string[]) =>
    post<{ found: Record<string, string> }>('/api/compose/find-near', { folder, sources }),
  reveal: (path: string) => post<{ ok: boolean }>('/api/settings/reveal', { path }),

  library: (params: { root?: string; kind?: string; search?: string; recursive?: boolean }) => {
    const query = new URLSearchParams()
    if (params.root) query.set('root', params.root)
    if (params.kind) query.set('kind', params.kind)
    if (params.search) query.set('search', params.search)
    if (params.recursive === false) query.set('recursive', 'false')
    return request<LibraryResponse>(`/api/library?${query.toString()}`)
  },
  /** Какие из картинок движутся — по заголовкам файлов, без ffprobe. */
  movingImages: (paths: string[]) => post<{ moving: string[] }>('/api/library/moving', { paths }),
  fileInfo: (path: string) => request<FileInfo>(`/api/library/info?path=${encodeURIComponent(path)}`),
  waveform: (path: string, buckets?: number) =>
    request<Waveform>(
      `/api/library/waveform?path=${encodeURIComponent(path)}` +
        (buckets ? `&buckets=${Math.round(buckets)}` : ''),
    ),
  filmstrip: (path: string) =>
    request<FilmstripInfo>(`/api/library/filmstrip?path=${encodeURIComponent(path)}`),
  scenes: (path: string, large = false) =>
    request<SceneInfo>(`/api/library/scenes?path=${encodeURIComponent(path)}${large ? '&large=1' : ''}`),
  deleteFile: (path: string) => post<{ ok: boolean }>('/api/library/delete', { path }),
  renameFile: (path: string, newName: string) =>
    post<{ ok: boolean; path: string }>('/api/library/rename', { path, new_name: newName }),

  /** Запускает подбор числа одновременных задач. Возвращает задачу очереди. */
  benchmark: () => post<Job>('/api/benchmark'),

  /** Применяет число одновременных задач к очередям без перезапуска. */
  applyPools: () => post<{ pools: Record<string, number> }>('/api/pools'),

  jobs: () => request<{ jobs: Job[]; active: number }>('/api/jobs'),
  job: (id: string) => request<Job>(`/api/jobs/${id}`),
  cancelJob: (id: string) => post<{ ok: boolean }>(`/api/jobs/${id}/cancel`),
  clearJobs: () => post<{ removed: number }>('/api/jobs/clear'),

  export: (payload: unknown) => post<Job>('/api/export', payload),
  exportFrame: (payload: unknown) => post<Job>('/api/export/frame', payload),
  exportRaw: (command: string, source?: string) =>
    post<Job>('/api/export/raw', { command, source }),
  exportBatch: (items: unknown[]) =>
    post<{ jobs: Job[]; errors: { source: string; error: string }[] }>('/api/export/batch', { items }),
  imagePreview: (payload: unknown) =>
    post<{ url: string; size: number; width: number; height: number }>(
      '/api/media/image-preview',
      payload,
    ),

  /** Кадр монтажа под иглой. Приходит картинкой, а не ссылкой. */
  composeFrame: async (payload: unknown, signal?: AbortSignal): Promise<{ blob: Blob; missing: string[] }> => {
    const response = await fetch('/api/compose/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
    if (!response.ok) {
      let detail = `Ошибка ${response.status}`
      try {
        detail = (await response.json())?.detail ?? detail
      } catch {
        /* тело может быть пустым */
      }
      throw new ApiError(String(detail), response.status)
    }
    // Сервер сообщает, какие файлы монтажа пропали: кадр собран без них.
    let missing: string[] = []
    try {
      missing = JSON.parse(decodeURIComponent(response.headers.get('X-Sgh-Missing') ?? '[]'))
    } catch {
      /* заголовка может не быть */
    }
    return { blob: await response.blob(), missing }
  },
  composeBuild: (payload: unknown) => post<Job>('/api/compose/build', payload),
  /** Какой файл шрифта возьмёт сборка и его шаг строк — для живой надписи. */
  fontFace: (name: string, bold: boolean, italic: boolean) =>
    request<{ key: string; url: string; lineHeight: number }>(
      `/api/compose/fonts/face?${new URLSearchParams({
        name,
        bold: String(bold),
        italic: String(italic),
      })}`,
    ),

  /** Шрифты, установленные в системе: для надписей в монтаже. */
  fonts: () =>
    request<{ fonts: { name: string; bold: boolean; italic: boolean }[] }>('/api/compose/fonts'),

  /** Снимок кадра монтажа — уходит в очередь, как «Сохранить кадр». */
  composeSnapshot: (payload: unknown) => post<Job>('/api/compose/snapshot', payload),

  /** Сохранённые монтажи: список, сохранение, открытие и удаление. */
  composeProjects: () =>
    request<{ folder: string; projects: { name: string; savedAt: number; clips: number }[] }>(
      '/api/compose/projects',
    ),
  composeProjectSave: (name: string, project: unknown) =>
    post<{ name: string; path: string }>('/api/compose/projects', { name, project }),
  composeProjectOpen: (name: string) =>
    request<{ name: string; project: unknown }>(
      `/api/compose/projects/${encodeURIComponent(name)}`,
    ),
  /** Свои наборы настроек сборки: лежат рядом с настройками программы. */
  composeRenderPresets: () =>
    request<{ presets: import('../components/ComposeRender').RenderPreset[] }>(
      '/api/compose/render-presets',
    ),
  composeRenderPresetsSave: (presets: unknown[]) =>
    request<{ saved: number }>('/api/compose/render-presets', {
      method: 'PUT',
      body: JSON.stringify({ presets }),
    }),
  composeProjectRemove: (name: string) =>
    request<{ ok: boolean }>(`/api/compose/projects/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  /** Кусок монтажа для просмотра: собирается быстрым кодеком и кэшируется. */
  composeDraft: (payload: unknown) =>
    post<{ url: string; at: number; span: number; size: number; missing?: string[] }>(
      '/api/compose/draft',
      payload,
    ),

  exportPreview: (payload: unknown) =>
    post<{ summary: string; command: string | null; output?: string }>('/api/export/preview', payload),
  exportPreset: (presetId: string, sources: string[], overrides?: Record<string, unknown>) =>
    post<{ jobs: Job[]; skipped: { source: string; reason: string }[] }>(
      `/api/export/preset/${presetId}`,
      { sources, overrides },
    ),

  download: (payload: unknown) =>
    post<{ jobs: Job[]; errors: { url: string; error: string }[] }>('/api/download', payload),
  probeLink: (url: string) => post<Record<string, any>>('/api/download/probe', { url }),
  resolveLink: (url: string) => post<ResolvedLink>('/api/download/resolve', { url }),
  probeGallery: (url: string) =>
    post<{ url: string; host: string; items: GalleryItem[]; count: number }>('/api/download/gallery', {
      url,
    }),
}

/** URL для тега <video>/<audio>/<img>. */
export const mediaUrl = (path: string) => `/api/media/raw?path=${encodeURIComponent(path)}`

/** URL миниатюры файла. */
export const thumbUrl = (path: string) => `/api/library/thumbnail?path=${encodeURIComponent(path)}`
