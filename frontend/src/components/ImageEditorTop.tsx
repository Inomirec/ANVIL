import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Brush,
  Crop,
  Eraser,
  FlipHorizontal2,
  ListX,
  Maximize2,
  MousePointer2,
  PaintBucket,
  Pipette,
  RotateCwSquare,
  SquareDashedMousePointer,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react'
import { mediaUrl } from '../lib/api'
import { noStraySelection } from '../lib/noSelect'
import { humanSize } from '../lib/format'
import { clientToShare, orientTransform, sideways, type Orient } from '../lib/orient'
import type { FileInfo, ImagePreview, Rect, Stroke } from '../lib/types'
import { RectCanvas, type Selection, type Tool } from './RectCanvas'
import { ImageTexts, readTextStyle, type ImageTextMark } from './ImageTexts'
import { ColorButton } from './ColorPicker'

export interface ImageEdit {
  crop: Rect | null
  boxes: Rect[]
  /** Мазки кистью и ластиком — для надписей, которые не влезают в прямоугольник. */
  strokes: Stroke[]
  /** Надписи поверх картинки. */
  texts: ImageTextMark[]
  /** Поворот и отражение — после правок и обрезки. */
  rotate?: Orient['rotate']
  flipH?: boolean
}

export const emptyImageEdit: ImageEdit = { crop: null, boxes: [], strokes: [], texts: [], rotate: 0, flipH: false }

/** Что выбрано на картинке — его настройки показывает колонка справа. */
export type ImageFocus = { type: 'text'; index: number } | { type: 'box'; index: number } | null

type ToolInfo = { value: Tool; label: string; hint: string; icon: typeof Brush }

/** Обычные инструменты. Курсор первым, как в редакторах: с него начинают. */
const TOOLS: ToolInfo[] = [
  { value: 'view', label: 'Курсор', hint: 'просто смотреть, ничего не рисуя', icon: MousePointer2 },
  { value: 'brush', label: 'Кисть', hint: 'закрасить от руки, для надписей дугой и наискось', icon: Brush },
  { value: 'eraser', label: 'Ластик', hint: 'стереть лишнее, что закрасили кистью', icon: Eraser },
  { value: 'crop', label: 'Обрезать', hint: 'отрезать пустые поля и чёрные края', icon: Crop },
  { value: 'select', label: 'Выделить', hint: 'обвести область и убрать всё лишнее разом', icon: SquareDashedMousePointer },
  { value: 'pick', label: 'Пипетка', hint: 'взять цвет прямо с картинки', icon: Pipette },
]

/** Объекты со своими настройками в колонке справа — как в монтаже. */
const OBJECT_TOOLS: ToolInfo[] = [
  { value: 'box', label: 'Заливка', hint: 'прямоугольник: бренд, надпись, спойлер. Настройки — в колонке справа', icon: PaintBucket },
  { value: 'text', label: 'Текст', hint: 'надпись на картинке: нажмите, где она должна стоять. Настройки — в колонке справа', icon: Type },
]

/** Ключ запомненного цвета закраски. */
export const COLOR_KEY = 'sgh.paintColor'

/** Пределы приближения: отдалить — до половины, приблизить — в 16 раз. */
const ZOOM_MIN = 0.5
const ZOOM_MAX = 16

/** Кнопка панели инструментов: все одного размера, чтобы панель была ровной. */
function ToolButton({
  active = false,
  danger = false,
  disabled = false,
  title,
  onClick,
  children,
}: {
  active?: boolean
  danger?: boolean
  disabled?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title.split(' — ')[0]}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-30 disabled:hover:bg-transparent ${
        active
          ? 'bg-accent-strong text-white'
          : `text-ink-faint hover:bg-surface-3 ${danger ? 'hover:text-danger' : 'hover:text-ink-dim'}`
      }`}
    >
      {children}
    </button>
  )
}

/** Группа кнопок — одной плашкой, все группы одинаковой высоты. */
function ToolGroup({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg bg-surface-2 px-0.5 ring-1 ring-line-soft">
      {children}
    </span>
  )
}

/**
 * Просмотр и правка изображения.
 *
 * Маски и рамка обрезки — редактируемые объекты: их двигают, растягивают за
 * стороны и углы, удаляют клавишей Delete и откатывают через Ctrl+Z.
 */
export function ImageEditor({
  file,
  edit,
  preview,
  onEditChange,
  onFocusChange,
  commitRef,
}: {
  file: FileInfo
  edit: ImageEdit
  /** Просчитанный результат сжатия — то, что покажет кнопка «После». */
  preview?: ImagePreview | null
  onEditChange: (edit: ImageEdit) => void
  /** Выбрали надпись или заливку — колонка справа покажет её настройки. */
  onFocusChange?: (focus: ImageFocus) => void
  /** Сюда редактор кладёт «запомнить для Ctrl+Z» — им пользуется колонка. */
  commitRef?: React.MutableRefObject<(() => void) | null>
}) {
  const [showAfter, setShowAfter] = useState(false)
  const [tool, setTool] = useState<Tool>('box')
  const [selection, setSelection] = useState<Selection>(null)
  const [history, setHistory] = useState<ImageEdit[]>([])
  const [brushSize, setBrushSize] = useState(40)
  const [paintColor, setPaintColor] = useState(
    () => localStorage.getItem(COLOR_KEY) || '#000000',
  )
  // Что обвели рамкой выделения: номера масок и мазков.
  const [marked, setMarked] = useState<{ boxes: number[]; strokes: number[] }>({
    boxes: [],
    strokes: [],
  })
  // Меню по правой кнопке над маской.
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)

  // Надписи: какая выбрана и какая только что поставлена.
  const texts = edit.texts ?? []
  const [textSel, setTextSel] = useState<number | null>(null)
  const [freshText, setFreshText] = useState<number | null>(null)
  // Точек окна на пиксель оригинала: по нему растут буквы надписей.
  const [scale, setScale] = useState(1)
  const [, setViewport] = useState(0)

  // Масштаб и сдвиг картинки. Сдвиг — в экранных пикселях: так его проще
  // удержать, когда масштаб меняется прямо под курсором.
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const spaceRef = useRef(false)
  const panRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  // Обработчик колеса живёт вне React, поэтому текущие значения берём из ссылок.
  const viewRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } })
  viewRef.current = { zoom, pan }

  const media = file.media
  const natural = { width: media?.width ?? 0, height: media?.height ?? 0 }
  const orient: Orient = { rotate: edit.rotate ?? 0, flipH: edit.flipH ?? false }
  const turned = sideways(orient)

  const resetView = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    setTool('box')
    setSelection(null)
    setHistory([])
    resetView()
    setShowAfter(false)
    setMenu(null)
    setMarked({ boxes: [], strokes: [] })
    setTextSel(null)
    setFreshText(null)
  }, [file.path, resetView])

  // Ширина сцены — по ней ужимается картинка, повёрнутая боком.
  const [stageWidth, setStageWidth] = useState(0)
  useLayoutEffect(() => {
    const image = imageRef.current
    if (image && natural.width && image.offsetWidth) {
      const next = image.offsetWidth / natural.width
      if (Math.abs(next - scale) > 1e-4) setScale(next)
    }
    const stage = viewportRef.current
    if (stage && Math.abs(stage.clientWidth - stageWidth) > 1) setStageWidth(stage.clientWidth)
  })
  // Окно поменяло размер — картинка тоже, а с ней и буквы.
  useEffect(() => {
    const onResize = () => setViewport((value) => value + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Ушли с инструмента — надпись больше не выбрана.
  useEffect(() => {
    if (tool !== 'text') setTextSel(null)
  }, [tool])

  // Колонке справа — что выбрано сейчас.
  const focusText = textSel !== null && texts[textSel] ? textSel : null
  const focusBox = selection?.type === 'box' && edit.boxes[selection.index] ? selection.index : null
  useEffect(() => {
    onFocusChange?.(
      focusText !== null
        ? { type: 'text', index: focusText }
        : focusBox !== null
          ? { type: 'box', index: focusBox }
          : null,
    )
  }, [focusText, focusBox, onFocusChange])
  useEffect(() => () => onFocusChange?.(null), [onFocusChange])
  // Цвет заливки меняют в колонке справа — следующая встанет того же цвета.
  useEffect(() => {
    if (focusBox === null) setPaintColor((was) => localStorage.getItem(COLOR_KEY) || was)
  }, [focusBox])

  /** Правка надписи. */
  const patchText = useCallback(
    (index: number, patch: Partial<ImageTextMark>) => {
      onEditChange({
        ...edit,
        texts: texts.map((mark, i) => (i === index ? { ...mark, ...patch } : mark)),
      })
    },
    [edit, texts, onEditChange],
  )

  const applyColor = useCallback((color: string) => {
    setPaintColor(color)
    localStorage.setItem(COLOR_KEY, color)
  }, [])

  /** Точка окна → пиксели оригинала, с учётом приближения и поворота. */
  const toImage = useCallback(
    (clientX: number, clientY: number) => {
      const layer = overlayRef.current
      if (!layer || !natural.width) return null
      const share = clientToShare(layer, clientX, clientY, orient)
      return share && { x: share.u * natural.width, y: share.v * natural.height }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [natural.width, natural.height, orient.rotate, orient.flipH],
  )

  /** Пипетка: берёт цвет ровно того пикселя, по которому щёлкнули. */
  const pickColor = useCallback(
    (point: { x: number; y: number }) => {
      const image = imageRef.current
      if (!image || !image.naturalWidth) return
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      ctx.drawImage(image, 0, 0)
      const x = Math.max(0, Math.min(Math.round(point.x), canvas.width - 1))
      const y = Math.max(0, Math.min(Math.round(point.y), canvas.height - 1))
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data
      const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
      applyColor(hex)
      setTool('box')
    },
    [applyColor],
  )

  useEffect(() => {
    if (!preview) setShowAfter(false)
  }, [preview])

  // Ушли с выделения — снимаем его: номера объектов после правок сдвигаются,
  // и «убрать выделенное» удалило бы не то.
  useEffect(() => {
    if (tool !== 'select') setMarked({ boxes: [], strokes: [] })
  }, [tool])

  // Колесо приближает к курсору, а не к центру: иначе нужная деталь уезжает
  // за край ровно в тот момент, когда её пытаешься рассмотреть. Отдаляется
  // до половины — чтобы окинуть взглядом высокую картинку целиком.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = viewport.getBoundingClientRect()
      // Курсор относительно центра: вокруг него и построено преобразование.
      const mx = event.clientX - (box.left + box.width / 2)
      const my = event.clientY - (box.top + box.height / 2)

      const { zoom: current, pan: offset } = viewRef.current
      let next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current * (event.deltaY < 0 ? 1.2 : 1 / 1.2)))
      // Через обычный размер не проскакиваем: на нём удобно остановиться.
      if ((current < 1 && next > 1) || (current > 1 && next < 1)) next = 1
      if (next === current) return
      const ratio = next / current

      setZoom(next)
      // Мельче обычного картинка стоит посередине: двигать её незачем.
      setPan(
        next <= 1
          ? { x: 0, y: 0 }
          : { x: mx - ratio * (mx - offset.x), y: my - ratio * (my - offset.y) },
      )
    }

    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [])

  // Пробел — временный режим руки: левая кнопка занята кистью и рамками.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return
      if (event.code !== 'Space') return
      // Иначе пробел нажмёт кнопку, на которой остался фокус, и прокрутит страницу.
      event.preventDefault()
      spaceRef.current = true
      setSpaceHeld(true)
    }
    const up = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return
      spaceRef.current = false
      setSpaceHeld(false)
    }
    // Переключение окна оставляет пробел «залипшим» — сбрасываем.
    const blur = () => {
      spaceRef.current = false
      setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  useEffect(() => {
    if (!panning) return
    const move = (event: PointerEvent) => {
      const start = panRef.current
      if (!start) return
      setPan({ x: start.px + (event.clientX - start.x), y: start.py + (event.clientY - start.y) })
    }
    const stop = () => {
      panRef.current = null
      setPanning(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [panning])

  const startPan = (event: React.PointerEvent) => {
    // Средняя кнопка — всегда рука, левая — только с зажатым пробелом.
    if (event.button !== 1 && !(event.button === 0 && spaceRef.current)) return
    event.preventDefault()
    event.stopPropagation()
    panRef.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y }
    setPanning(true)
  }

  /** Запоминает текущее состояние, чтобы Ctrl+Z вернул именно его. */
  const commit = useCallback(() => {
    setHistory((current) => [...current.slice(-40), edit])
  }, [edit])
  if (commitRef) commitRef.current = commit

  const undo = useCallback(() => {
    setHistory((current) => {
      if (!current.length) return current
      onEditChange(current[current.length - 1])
      setSelection(null)
      return current.slice(0, -1)
    })
  }, [onEditChange])

  /** Убирает выбранное: надпись, маску или рамку обрезки. */
  const removeSelected = useCallback(() => {
    if (focusText !== null) {
      commit()
      onEditChange({ ...edit, texts: texts.filter((_, i) => i !== focusText) })
      setTextSel(null)
      return
    }
    if (!selection) return
    commit()
    if (selection.type === 'crop') onEditChange({ ...edit, crop: null })
    else onEditChange({ ...edit, boxes: edit.boxes.filter((_, i) => i !== selection.index) })
    setSelection(null)
  }, [focusText, selection, edit, texts, onEditChange, commit])

  /** Собирает всё, что попало в обведённую область. */
  const markArea = useCallback(
    (area: Rect) => {
      const right = area.x + area.width
      const bottom = area.y + area.height
      // Берём то, что хотя бы задевает рамку: требовать попадания целиком
      // неудобно — крупный мазок пришлось бы обводить полностью.
      const boxes = edit.boxes
        .map((box, index) => ({ box, index }))
        .filter(
          ({ box }) =>
            box.x < right &&
            box.x + box.width > area.x &&
            box.y < bottom &&
            box.y + box.height > area.y,
        )
        .map(({ index }) => index)

      const strokes = edit.strokes
        .map((stroke, index) => ({ stroke, index }))
        .filter(({ stroke }) =>
          stroke.points.some(
            (point) =>
              point.x >= area.x && point.x <= right && point.y >= area.y && point.y <= bottom,
          ),
        )
        .map(({ index }) => index)

      setMarked({ boxes, strokes })
      setSelection(null)
    },
    [edit.boxes, edit.strokes],
  )

  /** Убирает всё выделенное рамкой одним действием. */
  const removeMarked = useCallback(() => {
    if (!marked.boxes.length && !marked.strokes.length) return
    commit()
    onEditChange({
      ...edit,
      boxes: edit.boxes.filter((_, index) => !marked.boxes.includes(index)),
      strokes: edit.strokes.filter((_, index) => !marked.strokes.includes(index)),
    })
    setMarked({ boxes: [], strokes: [] })
  }, [marked, edit, onEditChange, commit])

  /** Красит выбранную маску, не трогая остальные. */
  const paintSelected = useCallback(
    (index: number, color: string) => {
      commit()
      onEditChange({
        ...edit,
        boxes: edit.boxes.map((box, i) => (i === index ? { ...box, color } : box)),
      })
    },
    [edit, onEditChange, commit],
  )

  // Цвет на панели относится не только к следующему мазку: маски и мазки,
  // обведённые рамкой, перекрашиваются в него.
  const colorSession = useRef(false)
  const recolorChosen = useCallback(
    (color: string) => {
      const boxes = new Set(marked.boxes)
      const strokes = new Set(marked.strokes)
      if (!boxes.size && !strokes.size) return
      // Окно выбора цвета присылает цвет на каждое движение мыши — отмена
      // должна вернуть цвет до окна, а не предпоследний оттенок из него.
      if (!colorSession.current) {
        commit()
        colorSession.current = true
      }
      onEditChange({
        ...edit,
        boxes: edit.boxes.map((box, i) => (boxes.has(i) ? { ...box, color } : box)),
        strokes: edit.strokes.map((stroke, i) =>
          strokes.has(i) && !stroke.erase ? { ...stroke, color } : stroke,
        ),
      })
    },
    [marked, edit, onEditChange, commit],
  )
  const hasMarked = marked.boxes.length > 0 || marked.strokes.length > 0

  // Горячие клавиши работают, пока фокус не в поле ввода.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

      // code не зависит от раскладки (на русской это «я»), но синтетические
      // события иногда его не проставляют — поэтому проверяем и key.
      const isZ = event.code === 'KeyZ' || event.key?.toLowerCase() === 'z'
      const isA = event.code === 'KeyA' || event.key?.toLowerCase() === 'a'
      if ((event.ctrlKey || event.metaKey) && isA) {
        // Выделить всю картинку, а не всю страницу программы: всё
        // нарисованное попадает в рамку, и его можно убрать разом.
        if (target?.isContentEditable || !natural.width) return
        event.preventDefault()
        setTool('select')
        setSelection(null)
        markArea({ x: 0, y: 0, width: natural.width, height: natural.height })
      } else if ((event.ctrlKey || event.metaKey) && isZ) {
        event.preventDefault()
        undo()
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (hasMarked) {
          event.preventDefault()
          removeMarked()
        } else if (focusText !== null || selection) {
          event.preventDefault()
          removeSelected()
        }
      } else if (event.key === 'Escape') {
        setSelection(null)
        setTextSel(null)
        setMarked({ boxes: [], strokes: [] })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, removeSelected, removeMarked, selection, hasMarked, focusText, markArea, natural.width, natural.height])

  const hasEdits =
    Boolean(edit.crop) || edit.boxes.length > 0 || edit.strokes.length > 0 || texts.length > 0 ||
    Boolean(edit.rotate) || Boolean(edit.flipH)
  const canRemove = focusText !== null || Boolean(selection) || hasMarked

  const pickTool = (value: Tool) => {
    setTool(value)
    setSelection(null)
  }

  // Повёрнутая боком картинка ужимается по повёрнутым сторонам: ширину
  // держит высота сцены, высоту — её ширина.
  const fitHeight = 'calc(100vh - 330px)'
  const fitWidth = stageWidth ? `${Math.max(80, stageWidth - 32)}px` : '100%'

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Сверху отступ под «До / После» и сведения о файле: они стоят над
          картинкой, а не на ней. */}
      <div
        ref={viewportRef}
        className={`stage relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4 pt-9 ${noStraySelection.className} ${
          panning ? 'cursor-grabbing' : spaceHeld ? 'cursor-grab' : ''
        }`}
        onMouseDownCapture={noStraySelection.onMouseDownCapture}
        onDragStart={noStraySelection.onDragStart}
        onPointerDown={startPan}
        // Без этого средняя кнопка включает автопрокрутку вместо руки.
        onAuxClick={(event) => event.preventDefault()}
        onDoubleClick={() => {
          if (tool === 'view' || spaceRef.current) resetView()
        }}
      >
        {/* Обёртка обтягивает картинку, поэтому наложения совпадают с ней точно.
            Масштаб, поворот и отражение заданы ей целиком — разметка правок едет
            вместе с картинкой. Переменная --z отдана вниз: по ней рамки и
            маркеры ужимаются обратно, чтобы не пухли при зуме. */}
        <div
          className="relative"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) ${orientTransform(orient)}`,
            '--z': zoom,
          } as React.CSSProperties}
        >
          <img
            key={file.path}
            ref={imageRef}
            src={mediaUrl(file.path)}
            alt={file.name}
            className="block select-none object-contain"
            draggable={false}
            style={{
              maxWidth: turned ? fitHeight : '100%',
              maxHeight: turned ? fitWidth : fitHeight,
            }}
          />

          {/* Результат сжатия кладём поверх оригинала в ту же рамку: масштаб и
              положение общие, поэтому «до» и «после» можно щёлкать, разглядывая
              одну и ту же деталь. Он уже повёрнут сервером — поворот обёртки
              ему снимаем обратно. Правки вжжены в него, инструменты прячем. */}
          {showAfter && preview && (
            <img
              src={preview.url}
              alt="после сжатия"
              className="absolute left-1/2 top-1/2 max-w-none select-none object-contain"
              draggable={false}
              style={{
                width: turned ? `${(natural.height / (natural.width || 1)) * 100}%` : '100%',
                height: turned ? `${(natural.width / (natural.height || 1)) * 100}%` : '100%',
                transform: `translate(-50%, -50%) rotate(${-orient.rotate}deg)${orient.flipH ? ' scaleX(-1)' : ''}`,
              }}
            />
          )}

          {natural.width > 0 && !showAfter && (
            <div
              ref={overlayRef}
              className="absolute inset-0"
              // Пока двигают картинку, инструменты не должны ловить нажатия.
              style={{ pointerEvents: spaceHeld || panning ? 'none' : undefined }}
            >
              <RectCanvas
                width={natural.width}
                height={natural.height}
                boxes={edit.boxes}
                crop={edit.crop}
                tool={tool}
                selection={selection}
                onSelect={setSelection}
                strokes={edit.strokes}
                brushSize={brushSize}
                paintColor={paintColor}
                onBoxesChange={(boxes) => onEditChange({ ...edit, boxes })}
                onCropChange={(crop) => onEditChange({ ...edit, crop })}
                onStrokesChange={(strokes) => onEditChange({ ...edit, strokes })}
                onCommit={commit}
                onPick={pickColor}
                onBoxMenu={(index, x, y) => setMenu({ index, x, y })}
                marked={marked}
                onMarquee={markArea}
                orient={orient}
              />
              <ImageTexts
                texts={texts}
                natural={natural}
                scale={scale}
                zoom={zoom}
                active={tool === 'text'}
                selected={textSel}
                fresh={freshText}
                toImage={toImage}
                onSelect={(index) => {
                  setTextSel(index)
                  setFreshText(null)
                }}
                onChange={patchText}
                onCommit={commit}
                onRemove={(index) => {
                  onEditChange({ ...edit, texts: texts.filter((_, i) => i !== index) })
                  setTextSel(null)
                }}
                onCreate={(x, y) => {
                  // Нажали мимо надписей: снимаем выбор, а если ничего не было
                  // выбрано — ставим новую там, где нажали.
                  if (textSel !== null) {
                    setTextSel(null)
                    return
                  }
                  commit()
                  const index = texts.length
                  onEditChange({
                    ...edit,
                    texts: [...texts, { ...readTextStyle(), x: Math.round(x), y: Math.round(y), text: 'Текст' }],
                  })
                  setTextSel(index)
                  setFreshText(index)
                }}
              />
            </div>
          )}
        </div>

        {/* Сведения о картинке — мелко в правом верхнем углу, над ней: во
            время правки они не нужны и не должны закрывать картинку. */}
        <div className="pointer-events-none absolute right-3 top-2.5 z-10 flex items-center gap-2.5 text-[11px] text-ink-faint">
          {edit.boxes.length > 0 && <span className="text-accent-soft">заливок: {edit.boxes.length}</span>}
          {edit.crop && (
            <span className="text-accent-soft">
              обрезка {edit.crop.width}×{edit.crop.height}
            </span>
          )}
          <span className="font-mono tabular-nums">{humanSize(file.size)}</span>
          {natural.width > 0 && (
            <span className="font-mono tabular-nums">
              {natural.width}×{natural.height}
            </span>
          )}
          <span>{file.ext.toUpperCase()}</span>
          {media?.hasAlpha && <span className="text-accent-soft">прозрачность</span>}
        </div>

        {/* Масштаб — в правом нижнем углу: верхний занят сведениями о файле.
            Нажатие возвращает картинку на место. */}
        {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
          <button
            type="button"
            onClick={resetView}
            title="Вписать — вернуть картинку в исходное положение. Колесо — приблизить или отдалить, средняя кнопка или пробел — двигать"
            className="absolute bottom-3 right-3 z-10 flex items-center gap-1 bg-accent/25 px-2 py-1 font-mono text-[11px] tabular-nums text-accent-soft backdrop-blur hover:bg-accent/35"
          >
            <Maximize2 size={11} />
            {Math.round(zoom * 100)}%
          </button>
        )}

        {preview && (
          <div className="absolute left-3 top-1.5 z-10 flex overflow-hidden ring-1 ring-line-soft">
            {[
              { value: false, label: 'До', size: file.size },
              { value: true, label: 'После', size: preview.size },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => setShowAfter(item.value)}
                className={`px-2.5 py-1 text-[11px] transition-colors ${
                  showAfter === item.value
                    ? 'bg-accent-strong text-white'
                    : 'bg-surface/90 text-ink-faint hover:text-ink-dim'
                }`}
              >
                {/* Подпись и вес — одним шрифтом, размером и цветом. */}
                {item.label}
                <span className="ml-1.5 font-mono tabular-nums">{humanSize(item.size)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Инструменты — плашкой внизу по центру сцены, тремя группами одной
          высоты: обычные инструменты, объекты со своими настройками в колонке
          справа (заливка и текст), действия. У кисти толщина и цвет — прямо на
          плашке, между первыми двумя группами. Центрируется полями, а не
          transform: под transform всплывающее окошко цвета считало бы место
          от плашки, а не от окна. */}
      <div className="absolute inset-x-0 bottom-4 z-20 mx-auto flex h-11 w-fit max-w-[calc(100%-32px)] items-center gap-x-2 rounded-xl bg-surface px-2 text-[11px] text-ink-faint shadow-[0_12px_30px_rgba(0,0,0,0.45)] ring-1 ring-line-soft">
        <ToolGroup>
          {TOOLS.map((item) => (
            <ToolButton
              key={item.value}
              active={tool === item.value}
              title={`${item.label} — ${item.hint}`}
              onClick={() => pickTool(item.value)}
            >
              <item.icon size={14} />
            </ToolButton>
          ))}
        </ToolGroup>

        {(tool === 'brush' || tool === 'eraser') && (
          <label className="flex h-8 shrink-0 items-center gap-2 px-1" title="Толщина кисти, в пикселях картинки">
            <input
              type="range"
              min={4}
              max={200}
              step={2}
              value={brushSize}
              onChange={(event) => setBrushSize(Number(event.target.value))}
              className="w-20"
            />
            <span className="w-7 font-mono tabular-nums text-ink">{brushSize}</span>
          </label>
        )}

        {/* Цвет кисти. С инструментом «Выделить» он перекрашивает обведённое. */}
        {(tool === 'brush' || (tool === 'select' && hasMarked)) && (
          <ColorButton
            value={paintColor}
            title={hasMarked ? 'Цвет — обведённое перекрасится в него' : 'Цвет кисти'}
            onOpen={() => {
              colorSession.current = false
            }}
            onChange={(color) => {
              applyColor(color)
              recolorChosen(color)
            }}
            className="flex h-8 shrink-0 items-center rounded-lg px-1.5 transition-colors hover:bg-surface-3"
          />
        )}

        <ToolGroup>
          {OBJECT_TOOLS.map((item) => (
            <ToolButton
              key={item.value}
              active={tool === item.value}
              title={`${item.label} — ${item.hint}`}
              onClick={() => pickTool(item.value)}
            >
              <item.icon size={14} />
            </ToolButton>
          ))}
        </ToolGroup>

        <ToolGroup>
          <ToolButton
            title="Повернуть на 90° по часовой стрелке"
            onClick={() => {
              commit()
              onEditChange({ ...edit, rotate: (((edit.rotate ?? 0) + 90) % 360) as Orient['rotate'] })
            }}
          >
            <RotateCwSquare size={14} />
          </ToolButton>
          <ToolButton
            active={Boolean(edit.flipH)}
            title="Отразить по горизонтали"
            onClick={() => {
              commit()
              onEditChange({ ...edit, flipH: !edit.flipH })
            }}
          >
            <FlipHorizontal2 size={14} />
          </ToolButton>
          <span className="mx-0.5 h-4 w-px bg-line-soft" />
          <ToolButton title="Отменить последнее действие (Ctrl+Z)" disabled={!history.length} onClick={undo}>
            <Undo2 size={14} />
          </ToolButton>
          <ToolButton
            danger
            disabled={!canRemove}
            title={hasMarked ? 'Убрать всё, что попало в рамку (Delete)' : 'Удалить выбранное (Delete)'}
            onClick={() => (hasMarked ? removeMarked() : removeSelected())}
          >
            <Trash2 size={14} />
          </ToolButton>
          <ToolButton
            danger
            disabled={!hasEdits}
            title="Убрать все правки картинки: заливки, кисть, надписи, обрезку и поворот"
            onClick={() => {
              commit()
              onEditChange(emptyImageEdit)
              setSelection(null)
              setTextSel(null)
            }}
          >
            <ListX size={14} />
          </ToolButton>
        </ToolGroup>
      </div>

      {menu && (
        <BoxMenu
          x={menu.x}
          y={menu.y}
          color={edit.boxes[menu.index]?.color ?? '#000000'}
          onClose={() => setMenu(null)}
          onDelete={() => {
            commit()
            onEditChange({
              ...edit,
              boxes: edit.boxes.filter((_, i) => i !== menu.index),
            })
            setSelection(null)
            setMenu(null)
          }}
          onColor={(color) => {
            paintSelected(menu.index, color)
            applyColor(color)
          }}
        />
      )}
    </div>
  )
}

/**
 * Меню по правой кнопке над маской.
 *
 * Держится на своём слое поверх всего: внутри картинки его обрезал бы
 * масштаб, а вместе с ней оно бы ещё и растянулось.
 */
function BoxMenu({
  x,
  y,
  color,
  onClose,
  onDelete,
  onColor,
}: {
  x: number
  y: number
  color: string
  onClose: () => void
  onDelete: () => void
  onColor: (color: string) => void
}) {
  useEffect(() => {
    const away = (event: MouseEvent) => {
      // Окошко цвета живёт отдельным слоем — нажатия в нём меню не закрывают.
      const target = event.target as HTMLElement
      if (!target.closest('[data-box-menu]') && !target.closest('[data-color-popover]')) onClose()
    }
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    // Ждём следующего события: то, которое открыло меню, ещё не «отпустили».
    const timer = setTimeout(() => {
      window.addEventListener('mousedown', away)
      window.addEventListener('keydown', escape)
    }, 0)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', escape)
    }
  }, [onClose])

  return (
    <div
      data-box-menu
      className="fixed z-50 min-w-[168px] overflow-hidden rounded-lg bg-surface-2 py-1 text-[12px] shadow-lg ring-1 ring-line"
      style={{ left: Math.min(x, window.innerWidth - 180), top: Math.min(y, window.innerHeight - 90) }}
    >
      <ColorButton
        value={color}
        onChange={onColor}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-3"
      >
        <span
          className="h-3 w-3 shrink-0 rounded-[3px] ring-1 ring-line"
          style={{ background: color }}
        />
        Поменять цвет
      </ColorButton>
      <button
        type="button"
        onClick={onDelete}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-danger hover:bg-surface-3"
      >
        <Trash2 size={12} />
        Удалить
      </button>
    </div>
  )
}
