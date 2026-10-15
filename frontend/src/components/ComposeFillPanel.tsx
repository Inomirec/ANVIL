import { PlaceFields } from './ComposeAnimUi'
import { useState } from 'react'
import { EFFECT_PIXELS, effectDefaults, useCompose, type ComposeClip } from '../composeStore'
import { ColorSquare, EffectSection, SliderNumber } from './ComposeTextPanel'

/**
 * Настройки заливки — в правой колонке, пока заливка выделена.
 *
 * Устроены так же, как у надписи: цвет квадратиком, эффекты за галочками,
 * ползунки с полем для точного числа и возвратом на место двойным нажатием.
 * Рамка и тень хранятся в тех же полях, что у надписи, поэтому и ведут себя
 * одинаково.
 *
 * Скругление, рамку и тень у заливки рисует программа картинкой, один раз на
 * форму, — поэтому кадр после правки появляется чуть медленнее обычного.
 */

/** Код цвета: вписать можно и «#ff8800», и «ff8800». */
function HexField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const apply = () => {
    if (draft === null) return
    const clean = draft.trim().replace(/^#/, '')
    if (/^[0-9a-fA-F]{6}$/.test(clean)) onChange(`#${clean.toLowerCase()}`)
    setDraft(null)
  }
  return (
    <input
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={apply}
      onKeyDown={(event) => {
        if (event.key === 'Enter') apply()
      }}
      title="Код цвета"
      className="h-8 w-[92px] rounded-lg border border-line-soft bg-surface-2 px-2 font-mono text-[12px] uppercase outline-none"
    />
  )
}

export function ComposeFillPanel({ clip }: { clip: ComposeClip }) {
  const updateClip = useCompose((state) => state.updateClip)
  const height = useCompose((state) => state.height)
  const put = (patch: Partial<ComposeClip>) => updateClip(clip.id, patch)
  const px = (share: number) => Math.round(share * height * 10) / 10
  const fraction = (pixels: number) => pixels / height
  const stock = effectDefaults(height)

  const colour = clip.color ?? '#101018'
  const strokeOn = clip.strokeOn ?? false
  const shadowOn = clip.shadowOn ?? false

  return (
    <div className="space-y-3.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Заливка</h3>

      {/* Место и размер числами, с часиками: заливку можно двигать и
          растягивать по ходу видео. */}
      <PlaceFields clip={clip} />

      <div className="flex items-center gap-2">
        <ColorSquare value={colour} title="Цвет заливки" onChange={(value) => put({ color: value })} />
        <HexField value={colour} onChange={(value) => put({ color: value })} />
      </div>

      <SliderNumber
        label="Скругление"
        value={px(clip.radius ?? 0)}
        min={0}
        max={200}
        unit="px"
        reset={EFFECT_PIXELS.radius}
        onChange={(value) => put({ radius: fraction(value) })}
      />

      <EffectSection
        label="Рамка"
        on={strokeOn}
        onToggle={(value) =>
          put({
            strokeOn: value,
            // Включили впервые — даём обычную толщину и тот цвет, что виден
            // в квадратике, чтобы программа рисовала ровно показанное.
            ...(value && !((clip.stroke ?? 0) > 0) ? { stroke: stock.stroke } : {}),
            ...(value && !clip.strokeColor ? { strokeColor: '#ffffff' } : {}),
          })
        }
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SliderNumber
              label="Толщина"
              value={px(clip.stroke ?? stock.stroke)}
              min={1}
              max={40}
              unit="px"
              reset={EFFECT_PIXELS.stroke}
              onChange={(value) => put({ stroke: fraction(value) })}
            />
            {/* Рамка — снаружи заливки. Её внешние углы по умолчанию
                следуют скруглению заливки; ноль — так и есть. */}
            <SliderNumber
              label="Скругление"
              value={px(clip.strokeRound ?? 0)}
              min={0}
              max={200}
              unit="px"
              reset={0}
              onChange={(value) => put({ strokeRound: fraction(value) })}
            />
          </div>
          <ColorSquare
            value={clip.strokeColor ?? '#ffffff'}
            title="Цвет рамки"
            onChange={(value) => put({ strokeColor: value })}
          />
        </div>
      </EffectSection>

      <EffectSection
        label="Тень"
        on={shadowOn}
        onToggle={(value) =>
          put(
            value && !clip.shadowX && !clip.shadowY
              ? { shadowOn: true, shadowX: stock.shadowX, shadowY: stock.shadowY, shadowAlpha: stock.shadowAlpha }
              : { shadowOn: value },
          )
        }
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-2">
            <SliderNumber
              label="Вправо"
              value={px(clip.shadowX ?? stock.shadowX)}
              min={-20}
              max={20}
              step={0.5}
              unit="px"
              reset={EFFECT_PIXELS.shadowX}
              onChange={(value) => put({ shadowX: fraction(value) })}
            />
            <SliderNumber
              label="Вниз"
              value={px(clip.shadowY ?? stock.shadowY)}
              min={-20}
              max={20}
              step={0.5}
              unit="px"
              reset={EFFECT_PIXELS.shadowY}
              onChange={(value) => put({ shadowY: fraction(value) })}
            />
            <SliderNumber
              label="Видимость"
              value={Math.round((clip.shadowAlpha ?? stock.shadowAlpha) * 100)}
              min={0}
              max={100}
              unit="%"
              reset={75}
              onChange={(value) => put({ shadowAlpha: value / 100 })}
            />
            <SliderNumber
              label="Размытие"
              value={px(clip.shadowBlur ?? 0)}
              min={0}
              max={30}
              step={0.5}
              unit="px"
              reset={0}
              onChange={(value) => put({ shadowBlur: fraction(value) })}
            />
          </div>
          <ColorSquare
            value={clip.shadowColor ?? '#000000'}
            title="Цвет тени"
            onChange={(value) => put({ shadowColor: value })}
          />
        </div>
      </EffectSection>
    </div>
  )
}
