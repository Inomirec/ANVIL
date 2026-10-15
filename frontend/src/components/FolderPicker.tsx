import { useEffect, useRef, useState } from 'react'
import { ChevronRight, CornerLeftUp, Folder, HardDrive } from 'lucide-react'
import { api } from '../lib/api'
import type { BrowseResponse } from '../lib/types'
import { Button, Modal, Spinner } from './ui'

/**
 * Выбор папки. В окне программы сразу открывается обычное окно выбора папки
 * Windows: промежуточное окно со своим списком папок ничего к нему не
 * добавляло, а нажатий требовало больше. Свой обозреватель остаётся для
 * браузера, где окна Windows нет.
 */
export function FolderPicker({
  open,
  onClose,
  onPick,
  title = 'Выбор папки',
}: {
  open: boolean
  onClose: () => void
  onPick: (path: string) => void
  title?: string
}) {
  const [data, setData] = useState<BrowseResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [manual, setManual] = useState('')
  /** Окна Windows нет (программа открыта в браузере) — показываем своё. */
  const [fallback, setFallback] = useState(false)

  // Ссылки, а не замыкания: ответ окна Windows приходит, когда человек
  // закрыл его, и обработчики к тому времени могли смениться.
  const pickRef = useRef(onPick)
  pickRef.current = onPick
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) {
      setFallback(false)
      return
    }
    let alive = true
    void (async () => {
      try {
        const result = await api.pickFolder()
        if (!alive) return
        if (result.supported) {
          if (result.path) pickRef.current(result.path)
          closeRef.current()
          return
        }
      } catch {
        // Не вышло спросить окно Windows — покажем своё.
      }
      if (!alive) return
      setFallback(true)
      void load(null)
    })()
    return () => {
      alive = false
    }
  }, [open])

  async function load(path: string | null) {
    setLoading(true)
    try {
      const result = await api.browse(path)
      setData(result)
      setManual(result.path ?? '')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open && fallback} onClose={onClose} title={title}>
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            className="field font-mono text-[12px]"
            value={manual}
            placeholder="Или вставьте путь целиком: D:\Паки\Мой пак"
            onChange={(event) => setManual(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && manual.trim()) {
                onPick(manual.trim())
                onClose()
              }
            }}
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {data?.drives.map((drive) => (
            <button
              key={drive}
              type="button"
              onClick={() => void load(drive)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12px] hover:bg-surface-3"
            >
              <HardDrive size={12} className="text-ink-faint" />
              {drive}
            </button>
          ))}
        </div>

        <div className="rounded-xl border border-line-soft bg-surface-2">
          <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-dim">
              {data?.path ?? 'Быстрый доступ'}
            </span>
            {loading && <Spinner size={13} />}
          </div>

          <ul className="max-h-[280px] overflow-y-auto p-1.5">
            {/* «Назад» первой строкой списка — как в обычном проводнике */}
            {data?.parent && (
              <li>
                <button
                  type="button"
                  onClick={() => void load(data.parent)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-surface-3"
                >
                  <CornerLeftUp size={14} className="shrink-0 text-ink-faint" />
                  <span className="text-ink-dim">Назад</span>
                </button>
              </li>
            )}
            {data?.entries.length === 0 && !data?.parent && (
              <li className="px-3 py-6 text-center text-[12px] text-ink-faint">
                Вложенных папок нет
              </li>
            )}
            {data?.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  onDoubleClick={() => void load(entry.path)}
                  onClick={() => void load(entry.path)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-surface-3"
                >
                  <Folder size={14} className="shrink-0 text-accent-soft/70" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <ChevronRight size={13} className="shrink-0 text-ink-faint" />
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex gap-2">
          <Button
            tone="primary"
            className="flex-1"
            disabled={!manual.trim()}
            onClick={() => {
              onPick(manual.trim())
              onClose()
            }}
          >
            Выбрать эту папку
          </Button>
          <Button tone="ghost" onClick={onClose}>
            Отмена
          </Button>
        </div>
      </div>
    </Modal>
  )
}
