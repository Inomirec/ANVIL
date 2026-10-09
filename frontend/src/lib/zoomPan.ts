import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Увеличительное стекло для окна просмотра: колесо приближает к точке под
 * курсором, зажатое колесо таскает картинку. На сам файл не влияет.
 *
 * Колесо слушаем напрямую, а не через `onWheel` React: там обработчик
 * «только смотрит», и `preventDefault` молча не срабатывает — страница
 * прокручивалась бы вместе с приближением.
 *
 * ``resetKey`` — смена файла: новый файл открывается в обычном размере.
 */
export function useZoomPan(resetKey: unknown, max = 8) {
  const shell = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  // Обработчик колеса живёт дольше одного рендера — значения берём из ссылки.
  const state = useRef({ view, pan })
  state.current = { view, pan }

  const reset = useCallback(() => {
    setView(1)
    setPan({ x: 0, y: 0 })
  }, [])

  useEffect(reset, [resetKey, reset])

  useEffect(() => {
    const box = shell.current
    if (!box) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const { view: was, pan: moved } = state.current
      const next = Math.min(max, Math.max(1, Number((was * (event.deltaY < 0 ? 1.15 : 1 / 1.15)).toFixed(3))))
      if (next === was) return
      if (next === 1) {
        state.current = { view: 1, pan: { x: 0, y: 0 } }
        reset()
        return
      }
      // Картинка стоит посередине окна, и увеличивается она от своей
      // середины — поэтому и точку под курсором считаем от середины окна.
      const rect = box.getBoundingClientRect()
      const toX = event.clientX - (rect.left + rect.width / 2)
      const toY = event.clientY - (rect.top + rect.height / 2)
      const keep = next / was
      const shifted = { x: toX - (toX - moved.x) * keep, y: toY - (toY - moved.y) * keep }
      // Несколько щелчков колеса успевают прийти до перерисовки — каждый
      // должен считаться от предыдущего, а не от последнего нарисованного.
      state.current = { view: next, pan: shifted }
      setPan(shifted)
      setView(next)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [max, reset])

  /** Зажатое колесо таскает приближенную картинку. */
  const onMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 1 || state.current.view <= 1) return
    event.preventDefault()
    const from = { x: event.clientX, y: event.clientY }
    const was = { ...state.current.pan }
    const move = (moved: MouseEvent) =>
      setPan({ x: was.x + (moved.clientX - from.x), y: was.y + (moved.clientY - from.y) })
    const drop = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', drop)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', drop)
  }, [])

  return {
    shell,
    view,
    reset,
    onMouseDown,
    transform: view === 1 ? undefined : `translate(${pan.x}px, ${pan.y}px) scale(${view})`,
  }
}
