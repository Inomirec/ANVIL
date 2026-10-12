import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { api } from '../lib/api'

/**
 * Верхняя панель вместо системной строки заголовка.
 *
 * Системную строку программа убирает сама (`core/titlebar.py`), и тогда
 * её работу делает наша панель: за пустое место окно таскают, двойное
 * нажатие разворачивает, а справа — кнопки «свернуть», «развернуть»,
 * «закрыть». Таскает и разворачивает по-прежнему Windows — с прилипанием к
 * краям экрана. Если строку убрать не вышло (или программа открыта в
 * браузере), панель остаётся обычной и своих кнопок не рисует.
 */
export function useWindowChrome() {
  const [chrome, setChrome] = useState({ custom: false, maximized: false })
  const last = useRef<{ at: number; x: number; y: number } | null>(null)

  const refresh = useCallback(() => {
    api
      .windowState()
      .then(setChrome)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    // Строку меняют, когда окно уже показано, — тогда приходит это событие.
    window.addEventListener('sgh:titlebar', refresh)
    // Развернули или вернули окно — значок средней кнопки другой.
    let timer: ReturnType<typeof setTimeout> | null = null
    const onResize = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(refresh, 120)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('sgh:titlebar', refresh)
      window.removeEventListener('resize', onResize)
      if (timer) clearTimeout(timer)
    }
  }, [refresh])

  /**
   * Нажатие по пустому месту панели. Двойное — развернуть или вернуть;
   * одиночное — таскать окно. Двойное считаем сами: после первого нажатия
   * мышью владеет Windows, и страница второго «двойного» не видит.
   */
  const onMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (!chrome.custom || event.button !== 0) return
      const target = event.target as HTMLElement
      if (target.closest('button, a, input, select, textarea, [data-no-drag]')) return
      event.preventDefault()
      const now = Date.now()
      const previous = last.current
      const twice =
        previous &&
        now - previous.at < 450 &&
        Math.abs(previous.x - event.clientX) < 6 &&
        Math.abs(previous.y - event.clientY) < 6
      last.current = twice ? null : { at: now, x: event.clientX, y: event.clientY }
      void api.windowAction(twice ? 'maximize' : 'drag').catch(() => undefined)
    },
    [chrome.custom],
  )

  return { ...chrome, onMouseDown }
}

/** Полоска у верхнего края — тянуть окно за верх, раз системной рамки там нет. */
export function TopResizeEdge({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <div
      data-no-drag
      className="absolute inset-x-0 top-0 z-20 h-[4px] cursor-ns-resize"
      onMouseDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        void api.windowAction('resize-top').catch(() => undefined)
      }}
    />
  )
}

/** Кнопки окна справа в верхней панели. */
export function WindowButtons({ maximized }: { maximized: boolean }) {
  const button =
    'flex h-12 w-11 items-center justify-center text-ink-dim transition-colors hover:bg-surface-3 hover:text-ink'
  return (
    <div className="-mr-4 ml-1 flex items-stretch self-stretch">
      <button
        type="button"
        title="Свернуть"
        className={button}
        onClick={() => void api.windowAction('minimize').catch(() => undefined)}
      >
        <Minus size={15} />
      </button>
      <button
        type="button"
        title={maximized ? 'Свернуть в окно' : 'Развернуть'}
        className={button}
        onClick={() => void api.windowAction('maximize').catch(() => undefined)}
      >
        {maximized ? <Copy size={13} className="-scale-x-100" /> : <Square size={12} />}
      </button>
      <button
        type="button"
        title="Закрыть"
        className="flex h-12 w-11 items-center justify-center text-ink-dim transition-colors hover:bg-[#c42b1c] hover:text-white"
        onClick={() => void api.windowAction('close').catch(() => undefined)}
      >
        <X size={16} />
      </button>
    </div>
  )
}
