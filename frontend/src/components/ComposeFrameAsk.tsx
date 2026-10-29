import { fpsLabel, SOURCE_SIZE_LIMIT, sourceFrame } from '../composeStore'
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
  /** Частота кадров файла — из списка монтажа. Нет — файл неподвижный. */
  fps?: number
}

export function ComposeFrameAsk({
  question,
  current,
  onSource,
  onKeep,
}: {
  question: FrameQuestion | null
  current: { width: number; height: number; fps: number }
  onSource: () => void
  onKeep: () => void
}) {
  const size = question ? sourceFrame(question.width, question.height) : null
  const shrunk = question && Math.max(question.width, question.height) > SOURCE_SIZE_LIMIT
  // Форма та же — полей не будет, меняется только чёткость: файл уменьшится
  // или растянется до кадра монтажа.
  const sameShape =
    question && Math.abs(question.width / question.height - current.width / current.height) < 0.01
  const sameSize = Boolean(size && size.width === current.width && size.height === current.height)
  // Частота кадров — тоже от файла: иначе ролик на 24 кадра собирался бы в
  // 60 или 30, и движение шло бы рывками из повторённых кадров.
  const otherFps = Boolean(question?.fps && Math.abs(question.fps - current.fps) > 1e-3)
  const consequence = !question
    ? ''
    : sameSize
      ? ''
      : !sameShape
        ? 'Если оставить как есть, по краям файла будут чёрные поля.'
        : question.width > current.width
          ? 'Форма та же, но готовое видео будет меньше и не такое чёткое, как файл.'
          : 'Форма та же, но файл растянется до кадра монтажа и станет мягче.'
  const fpsNote = otherFps
    ? ` Кадров в секунду у файла ${fpsLabel(question!.fps!)}, у монтажа ${fpsLabel(current.fps)} — движение пойдёт рывками.`
    : ''
  const here = `${current.width}×${current.height}${otherFps ? `, ${fpsLabel(current.fps)} к/с` : ''}`
  const there = size ? `${size.width}×${size.height}${otherFps ? `, ${fpsLabel(question!.fps!)} к/с` : ''}` : ''

  return (
    <Modal open={Boolean(question)} onClose={onKeep} title={sameSize ? 'Частота кадров' : 'Размер кадра'}>
      {question && size && (
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-ink-dim">
            У файла «{question.name}» размер {question.width}×{question.height}, а у монтажа сейчас{' '}
            {current.width}×{current.height}. {consequence}
            {fpsNote}
          </p>
          {shrunk && (
            <p className="text-[12px] leading-relaxed text-ink-faint">
              Файл больше 4K — кадр будет {size.width}×{size.height}, той же формы.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={onKeep}>Оставить {here}</Button>
            <Button tone="primary" onClick={onSource}>
              Как у файла: {there}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
