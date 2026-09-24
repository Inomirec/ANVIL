import { useState } from 'react'
import { FileQuestion, FolderSearch } from 'lucide-react'
import { useCompose } from '../composeStore'
import { api } from '../lib/api'
import { parentDir } from '../lib/format'
import { useStore } from '../store'
import { Button, Modal } from './ui'

/**
 * Окно пропавших файлов проекта.
 *
 * Проект хранит пути, а файлы переезжают: папку переименовали, диск сменил
 * букву. Прежде это выяснялось ошибкой поверх кадра, которую нельзя было
 * скопировать, и чинить было нечем — разве что бросить файл заново и получить
 * второй клип рядом со сломанным. Теперь при открытии проекта программа
 * перечисляет, чего нет, со старыми путями, и даёт указать новое место: все
 * клипы с этим файлом переедут на него разом. Если в той же папке нашлись и
 * другие пропавшие файлы — предлагает подставить и их.
 *
 * Можно и пропустить: пропавшие клипы помечены на дорожке, остальной монтаж
 * виден и играет, а готовый файл без них не соберётся — об этом скажет рендер.
 */
export function ComposeMissing({ open, onClose }: { open: boolean; onClose: () => void }) {
  const missing = useCompose((state) => state.missing)
  const relink = useCompose((state) => state.relink)
  const toast = useStore((state) => state.toast)
  const refreshSettings = useStore((state) => state.refreshSettings)
  // Нашлись в той же папке, где человек указал один из файлов: старый путь → новый.
  const [near, setNear] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  /** Файл вне рабочих папок программа сама не откроет — добавляем его папку. */
  async function allow(paths: string[]) {
    const check = await api.composeCheck(paths)
    const folders = [...new Set(check.outside.map(parentDir))]
    for (const folder of folders) await api.addWorkspace(folder)
    if (folders.length) await refreshSettings()
  }

  async function locate(source: string) {
    setBusy(true)
    try {
      const picked = await api.pickFile(parentDir(source))
      if (!picked.supported) {
        toast('Окно выбора файла доступно только в окне программы', 'error')
        return
      }
      if (!picked.path) return
      await allow([picked.path])
      relink(source, picked.path)
      // Файлы проекта обычно переезжают вместе: смотрим, нет ли остальных
      // пропавших там же, куда переехал этот.
      const rest = useCompose.getState().missing
      if (rest.length) {
        const answer = await api.composeFindNear(parentDir(picked.path), rest)
        setNear(answer.found)
      } else {
        toast('Все файлы проекта на месте', 'ok')
        onClose()
      }
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  async function takeNear() {
    setBusy(true)
    try {
      const pairs = Object.entries(near)
      await allow(pairs.map(([, to]) => to))
      for (const [from, to] of pairs) relink(from, to)
      setNear({})
      if (!useCompose.getState().missing.length) {
        toast('Все файлы проекта на месте', 'ok')
        onClose()
      }
    } catch (error) {
      toast((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const nearCount = Object.keys(near).filter((path) => missing.includes(path)).length

  return (
    <Modal open={open && missing.length > 0} onClose={onClose} title="Не найдены файлы проекта" wide>
      <div className="space-y-3">
        <p className="text-[13px] leading-relaxed text-ink-dim">
          Этих файлов больше нет там, где они лежали. Укажите, где они сейчас, — все
          клипы с этим файлом переедут на новое место. Можно и
          пропустить: остальной монтаж работает, а пропавшие клипы помечены на
          дорожке красным.
        </p>

        {nearCount > 0 && (
          <div className="flex items-center gap-3 rounded-xl bg-accent/10 px-3 py-2.5 ring-1 ring-accent/30">
            <FolderSearch size={16} className="shrink-0 text-accent-soft" />
            <span className="min-w-0 flex-1 text-[12.5px] text-ink">
              В той же папке нашлись ещё пропавшие файлы: {nearCount}
            </span>
            <Button tone="primary" onClick={() => void takeNear()} disabled={busy}>
              Подставить их тоже
            </Button>
          </div>
        )}

        <ul className="max-h-[46vh] space-y-1.5 overflow-y-auto">
          {missing.map((source) => (
            <li
              key={source}
              className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2 ring-1 ring-line-soft"
            >
              <FileQuestion size={16} className="shrink-0 text-danger" />
              {/* Путь можно выделить и скопировать: по нему файл и ищут. */}
              <span className="min-w-0 flex-1 select-text">
                <span className="block truncate text-[12.5px] text-ink">
                  {source.split(/[\\/]/).pop()}
                </span>
                <span className="block break-all font-mono text-[10.5px] text-ink-faint">
                  {source}
                </span>
              </span>
              <Button onClick={() => void locate(source)} disabled={busy} className="shrink-0">
                Указать место…
              </Button>
            </li>
          ))}
        </ul>

        <div className="flex justify-end">
          <Button onClick={onClose}>Пропустить</Button>
        </div>
      </div>
    </Modal>
  )
}
