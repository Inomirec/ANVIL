/**
 * Подсказки при наведении — свои, а не системные.
 *
 * Обычный `title` рисует Windows, и у правого края окна подсказка уходила за
 * пределы программы, обрезаясь вместе с текстом. Здесь подсказку рисует сама
 * страница и держит её внутри окна: прижимает к краю и, если снизу места
 * нет, ставит над элементом.
 *
 * Атрибуты `title` в разметке остаются как есть: на время наведения текст
 * переезжает в `data-tip`, чтобы системная подсказка не всплыла поверх
 * нашей, а потом возвращается на место.
 */

/** Сколько ждать, прежде чем показать подсказку, — как у системной. */
const DELAY = 450
/** Отступ от края окна и от элемента. */
const GAP = 8

export function installTooltips(): () => void {
  const tip = document.createElement('div')
  tip.className = 'sgh-tip'
  tip.setAttribute('role', 'tooltip')
  document.body.append(tip)

  let owner: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let mouse = { x: 0, y: 0 }

  const release = () => {
    if (timer) clearTimeout(timer)
    timer = null
    tip.classList.remove('sgh-tip-on')
    if (owner) {
      const text = owner.dataset.tip
      // Пока мы держали текст у себя, React мог поставить новый — тогда он
      // и главный.
      if (text !== undefined && !owner.hasAttribute('title')) owner.setAttribute('title', text)
      delete owner.dataset.tip
    }
    owner = null
  }

  const place = () => {
    if (!owner) return
    const text = owner.dataset.tip
    if (!text) return
    tip.textContent = text
    tip.classList.add('sgh-tip-on')
    const box = owner.getBoundingClientRect()
    const width = tip.offsetWidth
    const height = tip.offsetHeight
    // По горизонтали — у курсора, по вертикали — под элементом; у края окна
    // прижимаемся внутрь, а не выходим за него.
    const left = Math.min(Math.max(GAP, mouse.x - width / 2), window.innerWidth - width - GAP)
    let top = box.bottom + GAP
    if (top + height > window.innerHeight - GAP) top = box.top - height - GAP
    top = Math.min(Math.max(GAP, top), window.innerHeight - height - GAP)
    tip.style.left = `${left}px`
    tip.style.top = `${top}px`
  }

  const over = (event: MouseEvent) => {
    mouse = { x: event.clientX, y: event.clientY }
    const target = (event.target as Element | null)?.closest?.('[title], [data-tip]') as HTMLElement | null
    if (target === owner) return
    release()
    if (!target) return
    const text = target.getAttribute('title') ?? target.dataset.tip
    if (!text) return
    target.dataset.tip = text
    target.removeAttribute('title')
    owner = target
    timer = setTimeout(place, DELAY)
  }

  const move = (event: MouseEvent) => {
    mouse = { x: event.clientX, y: event.clientY }
  }

  const leave = (event: MouseEvent) => {
    // Курсор ушёл из окна совсем.
    if (!event.relatedTarget) release()
  }

  document.addEventListener('mouseover', over)
  document.addEventListener('mousemove', move, { passive: true })
  document.addEventListener('mouseout', leave)
  // Нажали, прокрутили, ушли из окна — подсказка больше не нужна.
  document.addEventListener('mousedown', release, true)
  window.addEventListener('scroll', release, true)
  window.addEventListener('blur', release)

  return () => {
    release()
    document.removeEventListener('mouseover', over)
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseout', leave)
    document.removeEventListener('mousedown', release, true)
    window.removeEventListener('scroll', release, true)
    window.removeEventListener('blur', release)
    tip.remove()
  }
}
