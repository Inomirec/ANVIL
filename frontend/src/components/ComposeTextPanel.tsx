import { useEffect, useState } from 'react'
import { Bold, Italic } from 'lucide-react'
import { api } from '../lib/api'
import { TEXT_DEFAULTS, useCompose, type ComposeClip } from '../composeStore'
import { Modal, Section, Segmented, Slider, Toggle } from './ui'

/**
 * Настройки надписи.
 *
 * Открывается значком на самом клипе: панели свойств во вкладке нет, а
 * настроек у текста много — шрифт, начертание, обводка, тень, подложка. Пока
 * окно открыто, правки видны сразу в кадре под иглой: цвет и размер на слух
 * не подберёшь, их выбирают глазами.
 *
 * Размеры задаются долями высоты кадра, а не пикселями. Тот же монтаж,
 * собранный в 1080p вместо 720p, должен выглядеть так же — иначе субтитры,
 * подобранные на черновике, в готовом файле оказались бы втрое мельче.
 */
interface FontRow {
  name: string
  bold: boolean
  italic: boolean
}

/** Поле выбора цвета: рядом с кружком написано, что именно он красит. */
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 w-10 shrink-0 cursor-pointer rounded-md border border-line-soft bg-surface-2 p-0.5"
      />
      <span className="text-[12px] text-ink-dim">{label}</span>
      <span className="ml-auto font-mono text-[11px] uppercase text-ink-faint">{value}</span>
    </label>
  )
}

export function ComposeTextPanel({
  clip,
  onClose,
}: {
  clip: ComposeClip | null
  onClose: () => void
}) {
  const updateClip = useCompose((state) => state.updateClip)
  const height = useCompose((state) => state.height)
  const [fonts, setFonts] = useState<FontRow[] | null>(null)

  useEffect(() => {
    if (!clip || fonts) return
    let alive = true
    api
      .fonts()
      .then((data) => {
        if (alive) setFonts(data.fonts)
      })
      .catch(() => {
        // Без списка шрифтов панель всё равно работает: программа возьмёт
        // тот шрифт, что найдётся, и надпись нарисуется.
        if (alive) setFonts([])
      })
    return () => {
      alive = false
    }
  }, [clip, fonts])

  if (!clip) return null

  const put = (patch: Partial<ComposeClip>) => updateClip(clip.id, patch)
  const at = <K extends keyof typeof TEXT_DEFAULTS>(key: K): (typeof TEXT_DEFAULTS)[K] =>
    (clip[key as keyof ComposeClip] as (typeof TEXT_DEFAULTS)[K]) ?? TEXT_DEFAULTS[key]

  const family = fonts?.find((item) => item.name === at('font'))
  // Кегль показываем в пикселях нынешнего кадра: доли высоты человеку ничего
  // не говорят, а «48 px» — привычная мера.
  const pixels = Math.round(height * at('fontSize'))

  return (
    <Modal open onClose={onClose} title="Надпись" wide>
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-4">
          <div>
            <span className="label">Текст</span>
            <textarea
              className="field min-h-[86px] resize-y leading-snug"
              value={at('text')}
              autoFocus
              onChange={(event) => put({ text: event.target.value, name: event.target.value })}
              placeholder="Что написать"
            />
            <p className="mt-1 text-[11px] leading-snug text-ink-faint">
              Перевод строки сохраняется — так набирают субтитры в две строки.
            </p>
          </div>

          <div>
            <span className="label">Шрифт</span>
            <div className="flex items-center gap-2">
              <select
                className="field cursor-pointer"
                value={at('font')}
                onChange={(event) => put({ font: event.target.value })}
              >
                {!fonts && <option>Читаю список…</option>}
                {fonts?.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
              {/* Жирный и курсив — это отдельные файлы шрифта. Если у семейства
                  их нет, кнопка выключена: просить у программы то, чего в
                  шрифте не нарисовано, бессмысленно. */}
              <button
                type="button"
                title={family && !family.bold ? 'У этого шрифта нет жирного начертания' : 'Жирный'}
                disabled={Boolean(family && !family.bold)}
                onClick={() => put({ bold: !at('bold') })}
                className={`flex h-[34px] w-9 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-35 ${
                  at('bold')
                    ? 'border-accent bg-accent/20 text-accent-soft'
                    : 'border-line-soft text-ink-dim hover:text-ink'
                }`}
              >
                <Bold size={14} />
              </button>
              <button
                type="button"
                title={family && !family.italic ? 'У этого шрифта нет курсива' : 'Курсив'}
                disabled={Boolean(family && !family.italic)}
                onClick={() => put({ italic: !at('italic') })}
                className={`flex h-[34px] w-9 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-35 ${
                  at('italic')
                    ? 'border-accent bg-accent/20 text-accent-soft'
                    : 'border-line-soft text-ink-dim hover:text-ink'
                }`}
              >
                <Italic size={14} />
              </button>
            </div>
          </div>

          <Slider
            label="Размер букв"
            value={Math.round(at('fontSize') * 1000)}
            min={15}
            max={300}
            step={1}
            suffix={` (${pixels} px в этом кадре)`}
            onChange={(value) => put({ fontSize: value / 1000 })}
          />

          <ColorField
            label="Цвет букв"
            value={at('textColor')}
            onChange={(value) => put({ textColor: value })}
          />

          <div>
            <span className="label">Строки между собой</span>
            <Segmented<'left' | 'center' | 'right'>
              value={at('align')}
              onChange={(value) => put({ align: value })}
              options={[
                { value: 'left', label: 'Слева' },
                { value: 'center', label: 'По центру' },
                { value: 'right', label: 'Справа' },
              ]}
            />
          </div>

          <Slider
            label="Расстояние между строками"
            value={Math.round(at('lineSpacing') * 100)}
            min={-30}
            max={120}
            step={5}
            suffix="%"
            onChange={(value) => put({ lineSpacing: value / 100 })}
          />
        </div>

        <div className="space-y-4">
          <Section title="Обводка">
            <Slider
              label="Толщина"
              value={Math.round(at('stroke') * 1000)}
              min={0}
              max={40}
              step={1}
              suffix={at('stroke') > 0 ? ` (${Math.round(height * at('stroke'))} px)` : ' — без обводки'}
              onChange={(value) => put({ stroke: value / 1000 })}
            />
            <ColorField
              label="Цвет обводки"
              value={at('strokeColor')}
              onChange={(value) => put({ strokeColor: value })}
            />
            <p className="text-[11px] leading-snug text-ink-faint">
              Тонкая тёмная обводка — то, чем субтитры держатся на светлом кадре:
              без неё белые буквы пропадают на небе и снегу.
            </p>
          </Section>

          <Section title="Тень">
            <Slider
              label="Сдвиг вправо"
              value={Math.round(at('shadowX') * 1000)}
              min={-40}
              max={40}
              step={1}
              onChange={(value) => put({ shadowX: value / 1000 })}
            />
            <Slider
              label="Сдвиг вниз"
              value={Math.round(at('shadowY') * 1000)}
              min={-40}
              max={40}
              step={1}
              onChange={(value) => put({ shadowY: value / 1000 })}
            />
            <Slider
              label="Насколько видна"
              value={Math.round(at('shadowAlpha') * 100)}
              min={0}
              max={100}
              step={5}
              suffix="%"
              onChange={(value) => put({ shadowAlpha: value / 100 })}
            />
            <ColorField
              label="Цвет тени"
              value={at('shadowColor')}
              onChange={(value) => put({ shadowColor: value })}
            />
          </Section>

          <Section title="Подложка">
            <Toggle
              checked={at('box')}
              onChange={(value) => put({ box: value })}
              label="Плашка за буквами"
              hint="Нужна на пёстром кадре, где не спасает даже обводка."
            />
            {at('box') && (
              <>
                <ColorField
                  label="Цвет плашки"
                  value={at('boxColor')}
                  onChange={(value) => put({ boxColor: value })}
                />
                <Slider
                  label="Насколько видна"
                  value={Math.round(at('boxAlpha') * 100)}
                  min={0}
                  max={100}
                  step={5}
                  suffix="%"
                  onChange={(value) => put({ boxAlpha: value / 100 })}
                />
                <Slider
                  label="Отступ от букв"
                  value={Math.round(at('boxPad') * 1000)}
                  min={0}
                  max={80}
                  step={2}
                  onChange={(value) => put({ boxPad: value / 1000 })}
                />
              </>
            )}
          </Section>
        </div>
      </div>
    </Modal>
  )
}
