/**
 * Прямые кавычки для шрифтов, в которых их нет.
 *
 * В фигурных шрифтах прямой кавычки часто нет, а «ёлочки» и “лапки” есть.
 * Браузер подставлял недостающий знак из другого шрифта, и в окне кавычка
 * была, а в готовом кадре на её месте — пусто. Сервер говорит, чем заменить
 * (`quotes` у шрифта), и замену делает и окно прямо при наборе, и сборка —
 * по одному правилу (`fonts.fit_quotes`).
 */

/** Знак, после которого кавычка открывающая. */
function opens(before: string): boolean {
  return !before || /\s/.test(before) || '([{«“„-—'.includes(before)
}

/** Текст с заменёнными кавычками. Длина не меняется: знак на знак. */
export function fitQuotes(text: string, swaps: Record<string, string> | undefined): string {
  if (!swaps || !Object.keys(swaps).length) return text
  let out = ''
  for (let index = 0; index < text.length; index++) {
    const pair = swaps[text[index]]
    out += pair ? (opens(text[index - 1] ?? '') ? pair[0] : pair[1]) : text[index]
  }
  return out
}

/**
 * Замена прямо в редактируемой надписи. Меняем текст внутри тех же узлов, а
 * не весь текст разом: курсор остаётся там, где был.
 */
export function fitQuotesInPlace(element: HTMLElement, swaps: Record<string, string> | undefined): boolean {
  if (!swaps || !Object.keys(swaps).length) return false
  const selection = window.getSelection()
  const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null
  const caret = range ? { node: range.startContainer, offset: range.startOffset } : null
  let changed = false
  let before = ''
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if ((node as Element).tagName === 'BR' || (node as Element).tagName === 'DIV') before = '\n'
      continue
    }
    const value = node.nodeValue ?? ''
    let next = ''
    for (const char of value) {
      const pair = swaps[char]
      next += pair ? (opens(before) ? pair[0] : pair[1]) : char
      before = next[next.length - 1]
    }
    if (next !== value) {
      node.nodeValue = next
      changed = true
    }
  }
  if (changed && caret && selection && element.contains(caret.node)) {
    const restored = document.createRange()
    restored.setStart(caret.node, Math.min(caret.offset, caret.node.nodeValue?.length ?? caret.offset))
    restored.collapse(true)
    selection.removeAllRanges()
    selection.addRange(restored)
  }
  return changed
}
