import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FADE_CURVES, fadeLine, type FadeCurve } from '../lib/fades'

/**
 * Выбор формы появления или ухода — по правой кнопке на уголке затухания,
 * как в монтажных программах. Один столбик значков; у перехода между двумя
 * клипами — сетка: строка — уход нижнего, столбец — появление верхнего.
 * Общий у монтажа и медиатеки.
 */

type Curve = Exclude<FadeCurve, ''>

function Icon({ lines, chosen }: { lines: { curve: Curve; side: 'in' | 'out' }[]; chosen: boolean }) {
  return (
    <svg viewBox="-6 -6 112 112" className={`h-7 w-10 rounded-[3px] ${chosen ? 'bg-accent/25' : 'bg-black/40'}`}>
      {lines.map((line, index) => (
        <polyline
          key={index}
          points={fadeLine(line.curve, line.side)}
          fill="none"
          className={chosen ? 'stroke-accent-soft' : 'stroke-ink-dim'}
          strokeWidth="7"
          strokeLinecap="round"
        />
      ))}
    </svg>
  )
}

/** Меню у самой мыши, не вылезая за края окна; закрывается нажатием мимо. */
function useFloating(at: { x: number; y: number }, onClose: () => void) {
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: at.x, top: at.y })
  useLayoutEffect(() => {
    const size = box.current?.getBoundingClientRect()
    if (!size) return
    setPlace({
      left: Math.max(6, Math.min(at.x, window.innerWidth - size.width - 6)),
      top: Math.max(6, Math.min(at.y, window.innerHeight - size.height - 6)),
    })
  }, [at.x, at.y])
  useEffect(() => {
    const close = (event: Event) => {
      if (event.type === 'mousedown' && box.current?.contains(event.target as Node)) return
      onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('resize', close)
    }
  }, [onClose])
  return { box, place }
}

export function FadeCurveMenu({
  at,
  side,
  current,
  onPick,
  onClose,
}: {
  at: { x: number; y: number }
  side: 'in' | 'out'
  current: Curve
  onPick: (curve: Curve) => void
  onClose: () => void
}) {
  const { box, place } = useFloating(at, onClose)
  return createPortal(
    <div
      ref={box}
      className="fixed z-[60] rounded-xl border border-line bg-surface-2 p-1 shadow-xl"
      style={place}
      onContextMenu={(event) => event.preventDefault()}
    >
      <p className="px-2 pb-1 pt-0.5 text-[10.5px] text-ink-faint">{side === 'in' ? 'Форма появления' : 'Форма ухода'}</p>
      {FADE_CURVES.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => {
            onPick(item.id)
            onClose()
          }}
          className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-left text-[12px] transition-colors hover:bg-surface-3 ${
            item.id === current ? 'text-accent-soft' : 'text-ink-dim hover:text-ink'
          }`}
        >
          <Icon lines={[{ curve: item.id, side }]} chosen={item.id === current} />
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}

export function CrossFadeMenu({
  at,
  out,
  into,
  onPick,
  onClose,
}: {
  at: { x: number; y: number }
  /** Форма ухода нижнего (раньше начавшегося) клипа. */
  out: Curve
  /** Форма появления верхнего. */
  into: Curve
  onPick: (out: Curve, into: Curve) => void
  onClose: () => void
}) {
  const { box, place } = useFloating(at, onClose)
  return createPortal(
    <div
      ref={box}
      className="fixed z-[60] rounded-xl border border-line bg-surface-2 p-1.5 shadow-xl"
      style={place}
      onContextMenu={(event) => event.preventDefault()}
    >
      <p className="px-1 pb-1.5 text-[10.5px] text-ink-faint">Форма перехода: строка — уход, столбец — появление</p>
      <div className="grid grid-cols-5 gap-1">
        {FADE_CURVES.map((leaving) =>
          FADE_CURVES.map((coming) => {
            const chosen = leaving.id === out && coming.id === into
            return (
              <button
                key={`${leaving.id}-${coming.id}`}
                type="button"
                title={`Уход: ${leaving.label.toLowerCase()}, появление: ${coming.label.toLowerCase()}`}
                onClick={() => {
                  onPick(leaving.id, coming.id)
                  onClose()
                }}
                className="rounded-[4px] p-0.5 transition-colors hover:bg-surface-3"
              >
                <Icon
                  lines={[
                    { curve: leaving.id, side: 'out' },
                    { curve: coming.id, side: 'in' },
                  ]}
                  chosen={chosen}
                />
              </button>
            )
          }),
        )}
      </div>
    </div>,
    document.body,
  )
}
