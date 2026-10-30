import { useEffect, useState } from 'react'

/**
 * Куда можно двигать клип в кадре: во все стороны, только по горизонтали
 * или только по вертикали. Нужен, когда клип выровняли по одной оси и
 * двигают по другой: рука всегда чуть уводит мышь в сторону. Одно на весь
 * монтаж — и рамки клипов, и надпись; запоминается, как прилипание.
 */
export type MoveAxis = 'both' | 'x' | 'y'

const KEY = 'sgh.composeMoveAxis'
let axis: MoveAxis = (() => {
  try {
    const saved = localStorage.getItem(KEY)
    return saved === 'x' || saved === 'y' ? saved : 'both'
  } catch {
    return 'both'
  }
})()
const listeners = new Set<(value: MoveAxis) => void>()

export function moveAxis(): MoveAxis {
  return axis
}

export function setMoveAxis(value: MoveAxis) {
  axis = value
  try {
    localStorage.setItem(KEY, value)
  } catch {
    // Без памяти — просто до перезапуска.
  }
  listeners.forEach((listener) => listener(value))
}

export function useMoveAxis(): MoveAxis {
  const [value, setValue] = useState(axis)
  useEffect(() => {
    listeners.add(setValue)
    return () => {
      listeners.delete(setValue)
    }
  }, [])
  return value
}
