import { useEffect, useState } from 'react'

/**
 * Своя пипетка монтажа: взять цвет из кадра в окне просмотра.
 *
 * У стандартного окошка выбора цвета кнопка пипетки есть, но встроенный в
 * программу браузер её не поддерживает — нажатие ничего не делает. Поэтому
 * квадратик цвета просит цвет здесь, а окно просмотра, пока просьба открыта,
 * ловит нажатие по кадру и отдаёт цвет пикселя под курсором.
 */
type Request = { owner: object; done: (hex: string) => void }

let current: Request | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

/** Начать выбор цвета; повторное нажатие той же кнопки — отмена. */
export function requestColorPick(owner: object, done: (hex: string) => void) {
  current = current?.owner === owner ? null : { owner, done }
  notify()
}

/** Закончить выбор: с цветом — отдать его, без — просто отменить. */
export function finishColorPick(hex: string | null) {
  const request = current
  current = null
  notify()
  if (hex && request) request.done(hex)
}

/** Кто сейчас ждёт цвет (или ``null``). */
export function useColorPickOwner(): object | null {
  const [owner, setOwner] = useState(current?.owner ?? null)
  useEffect(() => {
    const listener = () => setOwner(current?.owner ?? null)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return owner
}

/**
 * Снимок того, что сейчас в кадре, — картинки под иглой или идущего видео.
 * Отдаёт функцию: точка экрана → цвет. ``null`` — показывать нечего.
 */
export function snapshotColors(source: HTMLImageElement | HTMLVideoElement | null) {
  if (!source) return null
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight
  if (!width || !height) return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(source, 0, 0, width, height)
  let pixels: Uint8ClampedArray
  try {
    pixels = context.getImageData(0, 0, width, height).data
  } catch {
    return null
  }
  return (clientX: number, clientY: number): string | null => {
    // Прямоугольник уже с приближением кадра — переводить ничего не нужно.
    const box = source.getBoundingClientRect()
    const x = Math.floor(((clientX - box.left) / box.width) * width)
    const y = Math.floor(((clientY - box.top) / box.height) * height)
    if (x < 0 || y < 0 || x >= width || y >= height) return null
    const at = (y * width + x) * 4
    return `#${[pixels[at], pixels[at + 1], pixels[at + 2]].map((part) => part.toString(16).padStart(2, '0')).join('')}`
  }
}
