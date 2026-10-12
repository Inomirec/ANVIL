import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Brush,
  Crop,
  Eraser,
  Maximize2,
  MousePointer2,
  Pipette,
  RotateCcw,
  Square,
  SquareDashedMousePointer,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react'
import { mediaUrl } from '../lib/api'
import { noStraySelection } from '../lib/noSelect'
import { humanSize } from '../lib/format'
import type { FileInfo, ImagePreview, Rect, Stroke } from '../lib/types'
import { RectCanvas, type Selection, type Tool } from './RectCanvas'
import { api } from '../lib/api'
import { FontPicker, type FontRow } from './ComposeTextPanel'
import { ImageTexts, type ImageTextMark } from './ImageTexts'
import { ColorButton } from './ColorPicker'

export interface ImageEdit {
  crop: Rect | null
  boxes: Rect[]
  /** Мазки кистью и ластиком — для надписей, которые не влезают в прямоугольник. */
  strokes: Stroke[]
  /** Надписи поверх картинки. */
  texts: ImageTextMark[]
}

export const emptyImageEdit: ImageEdit = { crop: null, boxes: [], strokes: [], texts: [] }

/** Как выглядит следующая надпись — запоминается между картинками. */
const TEXT_STYLE_KEY = 'sgh.imageText'

interface TextStyle {
  font: string
  size: number
  color: string
  stroke: number
  strokeColor: string
}

function readTextStyle(): TextStyle {
  try {
    const saved = JSON.parse(localStorage.getItem(TEXT_STYLE_KEY) ?? 'null')
    if (saved && typeof saved.font === 'string') return { stroke: 0, strokeColor: '#000000', ...saved }
  } catch {
    // Испорченная запись — берём обычные.
  }
  return { font: 'Arial', size: 64, color: '#ffffff', stroke: 0, strokeColor: '#000000' }
}

/** Инструменты редактора: значок, название и для чего он. */
const TOOLS: { value: Tool; label: string; hint: string; icon: typeof Square }[] = [
  // Курсор первым, как в редакторах: с него начинают и к нему возвращаются.
  { value: 'view', label: 'Курсор', hint: 'просто смотреть, ничего не рисуя', icon: MousePointer2 },
  { value: 'box', label: 'Закрасить', hint: 'прямоугольник: бренд, надпись, спойлер', icon: Square },
  { value: 'brush', label: 'Кисть', hint: 'закрасить от руки, для надписей дугой и наискось', icon: Brush },
  { value: 'eraser', label: 'Ластик', hint: 'стереть лишнее, что закрасили кистью', icon: Eraser },
  { value: 'text', label: 'Текст', hint: 'надпись на картинке: нажмите, где она должна стоять', icon: Type },
  { value: 'crop', label: 'Обрезать', hint: 'отрезать пустые поля и чёрные края', icon: Crop },
  { value: 'select', label: 'Выделить', hint: 'обвести область и убрать всё лишнее разом', icon: SquareDashedMousePointer },
  { value: 'pick', label: 'Пипетка', hint: 'взять цвет прямо с картинки', icon: Pipette },
]

/** Ключ запомненного цвета закраски. */
const COLOR_KEY = 'sgh.paintColor'

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
}: {
  file: FileInfo
  edit: ImageEdit
  /** Просчитанный результат сжатия — то, что покажет кнопка «После». */
  preview?: ImagePreview | null
  onEditChange: (edit: ImageEdit) => void
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

  // Надписи: какая выбрана, какая только что поставлена и как выглядит
  // следующая. Список шрифтов читаем, только когда он понадобился.
  const texts = edit.texts ?? []
  const [textSel, setTextSel] = useState<number | null>(null)
  const [freshText, setFreshText] = useState<number | null>(null)
  const [textStyle, setTextStyle] = useState(readTextStyle)
  const [fonts, setFonts] = useState<FontRow[] | null>(null)
  const textSession = useRef(false)
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
  const spaceRef = useRef(false)
  const panRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  // Обработчик колеса живёт вне React, поэтому текущие значения берём из ссылок.
  const viewRef = useRef({ zoom: 1, pan: { x: 0, y: 0 } })
  viewRef.current = { zoom, pan }

  const media = file.media
  const natural = { width: media?.width ?? 0, height: media?.height ?? 0 }

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

  useLayoutEffect(() => {
    const image = imageRef.current
    if (!image || !natural.width || !image.offsetWidth) return
    const next = image.offsetWidth / natural.width
    if (Math.abs(next - scale) > 1e-4) setScale(next)
  })
  // Окно поменяло размер — картинка тоже, а с ней и буквы.
  useEffect(() => {
    const onResize = () => setViewport((value) => value + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if ((tool !== 'text' && textSel === null) || fonts) return
    api
      .fonts()
      .then((data) => setFonts(data.fonts))
      .catch(() => setFonts([]))
  }, [tool, textSel, fonts])

  // Ушли с инструмента — надпись больше не выбрана.
  useEffect(() => {
    if (tool !== 'text') setTextSel(null)
  }, [tool])

  /** Правка надписи; ``commitFirst`` — запомнить состояние для Ctrl+Z. */
  const patchText = useCallback(
    (index: number, patch: Partial<ImageTextMark>) => {
      onEditChange({
        ...edit,
        texts: texts.map((mark, i) => (i === index ? { ...mark, ...patch } : mark)),
      })
    },
    [edit, texts, onEditChange],
  )

  /** Вид надписи на панели: у выбранной — её, иначе — следующей. */
  const chosenText = textSel !== null ? texts[textSel] : undefined
  const shownStyle: TextStyle = chosenText
    ? { ...textStyle, ...chosenText, stroke: chosenText.stroke ?? 0, strokeColor: chosenText.strokeColor ?? '#000000' }
    : textStyle
  const applyStyle = (patch: Partial<TextStyle>) => {
    const next = { ...textStyle, ...patch }
    setTextStyle(next)
    try {
      localStorage.setItem(TEXT_STYLE_KEY, JSON.stringify(next))
    } catch {
      // Без памяти просто не запомним.
    }
    if (textSel !== null && texts[textSel]) {
      if (!textSession.current) {
        commit()
        textSession.current = true
      }
      patchText(textSel, patch)
    }
  }


  const applyColor = useCallback(
    (color: string) => {
      setPaintColor(color)
      localStorage.setItem(COLOR_KEY, color)
    },
    [],
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
  // за край ровно в тот момент, когда её пытаешься рассмотреть.
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
      const next = Math.min(16, Math.max(1, current * (event.deltaY < 0 ? 1.2 : 1 / 1.2)))
      if (next === current) return
      const ratio = next / current

      setZoom(next)
      setPan(
        next === 1
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
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
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

  const undo = useCallback(() => {
    setHistory((current) => {
      if (!current.length) return current
      onEditChange(current[current.length - 1])
      setSelection(null)
      return current.slice(0, -1)
    })
  }, [onEditChange])

  const removeSelected = useCallback(() => {
    if (!selection) return
    commit()
    if (selection.type === 'crop') onEditChange({ ...edit, crop: null })
    else onEditChange({ ...edit, boxes: edit.boxes.filter((_, i) => i !== selection.index) })
    setSelection(null)
  }, [selection, edit, onEditChange, commit])

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

  // Цвет на панели относится не только к следующей маске: если что-то
  // выбрано — маска нажатием или маски с мазками рамкой, — перекрашиваем и
  // его. Иначе поменять цвет уже нарисованного было нечем, кроме меню по
  // правой кнопке, о котором ещё надо знать.
  const colorSession = useRef(false)
  const recolorChosen = useCallback(
    (color: string) => {
      const boxes = new Set(marked.boxes)
      if (selection?.type === 'box') boxes.add(selection.index)
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
    [marked, selection, edit, onEditChange, commit],
  )
  const hasChosen = selection?.type === 'box' || marked.boxes.length > 0 || marked.strokes.length > 0

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
        if (textSel !== null && texts[textSel]) {
          event.preventDefault()
          commit()
          onEditChange({ ...edit, texts: texts.filter((_, i) => i !== textSel) })
          setTextSel(null)
        } else if (marked.boxes.length || marked.strokes.length) {
          event.preventDefault()
          removeMarked()
        } else if (selection) {
          event.preventDefault()
          removeSelected()
        }
      } else if (event.key === 'Escape') {
        setSelection(null)
        setMarked({ boxes: [], strokes: [] })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, removeSelected, removeMarked, selection, marked, textSel, texts, edit, onEditChange, commit, markArea, natural.width, natural.height])

  const hasEdits = Boolean(edit.crop) || edit.boxes.length > 0 || texts.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={viewportRef}
        className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#0e1016] p-4 ${noStraySelection.className} ${
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
        {/* Шахматка под прозрачными картинками */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              'linear-gradient(45deg, #fff 25%, transparent 25%), linear-gradient(-45deg, #fff 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #fff 75%), linear-gradient(-45deg, transparent 75%, #fff 75%)',
            backgroundSize: '20px 20px',
            backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0',
          }}
        />

        {/* Обёртка обтягивает картинку, поэтому наложения совпадают с ней точно.
            Масштаб задан ей целиком — разметка правок едет вместе с картинкой,
            и пересчитывать координаты не нужно. Переменная --z отдана вниз:
            по ней рамки и маркеры ужимаются обратно, чтобы не пухли при зуме. */}
        <div
          className="relative"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            '--z': zoom,
          } as React.CSSProperties}
        >
          <img
            key={file.path}
            ref={imageRef}
            src={mediaUrl(file.path)}
            alt={file.name}
            className="block max-w-full select-none object-contain"
            draggable={false}
            style={{ maxHeight: 'calc(100vh - 330px)' }}
          />

          {/* Результат сжатия кладём поверх оригинала в ту же рамку: масштаб и
              положение общие, поэтому «до» и «после» можно щёлкать, разглядывая
              одну и ту же деталь. Правки уже вжжены в него, инструменты прячем. */}
          {showAfter && preview && (
            <img
              src={preview.url}
              alt="после сжатия"
              className="absolute inset-0 h-full w-full select-none object-contain"
              draggable={false}
            />
          )}

          {natural.width > 0 && !showAfter && (
            <div
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
            />
            <ImageTexts
              texts={texts}
              natural={natural}
              scale={scale}
              zoom={zoom}
              active={tool === 'text'}
              selected={textSel}
              fresh={freshText}
              onSelect={(index) => {
                setTextSel(index)
                setFreshText(null)
                textSession.current = false
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
                  texts: [...texts, { x: Math.round(x), y: Math.round(y), text: 'Текст', ...textStyle }],
                })
                setTextSel(index)
                setFreshText(index)
                textSession.current = false
              }}
            />
            </div>
          )}
        </div>

        {/* Сведения о картинке — на ней самой, справа внизу и полупрозрачно:
            на панели инструментов им не хватало места. */}
        <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex items-center gap-2.5 bg-surface/70 px-2.5 py-1 text-[11px] text-ink-faint opacity-80 ring-1 ring-line-soft backdrop-blur">
          {edit.boxes.length > 0 && <span className="text-accent-soft">масок: {edit.boxes.length}</span>}
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

        {/* Масштаб — в углу картинки, как у видео: на панели инструментов
            ему не хватало места. Нажатие возвращает картинку на место. */}
        {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
          <button
            type="button"
            onClick={resetView}
            title="Вписать — вернуть картинку в исходное положение. Колесо — приблизить, средняя кнопка или пробел — двигать"
            className="absolute right-3 top-3 z-10 flex items-center gap-1 bg-accent/25 px-2 py-1 font-mono text-[11px] tabular-nums text-accent-soft backdrop-blur hover:bg-accent/35"
          >
            <Maximize2 size={11} />
            {Math.round(zoom * 100)}%
          </button>
        )}

        {preview && (
          <div className="absolute bottom-3 left-3 flex overflow-hidden ring-1 ring-line-soft">
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
                    ? 'bg-accent text-white'
                    : 'bg-surface/90 text-ink-faint hover:text-ink-dim'
                }`}
              >
                {item.label}
                <span className="ml-1.5 font-mono tabular-nums opacity-70">
                  {humanSize(item.size)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Инструменты */}
      {/* Одна строка: сведения о файле справа сжимаются, а не переносят
          панель на вторую строку. */}
      <div className="flex h-11 shrink-0 items-center gap-x-2 border-t border-line-soft bg-surface px-3 text-[11px] text-ink-faint">
        <span className="flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5 ring-1 ring-line-soft">
          {TOOLS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => {
                setTool(item.value)
                setSelection(null)
              }}
              title={`${item.label} — ${item.hint}`}
              aria-label={item.label}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                tool === item.value
                  ? 'bg-accent text-white'
                  : 'text-ink-faint hover:bg-surface-3 hover:text-ink-dim'
              }`}
            >
              <item.icon size={14} />
            </button>
          ))}
        </span>

        {/* Надпись: шрифт, размер и цвет — прямо на панели. Правят выбранную
            надпись, а без выбора — следующую. */}
        {(tool === 'text' || textSel !== null) && (
          <span className="flex items-center gap-1.5">
            <span className="w-24">
              <FontPicker
                up
                value={shownStyle.font}
                fonts={fonts}
                onChange={(font) => {
                  textSession.current = false
                  applyStyle({ font })
                }}
              />
            </span>
            <label
              className="flex items-center rounded-lg bg-surface-2 px-1.5 ring-1 ring-line-soft"
              title="Размер букв в пикселях картинки"
            >
              <input
                type="number"
                min={4}
                max={2000}
                value={shownStyle.size}
                onFocus={() => {
                  textSession.current = false
                }}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  if (value >= 4 && value <= 2000) applyStyle({ size: value })
                }}
                className="w-12 bg-transparent py-1 text-right font-mono text-[12px] text-ink outline-none"
              />
              <span className="ml-0.5 text-[10px]">px</span>
            </label>
            <ColorButton
              value={shownStyle.color}
              title="Цвет надписи"
              onOpen={() => {
                textSession.current = false
              }}
              onChange={(color) => applyStyle({ color })}
            />
            {/* Обводка — во всплывающем окошке у буквы с контуром: в строке
                панели ей не хватало места. */}
            <StrokeButton
              stroke={shownStyle.stroke}
              color={shownStyle.strokeColor}
              size={shownStyle.size}
              onChange={(patch) => {
                textSession.current = false
                applyStyle(patch)
              }}
            />
          </span>
        )}

        {(tool === 'brush' || tool === 'eraser') && (
          <label className="flex items-center gap-2" title="Толщина кисти">
            {tool === 'brush' ? <Brush size={12} /> : <Eraser size={12} />}
            <input
              type="range"
              min={4}
              max={200}
              step={2}
              value={brushSize}
              onChange={(event) => setBrushSize(Number(event.target.value))}
              className="w-24"
            />
            <span className="w-8 font-mono tabular-nums text-ink">{brushSize}</span>
          </label>
        )}

        {tool !== 'view' && tool !== 'crop' && tool !== 'text' && (
          <ColorButton
            value={paintColor}
            title={
              hasChosen
                ? 'Цвет закраски — выбранное перекрасится в него'
                : 'Цвет закраски — нажмите, чтобы выбрать'
            }
            onOpen={() => {
              colorSession.current = false
            }}
            onChange={(color) => {
              applyColor(color)
              recolorChosen(color)
            }}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 transition-colors hover:bg-surface-3"
          />
        )}


        <button
          type="button"
          onClick={undo}
          disabled={!history.length}
          title="Отменить последнее действие (Ctrl+Z)"
          aria-label="Отменить"
          className="inline-flex items-center rounded-lg p-1.5 transition-colors hover:bg-surface-3 hover:text-ink-dim disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Undo2 size={13} />
        </button>

        {(marked.boxes.length > 0 || marked.strokes.length > 0) && (
          <button
            type="button"
            onClick={removeMarked}
            title="Убрать всё, что попало в рамку (Delete)"
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent/15 px-2 py-1 text-accent-soft transition-colors hover:bg-accent/25"
          >
            <Trash2 size={12} />
            {marked.boxes.length + marked.strokes.length}
          </button>
        )}

        <button
          type="button"
          onClick={removeSelected}
          disabled={!selection}
          title="Удалить выделенное (Delete)"
          aria-label="Удалить"
          className="inline-flex items-center rounded-lg p-1.5 transition-colors hover:bg-surface-3 hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Trash2 size={13} />
        </button>

        {hasEdits && (
          <button
            type="button"
            onClick={() => {
              commit()
              onEditChange(emptyImageEdit)
              setSelection(null)
            }}
            title="Сбросить все правки картинки"
            aria-label="Сбросить всё"
            className="inline-flex items-center rounded-lg p-1.5 transition-colors hover:bg-surface-3 hover:text-ink-dim"
          >
            <RotateCcw size={13} />
          </button>
        )}

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

/**
 * Обводка надписи: буква с контуром на панели, настройки — во всплывающем
 * окошке над ней. Буква подсвечена, пока обводка включена.
 */
function StrokeButton({
  stroke,
  color,
  size,
  onChange,
}: {
  stroke: number
  color: string
  /** Кегль надписи — от него обычная толщина обводки. */
  size: number
  onChange: (patch: { stroke?: number; strokeColor?: string }) => void
}) {
  const [open, setOpen] = useState(false)
  const holder = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (!holder.current?.contains(target) && !target.closest('[data-color-popover]')) setOpen(false)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [open])

  return (
    <span ref={holder} className="relative">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        title={stroke ? 'Обводка включена' : 'Обводка букв'}
        className={`flex h-7 w-7 items-center justify-center rounded-lg text-[15px] font-bold transition-colors ${
          stroke ? 'bg-accent/20' : 'hover:bg-surface-3'
        }`}
        style={{
          color: 'transparent',
          WebkitTextStroke: `1.2px ${stroke ? 'var(--color-accent-soft)' : 'var(--color-ink-dim)'}`,
        }}
      >
        A
      </button>
      {open && (
        <span className="absolute bottom-full left-1/2 z-40 mb-2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-xl border border-line bg-surface-2 px-2.5 py-2 text-[11px] text-ink-dim shadow-xl">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={stroke > 0}
              onChange={(event) =>
                onChange({ stroke: event.target.checked ? Math.max(2, Math.round(size / 16)) : 0 })
              }
            />
            Обводка
          </label>
          <ColorButton
            value={color}
            title="Цвет обводки"
            onChange={(strokeColor) => onChange({ strokeColor, stroke: stroke || Math.max(2, Math.round(size / 16)) })}
            className="flex items-center rounded-lg p-1 transition-colors hover:bg-surface-3"
          />
          <label
            className="flex items-center rounded-lg bg-surface px-1.5 ring-1 ring-line-soft"
            title="Толщина обводки в пикселях картинки"
          >
            <input
              type="number"
              min={1}
              max={200}
              value={stroke || Math.max(2, Math.round(size / 16))}
              onChange={(event) => {
                const value = Number(event.target.value)
                if (value >= 1 && value <= 200) onChange({ stroke: value })
              }}
              className="w-10 bg-transparent py-1 text-right font-mono text-[12px] text-ink outline-none"
            />
            <span className="ml-0.5 text-[10px]">px</span>
          </label>
        </span>
      )}
    </span>
  )
}
