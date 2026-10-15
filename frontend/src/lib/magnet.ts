import { useEffect, useState } from 'react'

/**
 * Прилипание в монтаже — одно на всё: клипы на таймлайне, игла, рамки в
 * кадре, обрезка, надпись. Выключают его, когда нужно поставить что-то на
 * пару пикселей мимо края или сетки: с прилипанием это почти невозможно.
 * Кадровая сетка таймлайна — не прилипание, она остаётся всегда.
 */
const KEY = 'sgh.composeMagnet'
let on = (() => {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
})()
const listeners = new Set<(value: boolean) => void>()

export function magnetOn(): boolean {
  return on
}

export function setMagnet(value: boolean) {
  on = value
  try {
    localStorage.setItem(KEY, value ? 'on' : 'off')
  } catch {
    // Без памяти — просто до перезапуска.
  }
  listeners.forEach((listener) => listener(value))
}

export function useMagnet(): boolean {
  const [value, setValue] = useState(on)
  useEffect(() => {
    listeners.add(setValue)
    return () => {
      listeners.delete(setValue)
    }
  }, [])
  return value
}
