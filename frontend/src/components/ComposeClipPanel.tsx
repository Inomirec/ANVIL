import { useEffect, useState } from 'react'
import {
  ChevronDown,
  Crop,
  FlipHorizontal2,
  FlipVertical2,
  Gauge,
  Blend,
  Move,
  Plus,
  RotateCw,
  SquareDashed,
  Undo2,
  Volume2,
  X,
} from 'lucide-react'
import {
  MIN_DB,
  dbToGain,
  gainToDb,
  isCropped,
  newMask,
  speedOf,
  trackNumber,
  useCompose,
  type ClipEffect,
  type ClipMask,
  type ComposeClip,
} from '../composeStore'
import { POINTS, shownAt, valueAt, withoutGroup } from '../composeAnim'
import {
  EFFECTS,
  effectKind,
  effectParams,
  targetOf,
  type EffectTarget,
} from '../composeEffects'
import { api } from '../lib/api'
import { AnimClock, OpacityRow, PlaceFields } from './ComposeAnimUi'
import { ColorSquare, SliderNumber } from './ComposeTextPanel'
import { Button, Modal } from './ui'

/**
 * Правая колонка, пока выбран один файл на таймлайне: его место в кадре,
 * обрезка, маска и эффекты.
 *
 * Каждый раздел — карточка, которая сворачивается до заголовка: у маски
 * настроек много, и места в колонке на всё не хватает. Нажатие по карточке
 * выбирает её — на таймлайне видны ключи именно её, а кнопки ключей под
 * окном просмотра работают с ней.
 *
 * Добавить эффект, обрезку или маску — кнопками внизу колонки (`ClipAddBar`),
 * над настройками сборки. Ролик со звуком — это два клипа, картинка и звук,
 * поэтому и списков эффектов два.
 */
export function ComposeClipPanel({ clip }: { clip: ComposeClip }) {
  const partnerOf = useCompose((state) => state.partnerOf)
  // Подписка на дорожки: панель должна перерисоваться, когда у клипа или его
  // половины поменялись эффекты.
  useCompose((state) => state.tracks)
  const partner = partnerOf(clip.id)
  const visual = clip.kind === 'audio' ? partner : clip
  const sound = clip.kind === 'audio' ? clip : partner

  const parts: { clip: ComposeClip; target: EffectTarget; title: string }[] = []
  if (visual && targetOf(visual.kind)) parts.push({ clip: visual, target: 'video', title: 'Картинка' })
  if (sound) parts.push({ clip: sound, target: 'audio', title: 'Звук' })
  const both = parts.length > 1
  const picture = visual && (visual.kind === 'video' || visual.kind === 'image') ? visual : null

  return (
    <div className="space-y-3">
      {(visual ?? sound) && <Transforms clip={(visual ?? sound)!} />}

      {picture && <PictureCard clip={picture} />}

      {picture && (
        <Card id="place" title="Место в кадре" icon={<Move size={13} />} focusGroup="position">
          <PlaceFields clip={picture} opacity={false} />
        </Card>
      )}

      {picture && <CropCard clip={picture} />}

      {picture && <MaskCard clip={picture} mask={picture.mask ?? null} />}

      {sound && <SoundCard clip={sound} />}

      {parts.map((part) => (
        <div key={part.clip.id} className="space-y-2">
          {both && (part.clip.effects ?? []).length > 0 && (
            <h4 className="pt-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              {part.title}
            </h4>
          )}
          {(part.clip.effects ?? []).map((effect) => (
            <EffectCard key={effect.id} clipId={part.clip.id} effect={effect} />
          ))}
        </div>
      ))}

      {/* Эффектов пока нет — колонка не должна выглядеть пустой и сломанной. */}
      {!parts.some((part) => (part.clip.effects ?? []).length) && (
        <p className="px-1 pt-1 text-center text-[11.5px] leading-snug text-ink-faint/70">
          Здесь появятся эффекты клипа — их добавляют кнопкой «Добавить эффект» внизу
          колонки.
        </p>
      )}
    </div>
  )
}

/**
 * Эффекты на всю дорожку — колонка справа после кнопки Fx у дорожки.
 *
 * Те же карточки, что у клипа, только действуют на каждый клип дорожки:
 * один раз подобрать цвет для всех кусков записи, а не копировать эффект
 * по клипам. Ключей у них нет — у дорожки нет своего времени. Стабилизатора
 * в списке нет: он считает каждый ролик отдельно и долго.
 */
export function ComposeTrackFxPanel({ trackId }: { trackId: string }) {
  const tracks = useCompose((state) => state.tracks)
  const setTrackFx = useCompose((state) => state.setTrackFx)
  const [picking, setPicking] = useState(false)
  const track = tracks.find((item) => item.id === trackId)
  if (!track) return null
  const effects = track.effects ?? []
  const target: EffectTarget = track.kind === 'audio' ? 'audio' : 'video'
  const label = track.name?.trim() || (track.kind === 'audio' ? 'Звук' : 'Видео')
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          Эффекты дорожки {trackNumber(tracks, track.id)} · {label}
        </h3>
        <button
          type="button"
          onClick={() => setTrackFx(null)}
          title="Закрыть — вернуться к настройкам сборки"
          className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>
      <p className="px-0.5 text-[11.5px] leading-snug text-ink-faint">
        Действуют на каждый клип этой дорожки — и на те, что положите на неё
        потом. Свои эффекты клипа идут раньше.
      </p>
      {effects.map((effect) => (
        <EffectCard key={effect.id} clipId={track.id} effect={effect} />
      ))}
      <button
        type="button"
        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-line-soft bg-surface-2 px-2 text-[11.5px] text-ink-dim transition-colors hover:border-line hover:text-ink"
        onClick={() => setPicking(true)}
      >
        <Plus size={13} />
        Добавить эффект
      </button>
      <EffectPicker
        open={picking}
        onClose={() => setPicking(false)}
        parts={[{ clip: { id: track.id, effects }, target }]}
        exclude={['stabilize']}
      />
    </div>
  )
}

/**
 * Куда идёт звук. Уходящая сторона переливается в другую: ролик со звуком
 * только в левом ухе выводится вправо, а копия клипа на соседней дорожке,
 * выведенная в другую сторону, даёт звук в оба уха.
 */
const PAN_MARKS = [
  { value: -100, label: 'Л', hint: 'Весь звук — в левое ухо' },
  { value: 0, label: 'C', hint: 'Как в файле' },
  { value: 100, label: 'П', hint: 'Весь звук — в правое ухо' },
]

/**
 * Громкость, появление и уход звука — числами. На самом клипе их тянут на
 * глаз (шторка и уголки), здесь — ставят точно. Колонка у звукового клипа
 * без этого была совсем пустой.
 */
function SoundCard({ clip }: { clip: ComposeClip }) {
  const updateClip = useCompose((state) => state.updateClip)
  const mark = useCompose((state) => state.mark)
  const half = Math.max(0, Math.round((clip.duration / 2) * 100) / 100)
  const put = (patch: Partial<ComposeClip>) => updateClip(clip.id, patch)
  return (
    <Card id="sound" title="Звук" icon={<Volume2 size={13} />}>
      <div className="space-y-2" onMouseDownCapture={() => mark()}>
        <SliderNumber
          label="Громкость"
          unit="дБ"
          value={Math.round(gainToDb(Math.min(clip.volume, 1)) * 10) / 10}
          min={MIN_DB}
          max={0}
          step={0.5}
          reset={0}
          onChange={(db) => put({ volume: Math.min(1, dbToGain(db)) })}
        />
        <SliderNumber
          label="Панорама"
          unit="%"
          value={Math.round((clip.pan ?? 0) * 100)}
          min={-100}
          max={100}
          step={5}
          reset={0}
          marks={PAN_MARKS}
          onChange={(value) => put({ pan: Math.min(1, Math.max(-1, value / 100)) })}
        />
        <SliderNumber
          label="Появление"
          unit="с"
          value={clip.fadeIn}
          min={0}
          max={half}
          step={0.05}
          reset={0}
          onChange={(fadeIn) => put({ fadeIn: Math.min(half, Math.max(0, fadeIn)) })}
        />
        <SliderNumber
          label="Уход"
          unit="с"
          value={clip.fadeOut}
          min={0}
          max={half}
          step={0.05}
          reset={0}
          onChange={(fadeOut) => put({ fadeOut: Math.min(half, Math.max(0, fadeOut)) })}
        />
      </div>
    </Card>
  )
}

/**
 * Видимость картинки или ролика: непрозрачность (с часиками), появление и
 * уход — числами, как у звука. На самом клипе их тянут за линию уровня и
 * уголки, здесь ставят точно. Стоит первой: это то, что правят чаще всего.
 */
function PictureCard({ clip }: { clip: ComposeClip }) {
  const updateClip = useCompose((state) => state.updateClip)
  const mark = useCompose((state) => state.mark)
  const half = Math.max(0, Math.round((clip.duration / 2) * 100) / 100)
  const put = (patch: Partial<ComposeClip>) => updateClip(clip.id, patch)
  return (
    <Card id="picture" title="Видимость" icon={<Blend size={13} />}>
      <div className="mb-2">
        <OpacityRow clip={clip} label="Непрозрачность" wide />
      </div>
      <div className="space-y-2" onMouseDownCapture={() => mark()}>
        <SliderNumber
          label="Появление"
          unit="с"
          value={clip.fadeIn}
          min={0}
          max={half}
          step={0.05}
          reset={0}
          onChange={(fadeIn) => put({ fadeIn: Math.min(half, Math.max(0, fadeIn)) })}
        />
        <SliderNumber
          label="Уход"
          unit="с"
          value={clip.fadeOut}
          min={0}
          max={half}
          step={0.05}
          reset={0}
          onChange={(fadeOut) => put({ fadeOut: Math.min(half, Math.max(0, fadeOut)) })}
        />
      </div>
    </Card>
  )
}

/**
 * Кнопки внизу колонки: добавить эффект, обрезать, маска.
 *
 * Стоят над настройками сборки и нарочно неброские: раньше большая яркая
 * кнопка эффекта наверху колонки забирала на себя всё внимание.
 */
export function ClipAddBar({ clip }: { clip: ComposeClip }) {
  const partnerOf = useCompose((state) => state.partnerOf)
  useCompose((state) => state.tracks)
  const [picking, setPicking] = useState(false)
  const partner = partnerOf(clip.id)
  const visual = clip.kind === 'audio' ? partner : clip
  const sound = clip.kind === 'audio' ? clip : partner
  const parts: { clip: ComposeClip; target: EffectTarget }[] = []
  if (visual && targetOf(visual.kind)) parts.push({ clip: visual, target: 'video' })
  if (sound) parts.push({ clip: sound, target: 'audio' })
  const small =
    'flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-line-soft px-2 text-[11.5px] transition-colors'
  const idle = 'bg-surface-2 text-ink-dim hover:border-line hover:text-ink'
  return (
    <div className="flex gap-1.5">
      <button type="button" className={`${small} ${idle}`} onClick={() => setPicking(true)} title="Добавить эффект">
        <Plus size={13} />
        Добавить эффект
      </button>
      <EffectPicker open={picking} onClose={() => setPicking(false)} parts={parts} />
    </div>
  )
}

/** Свёрнута ли карточка — помним между запусками, по виду карточки. */
function useFolded(id: string): [boolean, (value: boolean) => void] {
  const key = `sgh.card.${id}`
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  return [
    folded,
    (value: boolean) => {
      setFolded(value)
      try {
        localStorage.setItem(key, value ? '1' : '0')
      } catch {
        /* не запомнилось — не беда */
      }
    },
  ]
}

/**
 * Карточка раздела: заголовок со стрелкой сворачивания, справа — действия.
 * Нажатие по карточке выбирает её группу ключей.
 */
function Card({
  id,
  title,
  icon,
  focusGroup,
  actions,
  tone = 'line',
  children,
}: {
  id: string
  title: string
  icon?: React.ReactNode
  focusGroup?: string
  actions?: React.ReactNode
  tone?: 'line' | 'warn' | 'accent'
  children: React.ReactNode
}) {
  const [folded, setFolded] = useFolded(id)
  const focus = useCompose((state) => state.animFocus)
  // Подсвечена карточка, чьи часики сейчас включены.
  const chosen = focusGroup !== undefined && focus === focusGroup
  const ring = chosen
    ? 'ring-accent/70'
    : tone === 'warn'
      ? 'ring-warn/35'
      : tone === 'accent'
        ? 'ring-accent/35'
        : 'ring-line-soft'
  return (
    <div className={`rounded-xl bg-surface-2 ring-1 ${ring}`}>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setFolded(!folded)}
          title={folded ? 'Развернуть' : 'Свернуть'}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronDown size={13} className={`shrink-0 text-ink-faint transition-transform ${folded ? '-rotate-90' : ''}`} />
          {icon && <span className="shrink-0 text-ink-faint">{icon}</span>}
          <span className="truncate text-[12.5px] font-medium text-ink">{title}</span>
        </button>
        {actions}
      </div>
      {!folded && <div className="space-y-2.5 border-t border-line-soft px-3 py-2.5">{children}</div>}
    </div>
  )
}

/** Отражение, поворот, скорость и «задом наперёд» — видно, что включено, и можно снять. */
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
 * Обрезка: сколько отрезано с каждой стороны, кнопка правки в кадре.
 *
 * Обрезка всегда держится на ключах: нажали «Обрезать» — под иглой встал
 * ключ. Один ключ — одна обрезка на весь клип. Поставили иглу в другое место
 * и поправили — там второй ключ, и между ними обрезка плавно меняется: так
 * подстраивают кадр под разные сцены.
 */
function CropCard({ clip }: { clip: ComposeClip }) {
  const playhead = useCompose((state) => state.playhead)
  const cropping = useCompose((state) => state.cropping)
  const setCropping = useCompose((state) => state.setCropping)
  const removeCrop = useCompose((state) => state.removeCrop)
  const applyValues = useCompose((state) => state.applyValues)
  const now = shownAt(clip, playhead)
  const used = isCropped(clip) || cropping === clip.id
  const side = (label: string, field: 'cropLeft' | 'cropTop' | 'cropRight' | 'cropBottom') => (
    <SliderNumber
      label={label}
      value={Math.round((now[field] ?? 0) * 1000) / 10}
      min={0}
      max={95}
      step={0.5}
      unit="%"
      reset={0}
      onChange={(value) => applyValues(clip.id, { [field]: value / 100 })}
    />
  )
  return (
    <Card
      id="crop"
      title="Обрезка"
      icon={<Crop size={13} />}
      focusGroup="crop"
      tone="accent"
      actions={
        used && (
        <>
          <AnimClock clip={clip} group="crop" />
          <button
            type="button"
            onClick={() => {
              if (cropping === clip.id) setCropping(null)
              removeCrop(clip.id)
            }}
            title="Убрать обрезку вместе с её ключами"
            className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-danger"
          >
            <X size={13} />
          </button>
        </>
        )
      }
    >
      {used && (
        <>
          {side('Слева', 'cropLeft')}
          {side('Сверху', 'cropTop')}
          {side('Справа', 'cropRight')}
          {side('Снизу', 'cropBottom')}
        </>
      )}
      {/* Обрезать — один раз, дальше рамка обрезки в кадре видна, пока
          горят часики карточки: отдельная кнопка «изменить» только путала. */}
      {!used && (
        <Button tone="subtle" className="w-full" onClick={() => setCropping(clip.id)}>
          <Crop size={14} />
          Обрезать в кадре
        </Button>
      )}
    </Card>
  )
}

/**
 * Маска: форма, что видно, где действуют эффекты, мягкость края.
 *
 * Два переключателя видимости — «внутри» и «снаружи»: включены оба — маска
 * ничего не прячет и нужна только эффектам; один — видна только эта часть.
 * Эффекты клипа можно оставить только внутри маски или только снаружи —
 * так размывают лицо, не заводя второй слой.
 */
function MaskCard({ clip, mask }: { clip: ComposeClip; mask: ClipMask | null }) {
  const updateClip = useCompose((state) => state.updateClip)
  const mark = useCompose((state) => state.mark)
  const masking = useCompose((state) => state.masking)
  const setMasking = useCompose((state) => state.setMasking)
  const removeMask = useCompose((state) => state.removeMask)
  const put = (patch: Partial<ClipMask>) => {
    if (!mask) return
    mark()
    updateClip(clip.id, { mask: { ...mask, ...patch } })
  }
  const effects = (clip.effects ?? []).some((effect) => effect.on)
  const playhead = useCompose((state) => state.playhead)
  const applyValues = useCompose((state) => state.applyValues)

  if (!mask) {
    // Маски ещё нет — карточка с одной кнопкой: так её место в колонке
    // постоянное, и добавлять её не нужно искать.
    return (
      <Card id="mask" title="Маска" icon={<SquareDashed size={13} />} tone="warn">
        <Button
          tone="subtle"
          className="w-full"
          onClick={() => {
            mark()
            updateClip(clip.id, { mask: newMask(clip) })
            setMasking(clip.id)
          }}
          title="Овал, прямоугольник или своя форма: показать только часть картинки или применить эффекты только к ней"
        >
          <SquareDashed size={14} />
          Добавить маску
        </Button>
      </Card>
    )
  }

  // Мягкость края — с ключами маски, поэтому показываем ту, что под иглой.
  const shown = shownAt(clip, playhead).mask ?? mask

  const choice = (
    label: string,
    value: string,
    options: { value: string; label: string; hint: string }[],
    onPick: (value: string) => void,
  ) => (
    <div className="space-y-1">
      <span className="block text-[11.5px] text-ink-dim">{label}</span>
      <div
        className="grid gap-1 rounded-lg bg-surface-3/40 p-0.5"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            title={option.hint}
            onClick={() => onPick(option.value)}
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
    <Card
      id="mask"
      title={mask.on ? 'Маска' : 'Маска (выключена)'}
      icon={<SquareDashed size={13} />}
      focusGroup="mask"
      tone="warn"
      actions={
        <>
          <input
            type="checkbox"
            checked={mask.on}
            title={mask.on ? 'Выключить маску — настройки останутся' : 'Включить маску'}
            onChange={(event) => put({ on: event.target.checked })}
            className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent)]"
          />
          <AnimClock clip={clip} group="mask" />
          <button
            type="button"
            onClick={() => removeMask(clip.id)}
            title="Убрать маску вместе с её ключами"
            className="rounded p-1 text-ink-faint hover:bg-surface-3 hover:text-danger"
          >
            <X size={13} />
          </button>
        </>
      }
    >
      <div className={`space-y-2.5 ${mask.on ? '' : 'opacity-50'}`}>
        {choice('Форма', mask.shape, [
          { value: 'ellipse', label: 'Овал', hint: 'Овал с мягким краем — для лица' },
          { value: 'rect', label: 'Прямоугольник', hint: 'Прямоугольник — для номера, надписи, угла кадра' },
          { value: 'custom', label: 'Своя', hint: 'Своя форма: ставьте точки прямо на картинке, замкните на первой' },
        ], (value) => {
          put({ shape: value as ClipMask['shape'] })
          // Своя форма рисуется в кадре — сразу туда.
          if (value === 'custom' && masking !== clip.id) setMasking(clip.id)
        })}
        {mask.shape === 'custom' && ((mask.points?.length ?? 0) >= 3 || (clip.anim?.[POINTS]?.length ?? 0) > 0) && (
          <button
            type="button"
            onClick={() => {
              // Заново — значит без прежних ключей формы.
              mark()
              updateClip(clip.id, {
                mask: { ...mask, points: [] },
                anim: withoutGroup(clip.anim, [POINTS]),
              })
              setMasking(clip.id)
            }}
            className="text-[11px] text-accent-soft hover:underline"
          >
            Нарисовать форму заново
          </button>
        )}
        {choice(
          'Что видно',
          mask.showInside && mask.showOutside ? 'all' : mask.showOutside ? 'outside' : 'inside',
          [
            { value: 'inside', label: 'Внутри', hint: 'Видно только то, что внутри маски' },
            { value: 'outside', label: 'Снаружи', hint: 'Видно всё, кроме того, что внутри маски' },
            { value: 'all', label: 'Всё', hint: 'Видно всё — маска нужна только эффектам (например, размыть лицо)' },
          ],
          (value) => put({ showInside: value !== 'outside', showOutside: value !== 'inside' }),
        )}
        {choice('Эффекты клипа действуют', mask.effectsArea, [
          { value: 'all', label: 'Везде', hint: 'Маска на эффекты не влияет' },
          { value: 'inside', label: 'Внутри', hint: 'Эффекты — только внутри маски: так размывают лицо или номер' },
          { value: 'outside', label: 'Снаружи', hint: 'Эффекты — везде, кроме маски' },
        ], (value) => put({ effectsArea: value as ClipMask['effectsArea'] }))}
        {mask.effectsArea !== 'all' && !effects && (
          <p className="text-[11px] leading-snug text-warn">
            У клипа нет эффектов — добавьте, например, размытие: оно подействует только там, где выбрано.
          </p>
        )}
        <SliderNumber
          stacked
          label="Мягкость края"
          value={Math.round(shown.feather * 100)}
          min={0}
          max={100}
          unit="%"
          reset={15}
          marks={[
            { value: 0, label: 'X', hint: 'резко' },
            { value: 15, label: 'M', hint: 'обычно' },
            { value: 50, label: 'H', hint: 'мягко' },
          ]}
          // Мягкость — часть ключей маски: часики у карточки.
          onChange={(next) => applyValues(clip.id, { 'mask.feather': next / 100 })}
        />
      </div>
    </Card>
  )
}

/**
 * Один эффект в колонке: заголовок с галочкой и крестиком, под ним ползунки.
 * Подсказок при наведении нет: настройки названы понятно, а всплывающие
 * описания мешали, пока подбираешь значение.
 */
function EffectCard({ clipId, effect }: { clipId: string; effect: ClipEffect }) {
  const updateEffect = useCompose((state) => state.updateEffect)
  const removeEffect = useCompose((state) => state.removeEffect)
  const mark = useCompose((state) => state.mark)
  const kind = effectKind(effect.type)
  const owner = useCompose((state) => state.findClip(clipId)?.clip)
  const playhead = useCompose((state) => state.playhead)
  const applyValues = useCompose((state) => state.applyValues)
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
            if (param.showIf) {
              const other = kind.params.find((item) => item.key === param.showIf!.key)
              const shown = effect.params[param.showIf.key] ?? other?.default
              if (String(shown) !== param.showIf.value) return null
            }
            if (param.kind === 'file') {
              const path = String(value || '')
              return (
                <div key={param.key} className="flex items-center gap-2" title={param.hint}>
                  <span className="shrink-0 text-[11.5px] text-ink-dim">{param.label}</span>
                  <span
                    className={`min-w-0 flex-1 truncate text-right font-mono text-[11px] ${path ? 'text-ink' : 'text-ink-faint'}`}
                    title={path || undefined}
                  >
                    {path ? path.split(/[\\/]/).pop() : 'не выбран'}
                  </span>
                  <Button
                    className="shrink-0 px-2 py-1 text-[11px]"
                    onClick={async () => {
                      const folder = path ? path.replace(/[\\/][^\\/]*$/, '') : null
                      const picked = await api.pickFile(folder, param.fileTypes)
                      if (picked.path) {
                        mark()
                        updateEffect(clipId, effect.id, { params: { [param.key]: picked.path } })
                      }
                    }}
                  >
                    Выбрать…
                  </Button>
                </div>
              )
            }
            if (param.kind === 'choice') {
              return (
                <div key={param.key} className="space-y-1">
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
            if (param.animatable && owner) {
              // Настройка, которая меняется по ключам: значение — то, что
              // под иглой, правка ложится в ключ, рядом часики.
              const field = `fx.${effect.id}.${param.key}`
              return (
                <div key={param.key}>
                  <SliderNumber
                    stacked
                    label={param.label}
                    value={valueAt(owner, field, playhead - owner.start)}
                    min={param.min ?? 0}
                    max={param.max ?? 100}
                    step={param.step}
                    unit={param.unit ?? ''}
                    reset={Number(param.default)}
                    marks={param.marks}
                    aside={<AnimClock clip={owner} group={field} />}
                    onChange={(next) => applyValues(clipId, { [field]: next })}
                  />
                </div>
              )
            }
            return (
              <div key={param.key}>
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
  exclude = [],
}: {
  open: boolean
  onClose: () => void
  /** Кому добавляем: клипу или дорожке — у обоих есть свой список эффектов. */
  parts: { clip: Pick<ComposeClip, 'id' | 'effects'>; target: EffectTarget }[]
  /** Эффекты, которых здесь не предлагать. */
  exclude?: string[]
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
                {EFFECTS.filter((effect) => effect.target === group.target && !exclude.includes(effect.type)).map((effect) => (
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
