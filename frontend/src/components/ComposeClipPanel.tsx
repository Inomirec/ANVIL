import { useEffect, useState } from 'react'
import { ChevronDown, Crop, FlipHorizontal2, FlipVertical2, Gauge, Plus, RotateCw, SquareDashed, Undo2, X } from 'lucide-react'
import {
  isCropped,
  newMask,
  speedOf,
  useCompose,
  type ClipEffect,
  type ClipMask,
  type ComposeClip,
} from '../composeStore'
import {
  EFFECTS,
  effectKind,
  effectParams,
  targetOf,
  type EffectTarget,
} from '../composeEffects'
import { api } from '../lib/api'
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
  const cropping = useCompose((state) => state.cropping)
  const setCropping = useCompose((state) => state.setCropping)
  const masking = useCompose((state) => state.masking)
  const setMasking = useCompose((state) => state.setMasking)

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

      {(visual ?? sound) && <Transforms clip={(visual ?? sound)!} />}

      <div className="flex flex-col gap-2">
        <Button tone="primary" onClick={() => setPicking(true)}>
          <Plus size={15} />
          Добавить эффект
        </Button>
        {visual && (visual.kind === 'video' || visual.kind === 'image') && (
          <div className="grid grid-cols-2 gap-2">
            <Button
              tone={cropping === visual.id ? 'primary' : 'subtle'}
              onClick={() => setCropping(cropping === visual.id ? null : visual.id)}
              title={
                cropping === visual.id
                  ? 'Закончить обрезку (Enter)'
                  : 'Обрезать края картинки прямо в окне просмотра'
              }
            >
              <Crop size={15} />
              {cropping === visual.id ? 'Готово' : 'Обрезать'}
            </Button>
            <Button
              tone={masking === visual.id ? 'primary' : 'subtle'}
              onClick={() => {
                if (masking === visual.id) {
                  setMasking(null)
                  return
                }
                if (!visual.mask) {
                  const state = useCompose.getState()
                  state.mark()
                  state.updateClip(visual.id, { mask: newMask(visual) })
                }
                setMasking(visual.id)
              }}
              title={
                masking === visual.id
                  ? 'Закончить с маской (Enter)'
                  : 'Прямоугольник или овал: показать только часть картинки или применить эффекты только к ней'
              }
            >
              <SquareDashed size={15} />
              {masking === visual.id ? 'Готово' : 'Маска'}
            </Button>
          </div>
        )}
      </div>

      {visual?.mask && <MaskCard clip={visual} mask={visual.mask} />}

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
  if (Math.abs(speedOf(clip) - 1) > 1e-3) {
    marks.push({
      label: `Скорость ×${Math.round(speedOf(clip) * 100) / 100}`,
      icon: <Gauge size={12} />,
      off: () => state.resetSpeed(clip.id),
    })
  }
  if (isCropped(clip)) {
    marks.push({
      label: 'Обрезано',
      icon: <Crop size={12} />,
      off: () => {
        state.mark()
        state.updateClip(clip.id, { cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 })
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

/**
 * Маска клипа в колонке: форма, что она делает, мягкость края.
 *
 * Сделана как карточка эффекта — с галочкой «включена» и крестиком, — чтобы
 * вела себя так же. Место и размер задаются мышью в окне просмотра.
 */
function MaskCard({ clip, mask }: { clip: ComposeClip; mask: ClipMask }) {
  const updateClip = useCompose((state) => state.updateClip)
  const mark = useCompose((state) => state.mark)
  const masking = useCompose((state) => state.masking)
  const setMasking = useCompose((state) => state.setMasking)
  const put = (patch: Partial<ClipMask>) => updateClip(clip.id, { mask: { ...mask, ...patch } })
  const effects = (clip.effects ?? []).some((effect) => effect.on)

  const choice = (
    label: string,
    value: string,
    options: { value: string; label: string; hint: string }[],
    onPick: (value: string) => void,
  ) => (
    <div className="space-y-1">
      <span className="block text-[11.5px] text-ink-dim">{label}</span>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-3/40 p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            title={option.hint}
            onClick={() => {
              mark()
              onPick(option.value)
            }}
            className={`rounded-md py-1 text-[11px] transition-colors ${
              value === option.value ? 'bg-surface-3 text-ink shadow-sm' : 'text-ink-faint hover:text-ink-dim'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="rounded-xl bg-surface-2 ring-1 ring-warn/40">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <input
          type="checkbox"
          checked={mask.on}
          title={mask.on ? 'Выключить маску — настройки останутся' : 'Включить маску'}
          onChange={(event) => {
            mark()
            put({ on: event.target.checked })
          }}
          className="ml-1 h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent)]"
        />
        <span className={`min-w-0 flex-1 text-[12.5px] font-medium ${mask.on ? 'text-ink' : 'text-ink-faint line-through'}`}>
          Маска
        </span>
        <button
          type="button"
          onClick={() => {
            mark()
            if (masking === clip.id) setMasking(null)
            updateClip(clip.id, { mask: null })
          }}
          title="Убрать маску"
          className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-danger"
        >
          <X size={13} />
        </button>
      </div>
      <div className={`space-y-2.5 border-t border-line-soft px-3 py-2.5 ${mask.on ? '' : 'opacity-50'}`}>
        {choice('Форма', mask.shape, [
          { value: 'ellipse', label: 'Овал', hint: 'Овал с мягким краем — для лица' },
          { value: 'rect', label: 'Прямоугольник', hint: 'Прямоугольник — для номера, надписи, угла кадра' },
        ], (value) => put({ shape: value as ClipMask['shape'] }))}
        {choice('Что делает', mask.mode, [
          { value: 'effects', label: 'Эффекты внутри', hint: 'Эффекты клипа действуют только внутри маски, остальное как было' },
          { value: 'show', label: 'Показать внутри', hint: 'Клип виден только внутри маски, снаружи — прозрачный' },
        ], (value) => put({ mode: value as ClipMask['mode'] }))}
        {mask.mode === 'effects' && !effects && (
          <p className="text-[11px] leading-snug text-warn">
            У клипа нет эффектов — добавьте, например, размытие: оно подействует только внутри маски.
          </p>
        )}
        <SliderNumber
          stacked
          label="Мягкость края"
          value={Math.round(mask.feather * 100)}
          min={0}
          max={100}
          unit="%"
          reset={15}
          marks={[
            { value: 0, label: 'резко' },
            { value: 15, label: 'обычно' },
            { value: 50, label: 'мягко' },
          ]}
          onChange={(next) => put({ feather: next / 100 })}
        />
        <label
          className="flex cursor-pointer items-center gap-2 text-[11.5px] text-ink-dim"
          title="Наоборот: действует всё, кроме выделенного"
        >
          <input
            type="checkbox"
            checked={mask.invert}
            onChange={(event) => {
              mark()
              put({ invert: event.target.checked })
            }}
            className="h-3.5 w-3.5 accent-[var(--color-accent)]"
          />
          Перевернуть — всё, кроме выделенного
        </label>
      </div>
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
      {effect.type === 'stabilize' && effect.on && (
        <StabilizeState clipId={clipId} effect={effect} />
      )}
      {!folded && (
        // Выключенный эффект настраивать можно, но видно, что он не действует.
        <div className={`space-y-2.5 border-t border-line-soft px-3 py-2.5 ${effect.on ? '' : 'opacity-50'}`}>
          {kind.params.map((param) => {
            const value = effect.params[param.key] ?? param.default
            if (param.kind === 'choice') {
              return (
                <div key={param.key} className="space-y-1" title={param.hint}>
                  <span className="block text-[11.5px] text-ink-dim">{param.label}</span>
                  <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface-3/40 p-0.5">
                    {(param.options ?? []).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        title={option.hint}
                        onClick={() =>
                          updateEffect(clipId, effect.id, { params: { [param.key]: option.value } })
                        }
                        className={`rounded-md py-1 text-[11px] transition-colors ${
                          String(value) === option.value
                            ? 'bg-surface-3 text-ink shadow-sm'
                            : 'text-ink-faint hover:text-ink-dim'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              )
            }
            if (param.kind === 'check') {
              return (
                <label
                  key={param.key}
                  title={param.hint}
                  className="flex cursor-pointer items-center gap-2 text-[11.5px] text-ink-dim"
                >
                  <input
                    type="checkbox"
                    checked={Number(value) >= 0.5}
                    onChange={(event) =>
                      updateEffect(clipId, effect.id, { params: { [param.key]: event.target.checked ? 1 : 0 } })
                    }
                    className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                  />
                  {param.label}
                </label>
              )
            }
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
              <div key={param.key} title={param.hint}>
              <SliderNumber
                stacked
                label={param.label}
                value={Number(value)}
                min={param.min ?? 0}
                max={param.max ?? 100}
                step={param.step}
                unit={param.unit ?? ''}
                reset={Number(param.default)}
                marks={param.marks}
                onChange={(next) => updateEffect(clipId, effect.id, { params: { [param.key]: next } })}
              />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Сколько осталось стабилизатору.
 *
 * Ролик стабилизируется целиком и один раз, в фоне: это может занять время,
 * и всё это время в кадре исходник. Без строки прогресса выглядело бы так,
 * будто эффект не работает. Досчиталось — кадр собирается заново.
 */
function StabilizeState({ clipId, effect }: { clipId: string; effect: ClipEffect }) {
  const clip = useCompose((state) => state.findClip(clipId)?.clip)
  const bumpRefresh = useCompose((state) => state.bumpRefresh)
  const [answer, setAnswer] = useState<{ state: string; progress?: number; error?: string } | null>(null)
  const source = clip?.source ?? ''
  // Все настройки одной строкой: сменилась любая — это другая копия.
  const settings = JSON.stringify(effect.params)

  useEffect(() => {
    if (!source) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let last = ''
    const ask = async () => {
      try {
        const next = await api.stabilizeStatus(source, JSON.parse(settings))
        if (!alive) return
        setAnswer(next)
        // Только что досчиталось — кадр надо собрать по ровной копии.
        if (next.state === 'ready' && last && last !== 'ready') bumpRefresh()
        last = next.state
        if (next.state === 'working') timer = setTimeout(ask, 1000)
      } catch {
        if (alive) timer = setTimeout(ask, 3000)
      }
    }
    // Ползунок двигают — спрашиваем, когда отпустили: каждая настройка —
    // это новый обсчёт.
    timer = setTimeout(ask, 600)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [source, settings, bumpRefresh])

  if (!answer || answer.state === 'ready') return null
  return (
    <div className="border-t border-line-soft px-3 py-2 text-[11px] leading-snug">
      {answer.state === 'error' ? (
        <span className="select-text text-danger">{answer.error}</span>
      ) : (
        <>
          <span className="text-ink-dim">
            Готовлю стабилизацию: {Math.round((answer.progress ?? 0) * 100)}%. Пока в кадре — ролик
            без неё.
          </span>
          <span className="mt-1 block h-1 overflow-hidden rounded-full bg-surface-3">
            <span
              className="block h-full bg-accent transition-all"
              style={{ width: `${Math.round((answer.progress ?? 0) * 100)}%` }}
            />
          </span>
        </>
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
