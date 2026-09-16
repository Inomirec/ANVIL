import { useEffect, useState } from 'react'
import { FolderOpen, Save, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { useCompose } from '../composeStore'
import { useStore } from '../store'
import { Button, Modal, Spinner } from './ui'

/**
 * Сохранённые монтажи.
 *
 * Монтаж и так запоминается сам, но помнит программа только последний: стоит
 * начать второй — первый пропал. Поэтому монтажи можно сохранять под именем и
 * открывать обратно.
 *
 * Папку человек не выбирает: файлы лежат внутри программы, рядом с
 * настройками, и вся работа с ними — назвать и открыть. Путь к папке всё же
 * показан внизу окна, чтобы их можно было найти и скопировать себе.
 */
interface Saved {
  name: string
  savedAt: number
  clips: number
}

export function ComposeProjects({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useStore((state) => state.toast)
  const snapshot = useCompose((state) => state.snapshot)
  const loadProject = useCompose((state) => state.loadProject)

  const [list, setList] = useState<Saved[] | null>(null)
  const [folder, setFolder] = useState('')
  const [name, setName] = useState('Монтаж')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  async function refresh() {
    try {
      const data = await api.composeProjects()
      setList(data.projects)
      setFolder(data.folder)
    } catch (error) {
      toast((error as Error).message, 'error')
      setList([])
    }
  }

  async function saveAs(underName: string) {
    const clean = underName.trim()
    if (!clean) return
    // Перезапись — потеря чужой работы, поэтому спрашиваем.
    const exists = list?.some((item) => item.name === clean)
    if (exists && !window.confirm(`Монтаж «${clean}» уже есть. Записать поверх?`)) return
    setBusy(true)
    try {
      await api.composeProjectSave(clean, snapshot())
      toast(`Монтаж сохранён как «${clean}»`, 'ok')
      await refresh()
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function openSaved(underName: string) {
    setBusy(true)
    try {
      const data = await api.composeProjectOpen(underName)
      loadProject(data.project)
      toast(`Открыт монтаж «${underName}»`, 'ok')
      onClose()
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function remove(underName: string) {
    if (!window.confirm(`Убрать монтаж «${underName}»? Файл уйдёт в корзину.`)) return
    try {
      await api.composeProjectRemove(underName)
      await refresh()
    } catch (error) {
      toast((error as Error).message, 'error')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Мои монтажи">
      <div className="space-y-4">
        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="label">Сохранить нынешний монтаж как</span>
            <input
              className="field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void saveAs(name)}
              placeholder="Монтаж"
            />
          </label>
          <Button onClick={() => void saveAs(name)} disabled={busy || !name.trim()}>
            <Save size={14} />
            Сохранить
          </Button>
        </div>

        <div className="border-t border-line-soft pt-3">
          <span className="label">Сохранённые</span>
          {list === null ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : !list.length ? (
            <p className="py-4 text-center text-[12px] text-ink-faint">
              Пока ничего не сохранено. Соберите монтаж и запишите его под именем — потом
              можно будет вернуться и продолжить.
            </p>
          ) : (
            <ul className="space-y-1">
              {list.map((item) => (
                <li
                  key={item.name}
                  className="flex items-center gap-2 rounded-lg border border-line-soft px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px]">{item.name}</p>
                    <p className="text-[11px] text-ink-faint">
                      {item.clips} {clipWord(item.clips)} · {when(item.savedAt)}
                    </p>
                  </div>
                  <Button
                    tone="ghost"
                    onClick={() => void openSaved(item.name)}
                    disabled={busy}
                  >
                    <FolderOpen size={14} />
                    Открыть
                  </Button>
                  <button
                    type="button"
                    title="Убрать из списка — файл уйдёт в корзину"
                    onClick={() => void remove(item.name)}
                    className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-3 hover:text-danger"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {folder && (
          <p className="truncate text-[11px] text-ink-faint" title={folder}>
            Файлы монтажей лежат здесь: {folder}
          </p>
        )}
      </div>
    </Modal>
  )
}

function clipWord(count: number): string {
  const last = count % 10
  const two = count % 100
  if (two >= 11 && two <= 14) return 'клипов'
  if (last === 1) return 'клип'
  if (last >= 2 && last <= 4) return 'клипа'
  return 'клипов'
}

/** «Сегодня в 14:02» понятнее полной даты: монтажи открывают недавние. */
function when(stamp: number): string {
  const at = new Date(stamp * 1000)
  const time = at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const today = new Date()
  const sameDay =
    at.getDate() === today.getDate() &&
    at.getMonth() === today.getMonth() &&
    at.getFullYear() === today.getFullYear()
  if (sameDay) return `сегодня в ${time}`
  return `${at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} в ${time}`
}
