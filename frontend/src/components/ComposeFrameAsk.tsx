import { SOURCE_SIZE_LIMIT, sourceFrame } from '../composeStore'
import { Button, Modal } from './ui'

/**
 * Вопрос о размере кадра, когда на пустой таймлайн положили первый файл.
 *
 * Готовые наборы покрывают обычные размеры, а файл бывает любым — и тогда
 * вокруг него в готовом видео остаются чёрные поля. Задать размер «Свой» можно
 * и руками, но подбирать числа под файл неудобно. Поэтому спрашиваем один
 * раз, на первом файле с картинкой: дальше монтаж уже чему-то подчинён, и
 * менять кадр под каждый новый файл было бы неправильно.
 */
export interface FrameQuestion {
  name: string
  width: number
  height: number
}

export function ComposeFrameAsk({
  question,
  current,
  onSource,
  onKeep,
}: {
  question: FrameQuestion | null
  current: { width: number; height: number }
  onSource: () => void
  onKeep: () => void
}) {
  const size = question ? sourceFrame(question.width, question.height) : null
  const shrunk = question && Math.max(question.width, question.height) > SOURCE_SIZE_LIMIT

  return (
    <Modal open={Boolean(question)} onClose={onKeep} title="Размер кадра">
      {question && size && (
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-ink-dim">
            У файла «{question.name}» размер {question.width}×{question.height}, а у монтажа сейчас{' '}
            {current.width}×{current.height}. Если оставить как есть, по краям файла будут чёрные
            поля.
          </p>
          {shrunk && (
            <p className="text-[12px] leading-relaxed text-ink-faint">
              Файл больше 4K — кадр будет {size.width}×{size.height}, той же формы.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={onKeep}>
              Оставить {current.width}×{current.height}
            </Button>
            <Button tone="primary" onClick={onSource}>
              Как у файла: {size.width}×{size.height}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
