import { useState } from 'react'
import { ChevronDown, FlipHorizontal2, FlipVertical2, Plus, RotateCw, Undo2, X } from 'lucide-react'
import { useCompose, type ClipEffect, type ComposeClip } from '../composeStore'
import {
  EFFECTS,
  effectKind,
  effectParams,
  targetOf,
  type EffectTarget,
} from '../composeEffects'
import { ColorSquare, SliderNumber } from './ComposeTextPanel'
import { Button, Modal } from './ui'

/**
 * Правая колонка, пока выбран один файл на таймлайне: его эффекты.
 *
 * Эффекты добавляются кнопкой — окно выбора открывается посреди экрана, — и
 * встают сюда списком. У каждого: галочка «включён» (выключенный помнит свои
 * настройки), сворачивание до одного названия и крестик. Ролик со звуком —
 * это два клипа, картинка и звук, поэтому и списков два: звуковые эффекты
 * ложатся на звук ролика, остальные — на картинку.
 *
 * Отражение, поворот и «задом наперёд» включаются из меню по правой кнопке;
 * здесь видно, что они включены, и их можно снять.
 */
export function ComposeClipPanel({ clip }: { clip: ComposeClip }) {
  const partnerOf = useCompose((state) => state.partnerOf)
  // Подписка на дорожки: панель должна перерисоваться, когда у клипа или его
  // половины поменялись эффекты.
  useCompose((state) => state.tracks)
  const partner = partnerOf(clip.id)
  const visual = clip.kind === 'audio' ? partner : clip
  const sound = clip.kind === 'audio' ? clip : partner
  const [picking, setPicking] = useState(false)

  const parts: { clip: ComposeClip; target: EffectTarget; title: string }[] = []
  if (visual && targetOf(visual.kind)) parts.push({ clip: visual, target: 'video', title: 'Картинка' })
  if (sound) parts.push({ clip: sound, target: 'audio', title: 'Звук' })
  const both = parts.length > 1

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Эффекты</h3>
        <p className="mt-1 truncate text-[12.5px] text-ink" title={clip.source}>
          {clip.name}
        </p>
      </div>

      {visual && <Transforms clip={visual} />}

      <Button tone="primary" className="w-full" onClick={() => setPicking(true)}>
        <Plus size={15} />
        Добавить эффект
      </Button>

      {parts.map((part) => (
        <div key={part.clip.id} className="space-y-2">
          {both && (
            <h4 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              {part.title}
            </h4>
          )}
          {(part.clip.effects ?? []).length === 0 ? (
            both && <p className="text-[11.5px] text-ink-faint">Пока без эффектов</p>
          ) : (
            (part.clip.effects ?? []).map((effect) => (
              <EffectCard key={effect.id} clipId={part.clip.id} effect={effect} />
            ))
          )}
        </div>
      ))}

      <EffectPicker
        open={picking}
        onClose={() => setPicking(false)}
        parts={parts.map((part) => ({ clip: part.clip, target: part.target }))}
      />
    </div>
  )
}

/** Отражение, поворот и «задом наперёд» — видно, что включено, и можно снять. */
function Transforms({ clip }: { clip: ComposeClip }) {
  const state = useCompose()
  const marks: { label: string; icon: React.ReactNode; off: () => void }[] = []
  if (clip.flipH) {
    marks.push({
      label: 'Отражено по горизонтали',
      icon: <FlipHorizontal2 size={12} />,
      off: () => state.flipClips([clip.id], 'h'),
    })
  }
  if (clip.flipV) {
    marks.push({
      label: 'Отражено по вертикали',
      icon: <FlipVertical2 size={12} />,
      off: () => state.flipClips([clip.id], 'v'),
    })
  }
  if (clip.rotate) {
    marks.push({
      label: `Повёрнуто на ${clip.rotate}°`,
      icon: <RotateCw size={12} />,
      off: () => {
        // Доворачиваем до нуля: каждый поворот — на 90°.
        for (let turn = clip.rotate ?? 0; turn % 360; turn += 90) state.rotateClips([clip.id])
      },
    })
  }
  if (clip.reverse) {
    marks.push({
      label: 'Задом наперёд',
      icon: <Undo2 size={12} />,
      off: () => state.reverseClips([clip.id]),
    })
  }
  if (!marks.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {marks.map((mark) => (
        <span
          key={mark.label}
          className="flex items-center gap-1.5 rounded-md bg-surface-2 py-1 pl-2 pr-1 text-[11px] text-ink-dim ring-1 ring-line-soft"
        >
          {mark.icon}
          {mark.label}
          <button
            type="button"
            onClick={mark.off}
            title="Отменить"
            className="rounded p-0.5 text-ink-faint hover:bg-surface-3 hover:text-ink"
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  )
}

/** Один эффект в колонке: заголовок с галочкой и крестиком, под ним ползунки. */
function EffectCard({ clipId, effect }: { clipId: string; effect: ClipEffect }) {
  const updateEffect = useCompose((state) => state.updateEffect)
  const removeEffect = useCompose((state) => state.removeEffect)
  const mark = useCompose((state) => state.mark)
  const kind = effectKind(effect.type)
  if (!kind) return null
  const folded = Boolean(effect.folded)

  return (
    <div className="rounded-xl bg-surface-2 ring-1 ring-line-soft">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => updateEffect(clipId, effect.id, { folded: !folded })}
          title={folded ? 'Развернуть настройки' : 'Свернуть настройки'}
          className="rounded p-0.5 text-ink-faint hover:text-ink-dim"
        >
          <ChevronDown size={13} className={`transition-transform ${folded ? '-rotate-90' : ''}`} />
        </button>
        <input
          type="checkbox"
          checked={effect.on}
          title={effect.on ? 'Выключить эффект — настройки останутся' : 'Включить эффект'}
          onChange={(event) => {
            mark()
            updateEffect(clipId, effect.id, { on: event.target.checked })
          }}
          className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent)]"
        />
        <button
          type="button"
          onClick={() => updateEffect(clipId, effect.id, { folded: !folded })}
          title={kind.hint}
          className={`min-w-0 flex-1 truncate text-left text-[12.5px] font-medium ${
            effect.on ? 'text-ink' : 'text-ink-faint line-through'
          }`}
        >
          {kind.name}
        </button>
        <button
          type="button"
          onClick={() => removeEffect(clipId, effect.id)}
          title="Убрать эффект"
          className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-danger"
        >
          <X size={13} />
        </button>
      </div>
      {!folded && (
        // Выключенный эффект настраивать можно, но видно, что он не действует.
        <div className={`space-y-2.5 border-t border-line-soft px-3 py-2.5 ${effect.on ? '' : 'opacity-50'}`}>
          {kind.params.map((param) => {
            const value = effect.params[param.key] ?? param.default
            if (param.kind === 'color') {
              return (
                <div key={param.key} className="flex items-center gap-2">
                  <span className="flex-1 text-[11.5px] text-ink-dim">{param.label}</span>
                  <span className="font-mono text-[11px] uppercase text-ink-faint">{String(value)}</span>
                  <ColorSquare
                    value={String(value)}
                    title={param.label}
                    onChange={(next) => updateEffect(clipId, effect.id, { params: { [param.key]: next } })}
                  />
                </div>
              )
            }
            return (
              <SliderNumber
                key={param.key}
                stacked
                label={param.label}
                value={Number(value)}
                min={param.min ?? 0}
                max={param.max ?? 100}
                step={param.step}
                unit={param.unit ?? ''}
                reset={Number(param.default)}
                onChange={(next) => updateEffect(clipId, effect.id, { params: { [param.key]: next } })}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Окно выбора эффекта — посреди экрана.
 *
 * Эффекты разложены по тому, к чему применяются. Уже добавленные к этому
 * клипу помечены и не добавляются второй раз: два одинаковых эффекта подряд
 * — это просто один посильнее.
 */
export function EffectPicker({
  open,
  onClose,
  parts,
}: {
  open: boolean
  onClose: () => void
  parts: { clip: ComposeClip; target: EffectTarget }[]
}) {
  const addEffect = useCompose((state) => state.addEffect)
  const groups: { title: string; target: EffectTarget }[] = [
    { title: 'Картинка', target: 'video' },
    { title: 'Звук', target: 'audio' },
  ]
  return (
    <Modal open={open} onClose={onClose} title="Добавить эффект" wide>
      <div className="space-y-4">
        {groups.map((group) => {
          const part = parts.find((item) => item.target === group.target)
          if (!part) return null
          const taken = new Set((part.clip.effects ?? []).map((effect) => effect.type))
          return (
            <div key={group.target} className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                {group.title}
              </h4>
              <div className="grid grid-cols-3 gap-2">
                {EFFECTS.filter((effect) => effect.target === group.target).map((effect) => (
                  <button
                    key={effect.type}
                    type="button"
                    disabled={taken.has(effect.type)}
                    onClick={() => {
                      addEffect(part.clip.id, effect.type, effectParams(effect.type))
                      onClose()
                    }}
                    className="rounded-xl border border-line-soft bg-surface-2 px-3 py-2.5 text-left transition-colors enabled:hover:border-line enabled:hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className="block text-[13px] font-medium text-ink">{effect.name}</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                      {taken.has(effect.type) ? 'Уже добавлен' : effect.hint}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
