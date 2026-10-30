import { effectKind } from './composeEffects'
import type { ClipMask, ComposeClip } from './composeStore'

/**
 * Ключи анимации: у каждого показателя клипа — свой список ключей.
 *
 * Показатель — одно число клипа: место (`x`, `y`), размер (`size`, `sizeY`),
 * обрезка (`cropLeft`…), маска (`mask.x`…), настройка эффекта
 * (`fx.<номер эффекта>.<настройка>`). Те же имена у сервера (`core/anim.py`).
 *
 * Человек видит не показатели, а группы: «Положение» — это x и y, «Обрезка»
 * — четыре края. Часики у группы включают ключи сразу для всех её
 * показателей, и ключ ставится на все сразу, в одно время.
 *
 * Ключ — время от начала клипа на таймлайне и значение. Между ключами —
 * плавный разгон и торможение (`3s² − 2s³`), как у сервера: иначе рамка в
 * кадре и собранный кадр расходились бы.
 */

export interface AnimKey {
  t: number
  v: number
  /** Точки своей формы маски — у показателя `mask.points` вместо числа. */
  p?: [number, number][]
  /** Как идёт переход от этого ключа к следующему; нет — плавно. */
  e?: Ease
}

/** Виды перехода между ключами — те же, что на сервере (`anim.EASES`). */
export type Ease = 'linear' | 'fast' | 'slow' | 'smooth' | 'sharp' | 'hold'
export const EASES: { value: Ease; label: string; hint: string }[] = [
  { value: 'linear', label: 'Linear', hint: 'Ровно, с одной скоростью от ключа до ключа' },
  { value: 'fast', label: 'Fast', hint: 'Резко трогается и плавно приходит' },
  { value: 'slow', label: 'Slow', hint: 'Плавно трогается и резко приходит' },
  { value: 'smooth', label: 'Smooth', hint: 'Плавный разгон и плавное торможение — обычный переход' },
  { value: 'sharp', label: 'Sharp', hint: 'Сильный разгон и сильное торможение: середину проскакивает быстро' },
  { value: 'hold', label: 'Hold', hint: 'Стоит на месте до следующего ключа и меняется на нём скачком' },
]

/** Доля пути `s` (0…1) по кривой перехода. */
export function ease(kind: Ease | undefined, s: number): number {
  const x = Math.min(1, Math.max(0, s))
  switch (kind) {
    case 'linear':
      return x
    case 'fast':
      return 1 - (1 - x) * (1 - x)
    case 'slow':
      return x * x
    case 'sharp':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(2 - 2 * x, 3) / 2
    case 'hold':
      return 0
    default:
      return x * x * (3 - 2 * x)
  }
}

/** Значение показателя: число, а у точек своей формы — список точек. */
export type AnimValue = number | [number, number][]

export const POINTS = 'mask.points'

export type Anim = Record<string, AnimKey[]>

/**
 * Насколько близко к ключу считается «на ключе». Меньше половины кадра даже
 * при 60 кадрах в секунду: иначе правка на соседнем кадре переписывала
 * прежний ключ вместо того, чтобы поставить новый, — а ключи на смене сцены
 * как раз ставят кадр в кадр.
 */
export const KEY_NEAR = 0.008

export interface AnimGroup {
  id: string
  label: string
  fields: string[]
  /** Ключ ставится сам при первой же правке — без часиков. Так у обрезки и
   *  маски: нажал «Обрезать» — на таймлайне появился ключ. */
  auto?: boolean
}

export const CROP_FIELDS = ['cropLeft', 'cropTop', 'cropRight', 'cropBottom']
export const MASK_FIELDS = ['mask.x', 'mask.y', 'mask.w', 'mask.h', 'mask.feather']

/** Какие группы есть у клипа — от вида клипа, маски и эффектов. */
export function groupsOf(clip: ComposeClip): AnimGroup[] {
  const groups: AnimGroup[] = []
  const visual = clip.kind === 'video' || clip.kind === 'image'
  if (visual || clip.kind === 'text' || clip.kind === 'color') {
    groups.push({ id: 'position', label: 'Положение', fields: ['x', 'y'] })
  }
  if (visual || clip.kind === 'color') {
    groups.push({ id: 'size', label: 'Размер', fields: ['size', 'sizeY'] })
  }
  if (clip.kind === 'text') groups.push({ id: 'fontSize', label: 'Размер текста', fields: ['fontSize'] })
  if (clip.kind !== 'audio') groups.push({ id: 'opacity', label: 'Непрозрачность', fields: ['opacity'] })
  if (visual) groups.push({ id: 'crop', label: 'Обрезка', fields: CROP_FIELDS, auto: true })
  // Маска — и у заливки: так ей дают сложную форму.
  if ((visual || clip.kind === 'color') && clip.mask) {
    // У своей формы по ключам меняются и сами точки — форма может меняться.
    const fields = clip.mask.shape === 'custom' ? [...MASK_FIELDS, POINTS] : MASK_FIELDS
    groups.push({ id: 'mask', label: 'Маска', fields, auto: true })
  }
  for (const effect of clip.effects ?? []) {
    const kind = effectKind(effect.type)
    for (const param of kind?.params ?? []) {
      if (!param.animatable) continue
      groups.push({
        id: `fx.${effect.id}.${param.key}`,
        label: `${kind!.name}: ${param.label.toLowerCase()}`,
        fields: [`fx.${effect.id}.${param.key}`],
      })
    }
  }
  return groups
}

export function groupOf(clip: ComposeClip, id: string | null | undefined): AnimGroup | undefined {
  return id ? groupsOf(clip).find((group) => group.id === id) : undefined
}

/** Значение показателя без ключей — то, что записано в самом клипе. */
export function fieldValue(clip: ComposeClip, field: string): number {
  if (field.startsWith('mask.')) {
    const value = clip.mask?.[field.slice(5) as keyof ClipMask]
    return typeof value === 'number' ? value : 0
  }
  if (field.startsWith('fx.')) {
    const [, id, param] = field.split('.')
    const effect = (clip.effects ?? []).find((item) => item.id === id)
    const kind = effect && effectKind(effect.type)
    const raw = effect?.params[param] ?? kind?.params.find((item) => item.key === param)?.default ?? 0
    return Number(raw) || 0
  }
  const value = (clip as unknown as Record<string, unknown>)[field]
  if (typeof value === 'number') return value
  // Без записанного значения — умолчания клипа, а не ноль: иначе первый
  // ключ сделал бы надпись невидимо мелкой, а клип — прозрачным.
  return field === 'fontSize' ? 0.07 : field === 'opacity' ? 1 : 0
}

function sorted(clip: ComposeClip, field: string): AnimKey[] {
  return [...(clip.anim?.[field] ?? [])].sort((a, b) => a.t - b.t)
}

function rawAt(clip: ComposeClip, field: string, local: number): number {
  let keys = sorted(clip, field)
  if (!keys.length) return fieldValue(clip, field)
  // Высота «как ширина» (ноль) у одного из ключей — берём размер в тот же
  // миг, как и сервер; иначе высота съезжала бы к нулю между ключами.
  if (field === 'sizeY' && keys.some((key) => key.v > 0) && keys.some((key) => key.v <= 0)) {
    keys = keys.map((key) => (key.v > 0 ? key : { ...key, v: rawAt(clip, 'size', key.t) }))
  }
  if (local <= keys[0].t) return keys[0].v
  for (let index = 0; index < keys.length - 1; index++) {
    const left = keys[index]
    const right = keys[index + 1]
    if (local < right.t) {
      const s = (local - left.t) / Math.max(right.t - left.t, 1e-3)
      return left.v + (right.v - left.v) * ease(left.e, s)
    }
  }
  return keys[keys.length - 1].v
}

/** Значение показателя через `local` секунд от начала клипа. */
export function valueAt(clip: ComposeClip, field: string, local: number): number {
  const value = rawAt(clip, field, local)
  // Высота «как ширина» — ноль: сама по себе она не меняется.
  if (field === 'sizeY' && value <= 0) return 0
  return value
}

/** Точки своей формы маски через `local` секунд — плавно между ключами. */
export function pointsAt(clip: ComposeClip, local: number): [number, number][] {
  const keys = sorted(clip, POINTS).filter((key) => key.p)
  if (!keys.length) return clip.mask?.points ?? []
  if (local <= keys[0].t) return keys[0].p!
  for (let index = 0; index < keys.length - 1; index++) {
    const left = keys[index]
    const right = keys[index + 1]
    if (local < right.t) {
      const a = left.p!
      const b = right.p!
      // Число точек разное — форма меняется скачком на ключе.
      if (a.length !== b.length) return a
      const s = (local - left.t) / Math.max(right.t - left.t, 1e-3)
      const e = ease(left.e, s)
      return a.map(([x, y], i) => [x + (b[i][0] - x) * e, y + (b[i][1] - y) * e])
    }
  }
  return keys[keys.length - 1].p!
}

/** Значение показателя под иглой — число или точки. */
export function anyAt(clip: ComposeClip, field: string, local: number): AnimValue {
  return field === POINTS ? pointsAt(clip, local) : valueAt(clip, field, local)
}

export function isKeyed(clip: ComposeClip, group: AnimGroup): boolean {
  return group.fields.some((field) => (clip.anim?.[field]?.length ?? 0) > 0)
}

/** Есть ли у клипа ключи хоть у чего-то. */
export function hasKeys(clip: ComposeClip): boolean {
  return Object.values(clip.anim ?? {}).some((keys) => keys.length > 0)
}

export function hasPlaceKeys(clip: ComposeClip): boolean {
  return ['x', 'y', 'size', 'sizeY'].some((field) => (clip.anim?.[field]?.length ?? 0) > 0)
}

/** Времена ключей группы, без повторов. */
export function keyTimes(clip: ComposeClip, group: AnimGroup): number[] {
  const times: number[] = []
  for (const field of group.fields) {
    for (const key of clip.anim?.[field] ?? []) {
      if (!times.some((t) => Math.abs(t - key.t) < KEY_NEAR / 2)) times.push(key.t)
    }
  }
  return times.sort((a, b) => a - b)
}

/** Клип с записанными в него значениями — место, обрезка, маска, эффекты. */
export function withValues(clip: ComposeClip, values: Record<string, AnimValue>): ComposeClip {
  let next: ComposeClip = { ...clip }
  for (const [field, value] of Object.entries(values)) {
    if (field.startsWith('mask.')) {
      if (next.mask) next = { ...next, mask: { ...next.mask, [field.slice(5)]: value } }
    } else if (field.startsWith('fx.')) {
      if (typeof value !== 'number') continue
      const [, id, param] = field.split('.')
      next = {
        ...next,
        effects: (next.effects ?? []).map((effect) =>
          effect.id === id ? { ...effect, params: { ...effect.params, [param]: value } } : effect,
        ),
      }
    } else {
      next = { ...next, [field]: value }
    }
  }
  return next
}

/** Значения показателей группы под иглой. */
export function groupValues(clip: ComposeClip, group: AnimGroup, local: number): Record<string, AnimValue> {
  return Object.fromEntries(group.fields.map((field) => [field, anyAt(clip, field, local)]))
}

/**
 * Клип таким, каким он стоит под иглой: для рамок в окне просмотра и полей
 * в колонке. У показателей с ключами берётся значение в этот миг.
 */
export function shownAt(clip: ComposeClip, playhead: number): ComposeClip {
  if (!hasKeys(clip)) return clip
  const local = playhead - clip.start
  const values: Record<string, AnimValue> = {}
  for (const [field, keys] of Object.entries(clip.anim ?? {})) {
    if (keys.length) values[field] = anyAt(clip, field, local)
  }
  return withValues(clip, values)
}

/** Ключи с поставленным ключом группы в момент `local` (или заменённым рядом). */
export function withKey(clip: ComposeClip, group: AnimGroup, local: number, values: Record<string, AnimValue>): Anim {
  const anim: Anim = { ...(clip.anim ?? {}) }
  const times = keyTimes(clip, group)
  const near = times.find((t) => Math.abs(t - local) < KEY_NEAR)
  const at = near ?? local
  for (const field of group.fields) {
    const value = values[field] ?? anyAt(clip, field, local)
    const rest = (anim[field] ?? []).filter((key) => Math.abs(key.t - at) >= KEY_NEAR / 2)
    // Переписанный ключ сохраняет свой вид перехода.
    const was = (anim[field] ?? []).find((key) => Math.abs(key.t - at) < KEY_NEAR / 2)?.e
    const key: AnimKey = Array.isArray(value) ? { t: at, v: 0, p: value } : { t: at, v: value }
    if (was) key.e = was
    anim[field] = [...rest, key].sort((a, b) => a.t - b.t)
  }
  return anim
}

/** Ключи без ключа группы у `local`; `null` — ключа там нет. */
export function withoutKey(clip: ComposeClip, group: AnimGroup, local: number): Anim | null {
  const near = keyTimes(clip, group).find((t) => Math.abs(t - local) < KEY_NEAR)
  if (near === undefined) return null
  const anim: Anim = { ...(clip.anim ?? {}) }
  for (const field of group.fields) {
    anim[field] = (anim[field] ?? []).filter((key) => Math.abs(key.t - near) >= KEY_NEAR / 2)
    if (!anim[field].length) delete anim[field]
  }
  return anim
}

/** Ключи без всей группы. */
export function withoutGroup(anim: Anim | undefined, fields: string[]): Anim {
  const next: Anim = { ...(anim ?? {}) }
  for (const field of fields) delete next[field]
  return next
}

/** Ключи без показателей, чьё имя начинается с `prefix` (убрали эффект, маску). */
export function withoutPrefix(anim: Anim | undefined, prefix: string): Anim {
  return Object.fromEntries(Object.entries(anim ?? {}).filter(([field]) => !field.startsWith(prefix)))
}

/**
 * Ключи после правки клипа, так чтобы они остались на тех же кадрах ролика.
 *
 * Кадр ролика — это `sourceIn + t * speed`; обрезали левый край или
 * поменяли скорость — `t` пересчитывается под новые `sourceIn` и `speed`. У
 * картинки своих кадров нет — ключи держатся за время таймлайна: сдвинулось
 * начало — сдвигаются и они.
 */
export function rekey(
  clip: ComposeClip,
  next: { start: number; sourceIn: number; speed: number },
): Anim | undefined {
  if (!clip.anim || !hasKeys(clip)) return clip.anim
  const move =
    clip.kind === 'video'
      ? (t: number) => (clip.sourceIn + t * (clip.speed ?? 1) - next.sourceIn) / next.speed
      : (t: number) => t - (next.start - clip.start)
  return Object.fromEntries(
    Object.entries(clip.anim).map(([field, keys]) => [field, keys.map((key) => ({ ...key, t: move(key.t) }))]),
  )
}
