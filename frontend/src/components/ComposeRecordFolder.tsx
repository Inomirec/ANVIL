import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { FolderPicker } from './FolderPicker'
import { Button, Modal } from './ui'

/**
 * Куда сохранять записи голоса — своя папка у каждого проекта.
 *
 * Спрашиваем при первой записи проекта: записи — обычные файлы WAV без
 * сжатия, и человек должен знать, где они лежат, а не обнаружить потом,
 * что какая-то папка выросла на гигабайты. Сменить папку можно стрелкой
 * рядом с кнопкой записи.
 */
export function ComposeRecordFolder({
  open,
  current,
  startAfter,
  onClose,
  onChoose,
}: {
  open: boolean
  /** Папка проекта; пусто — ещё не выбирали, предложим «Записи» в рабочей. */
  current: string
  /** После ответа сразу начнётся запись — так и подписываем кнопку. */
  startAfter: boolean
  onClose: () => void
  onChoose: (folder: string) => void
}) {
  const [folder, setFolder] = useState(current)
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    if (!open) return
    if (current) {
      setFolder(current)
      return
    }
    let alive = true
    api
      .recordFolder()
      .then((answer) => {
        if (alive) setFolder(answer.path)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [open, current])

  return (
    <>
      <Modal open={open} onClose={onClose} title="Куда сохранять записи голоса">
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-ink-dim">
            Записи этого проекта — обычные файлы WAV без сжатия, около 5,5 МБ на минуту
            голоса. Они лежат в этой папке, а не внутри программы, и удаляются как любые
            файлы.
          </p>
          <p className="cursor-text select-text break-all rounded-lg bg-surface-2 px-3 py-2 font-code text-[12px] text-ink">
            {folder || '…'}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setPicking(true)}>Другая папка…</Button>
            <Button tone="primary" disabled={!folder} onClick={() => onChoose(folder)}>
              {startAfter ? 'Записывать сюда' : 'Сохранить'}
            </Button>
          </div>
        </div>
      </Modal>
      <FolderPicker
        open={picking}
        onClose={() => setPicking(false)}
        title="Папка для записей голоса"
        onPick={(path) => setFolder(path)}
      />
    </>
  )
}
