export const CARD_FOOTER_HEIGHT = 58

export function isGalleryViewportMeasurable(width, height) {
  const numericWidth = Number(width)
  const numericHeight = Number(height)
  return Number.isFinite(numericWidth) && numericWidth > 0 &&
    Number.isFinite(numericHeight) && numericHeight > 0
}

export function calculateGalleryMetrics(width, minimumCardWidth, gap = 10) {
  const safeWidth = Math.max(1, Math.floor(Number(width) || 1))
  const safeMinimum = Math.max(1, Math.floor(Number(minimumCardWidth) || 1))
  const safeGap = Math.max(0, Math.floor(Number(gap) || 0))
  const columns = Math.max(1, Math.floor((safeWidth + safeGap) / (safeMinimum + safeGap)))
  const cardWidth = Math.max(96, Math.floor((safeWidth - safeGap * (columns - 1)) / columns))
  const mediaHeight = Math.max(84, Math.round(cardWidth * 0.78))
  const cardHeight = mediaHeight + CARD_FOOTER_HEIGHT
  return {
    width: safeWidth,
    columns,
    cardWidth,
    columnStride: cardWidth + safeGap,
    mediaHeight,
    cardHeight,
    rowStride: cardHeight + safeGap
  }
}

export function calculateVisibleCardRange(
  totalItems,
  columns,
  rowStride,
  cardGap,
  scrollTop,
  viewportHeight,
  overscanRows = 2
) {
  const count = Math.max(0, Math.floor(Number(totalItems) || 0))
  if (!count) return { start: 0, end: 0, totalHeight: 0, startRow: 0, scrollTop: 0 }
  const safeColumns = Math.max(1, Math.floor(Number(columns) || 1))
  const safeStride = Math.max(1, Number(rowStride) || 1)
  const safeViewport = Math.max(Number(viewportHeight) || safeStride, safeStride)
  const rows = Math.ceil(count / safeColumns)
  const maxScroll = Math.max(0, rows * safeStride - Math.max(0, Number(cardGap) || 0) - safeViewport)
  const clampedScroll = Math.min(Math.max(Number(scrollTop) || 0, 0), maxScroll)
  const firstRow = Math.floor(clampedScroll / safeStride)
  const visibleRows = Math.max(1, Math.ceil(safeViewport / safeStride))
  const overscan = Math.max(0, Math.floor(Number(overscanRows) || 0))
  const startRow = Math.max(0, firstRow - overscan)
  const endRow = Math.min(rows, firstRow + visibleRows + overscan + 1)
  return {
    start: startRow * safeColumns,
    end: Math.min(count, endRow * safeColumns),
    totalHeight: Math.max(0, rows * safeStride - Math.max(0, Number(cardGap) || 0)),
    startRow,
    scrollTop: clampedScroll
  }
}

export function planCardSlotReuse(previousItemIds, nextItemIds) {
  const previous = Array.isArray(previousItemIds) ? previousItemIds : []
  const next = Array.isArray(nextItemIds) ? nextItemIds : []
  const availableById = new Map()
  for (let index = 0; index < previous.length; index += 1) {
    const itemId = previous[index]
    if (itemId != null && !availableById.has(itemId)) availableById.set(itemId, index)
  }

  const assignments = new Array(next.length).fill(-1)
  const used = new Set()
  for (let index = 0; index < next.length; index += 1) {
    const previousIndex = availableById.get(next[index])
    if (previousIndex == null || used.has(previousIndex)) continue
    assignments[index] = previousIndex
    used.add(previousIndex)
  }

  const free = []
  for (let index = 0; index < previous.length; index += 1) {
    if (!used.has(index)) free.push(index)
  }
  let freeIndex = 0
  let nextNewIndex = previous.length
  for (let index = 0; index < assignments.length; index += 1) {
    if (assignments[index] >= 0) continue
    assignments[index] = freeIndex < free.length ? free[freeIndex++] : nextNewIndex++
  }
  return assignments
}

export function isHighVelocityScroll(deltaPixels, elapsedMs, rowStride) {
  const distance = Math.abs(Number(deltaPixels) || 0)
  const elapsed = Math.max(8, Number(elapsedMs) || 8)
  const stride = Math.max(1, Number(rowStride) || 1)
  return distance >= stride * 1.5 || distance / elapsed >= stride / 32
}

export function restoreGraphCanvasFocus(previousOwner, canvas) {
  if (!canvas || typeof canvas.focus !== 'function') return false
  previousOwner?.blur?.()
  if (typeof canvas.tabIndex === 'number' && canvas.tabIndex < 0) canvas.tabIndex = -1
  try {
    canvas.focus({ preventScroll: true })
  } catch {
    canvas.focus()
  }
  return !canvas.ownerDocument || canvas.ownerDocument.activeElement === canvas
}

const TEXT_INPUT_RESERVED_SHORTCUTS = new Set([
  'Ctrl+a', 'Ctrl+c', 'Ctrl+v', 'Ctrl+x', 'Ctrl+z', 'Ctrl+y', 'Ctrl+p',
  'Enter', 'Shift+Enter', 'Ctrl+Backspace', 'Ctrl+Delete',
  'Home', 'Ctrl+Home', 'Ctrl+Shift+Home',
  'End', 'Ctrl+End', 'Ctrl+Shift+End',
  'PageUp', 'Shift+PageUp', 'PageDown', 'Shift+PageDown',
  'ArrowLeft', 'Ctrl+ArrowLeft', 'Shift+ArrowLeft', 'Ctrl+Shift+ArrowLeft',
  'ArrowRight', 'Ctrl+ArrowRight', 'Shift+ArrowRight', 'Ctrl+Shift+ArrowRight',
  'ArrowUp', 'Shift+ArrowUp', 'ArrowDown', 'Shift+ArrowDown'
])

export function isReservedTextInputShortcut(event) {
  if (!event) return true
  const ctrl = Boolean(event.ctrlKey || event.metaKey)
  const alt = Boolean(event.altKey)
  const shift = Boolean(event.shiftKey)
  if (!ctrl && !alt) return true
  const modifiers = []
  if (ctrl) modifiers.push('Ctrl')
  if (alt) modifiers.push('Alt')
  if (shift) modifiers.push('Shift')
  const rawKey = String(event.key || '')
  modifiers.push(rawKey.length === 1 ? rawKey.toLowerCase() : rawKey)
  return TEXT_INPUT_RESERVED_SHORTCUTS.has(modifiers.join('+'))
}

export function keyboardComboSignature(eventOrCombo) {
  if (!eventOrCombo) return ''
  const key = String(eventOrCombo.key ?? '').toUpperCase()
  const isCombo = Object.hasOwn(eventOrCombo, 'ctrl')
  const ctrl = isCombo
    ? Boolean(eventOrCombo.ctrl)
    : Boolean(eventOrCombo.ctrlKey || eventOrCombo.metaKey)
  const alt = Boolean(isCombo ? eventOrCombo.alt : eventOrCombo.altKey)
  const shift = Boolean(isCombo ? eventOrCombo.shift : eventOrCombo.shiftKey)
  return `${key}:${ctrl}:${alt}:${shift}`
}

function isTextEditingTarget(target) {
  const tagName = String(target?.tagName ?? '').toUpperCase()
  return tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    target?.contentEditable === 'true' ||
    (tagName === 'SPAN' && target?.classList?.contains?.('property_value'))
}

export function findKeyboundCommand(commands, event, target, documentRef = globalThis.document) {
  if (!event || event.defaultPrevented || event.isComposing) return null
  const eventSignature = keyboardComboSignature(event)
  if (!eventSignature || eventSignature.startsWith('CONTROL:') ||
      eventSignature.startsWith('META:') || eventSignature.startsWith('ALT:') ||
      eventSignature.startsWith('SHIFT:')) return null
  if (event.key === 'Escape' && target?.closest?.('[role="menu"]')) return null

  for (const command of Array.from(commands ?? [])) {
    let binding
    try {
      binding = command?.keybinding
    } catch {
      continue
    }
    if (!binding?.combo || keyboardComboSignature(binding.combo) !== eventSignature) continue

    if (isTextEditingTarget(target)) {
      const reserved = typeof binding.combo.isReservedByTextInput === 'boolean'
        ? binding.combo.isReservedByTextInput
        : isReservedTextInputShortcut(event)
      if (reserved) return null
    }

    const targetElementId = binding.targetElementId === 'graph-canvas'
      ? 'graph-canvas-container'
      : binding.targetElementId
    if (targetElementId) {
      const container = documentRef?.getElementById?.(targetElementId)
      if (!container?.contains?.(target)) continue
    }
    return command
  }
  return null
}

const RUN_COMMAND_IDS = new Set([
  'Comfy.QueuePrompt',
  'Comfy.QueuePromptFront',
  'Comfy.QueueSelectedOutputNodes'
])

export function dispatchKeyboundCommandFallback(
  event,
  commandManager,
  {
    target = event?.composedPath?.()[0] ?? event?.target,
    documentRef = globalThis.document,
    modalOpen = false,
    onError = () => {}
  } = {}
) {
  if (modalOpen || typeof commandManager?.execute !== 'function') return false
  const command = findKeyboundCommand(commandManager.commands, event, target, documentRef)
  if (!command?.id) return false

  event.preventDefault?.()
  event.stopImmediatePropagation?.()
  const options = {
    errorHandler: onError,
    ...(RUN_COMMAND_IDS.has(command.id)
      ? { metadata: { trigger_source: 'keybinding' } }
      : {})
  }
  try {
    const result = commandManager.execute(command.id, options)
    result?.catch?.(onError)
  } catch (error) {
    onError(error)
  }
  return true
}

export function isConveyorDeleteShortcut(event) {
  if (!event || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  return event.key === 'Delete' || event.code === 'Delete'
}

const CONVEYOR_GALLERY_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  ' ',
  'Escape'
])

export function isConveyorGalleryShortcut(event) {
  if (!event || event.defaultPrevented || event.isComposing) return false
  if (isConveyorDeleteShortcut(event)) return true
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  return CONVEYOR_GALLERY_KEYS.has(event.key)
}

export function calculateMarqueeGridIndexes(totalItems, metrics, bounds) {
  const count = Math.max(0, Math.floor(Number(totalItems) || 0))
  if (!count || !metrics || !bounds) return []

  const columns = Math.max(1, Math.floor(Number(metrics.columns) || 1))
  const cardWidth = Math.max(1, Number(metrics.cardWidth) || 1)
  const cardHeight = Math.max(1, Number(metrics.cardHeight) || 1)
  const rowStride = Math.max(cardHeight, Number(metrics.rowStride) || cardHeight)
  const columnStride = Math.max(cardWidth, Number(metrics.columnStride) || cardWidth)
  const left = Math.min(Number(bounds.left) || 0, Number(bounds.right) || 0)
  const right = Math.max(Number(bounds.left) || 0, Number(bounds.right) || 0)
  const top = Math.min(Number(bounds.top) || 0, Number(bounds.bottom) || 0)
  const bottom = Math.max(Number(bounds.top) || 0, Number(bounds.bottom) || 0)
  if (right <= left || bottom <= top) return []

  const rows = Math.ceil(count / columns)
  const firstRow = Math.max(0, Math.floor(top / rowStride))
  const lastRow = Math.min(rows - 1, Math.floor(bottom / rowStride))
  const firstColumn = Math.max(0, Math.floor(left / columnStride))
  const lastColumn = Math.min(columns - 1, Math.floor(right / columnStride))
  const indexes = []

  for (let row = firstRow; row <= lastRow; row += 1) {
    const cardTop = row * rowStride
    const cardBottom = cardTop + cardHeight
    if (cardBottom <= top || cardTop >= bottom) continue
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const index = row * columns + column
      if (index >= count) break
      const cardLeft = column * columnStride
      const cardRight = cardLeft + cardWidth
      if (cardRight > left && cardLeft < right) indexes.push(index)
    }
  }
  return indexes
}

export function clientPointToScrollContent(
  clientX,
  clientY,
  rect,
  clientWidth,
  clientHeight,
  scrollLeft = 0,
  scrollTop = 0,
  layoutWidth = clientWidth,
  layoutHeight = clientHeight
) {
  const width = Math.max(0, Number(clientWidth) || 0)
  const height = Math.max(0, Number(clientHeight) || 0)
  const boxWidth = Math.max(0, Number(layoutWidth) || width)
  const boxHeight = Math.max(0, Number(layoutHeight) || height)
  const renderedWidth = Math.max(0, Number(rect?.width) || 0)
  const renderedHeight = Math.max(0, Number(rect?.height) || 0)
  const scaleX = boxWidth > 0 && renderedWidth > 0 ? renderedWidth / boxWidth : 1
  const scaleY = boxHeight > 0 && renderedHeight > 0 ? renderedHeight / boxHeight : 1
  const localX = (Number(clientX) - (Number(rect?.left) || 0)) / scaleX
  const localY = (Number(clientY) - (Number(rect?.top) || 0)) / scaleY
  return {
    x: Math.min(Math.max(localX, 0), width) + Math.max(0, Number(scrollLeft) || 0),
    y: Math.min(Math.max(localY, 0), height) + Math.max(0, Number(scrollTop) || 0)
  }
}

export function calculateReorderDestinationIndex(length, fromIndex, insertionIndex) {
  const count = Math.max(0, Math.floor(Number(length) || 0))
  const from = Math.floor(Number(fromIndex))
  if (!count || !Number.isFinite(from) || from < 0 || from >= count) return -1
  const boundary = Math.min(count, Math.max(0, Math.floor(Number(insertionIndex) || 0)))
  const destination = from < boundary ? boundary - 1 : boundary
  return destination === from ? -1 : destination
}

export function calculateGalleryDropIntent(totalItems, metrics, contentX, contentY) {
  const count = Math.max(0, Math.floor(Number(totalItems) || 0))
  if (!count || !metrics) return null

  const columns = Math.max(1, Math.floor(Number(metrics.columns) || 1))
  const cardWidth = Math.max(1, Number(metrics.cardWidth) || 1)
  const cardHeight = Math.max(1, Number(metrics.cardHeight) || 1)
  const columnStride = Math.max(cardWidth, Number(metrics.columnStride) || cardWidth)
  const rowStride = Math.max(cardHeight, Number(metrics.rowStride) || cardHeight)
  const gap = Math.max(0, rowStride - cardHeight)
  const rows = Math.ceil(count / columns)
  const x = Math.max(0, Number(contentX) || 0)
  const y = Math.max(0, Number(contentY) || 0)
  const row = Math.min(rows - 1, Math.floor(y / rowStride))
  const rowStart = row * columns
  const rowCount = Math.min(columns, count - rowStart)
  const rowTop = row * rowStride
  const rowOffset = y - rowTop

  if (rowOffset >= cardHeight && row < rows - 1) {
    return {
      type: 'insertion',
      insertionIndex: Math.min(count, rowStart + rowCount),
      orientation: 'horizontal',
      left: 0,
      top: rowTop + cardHeight + gap / 2
    }
  }

  const column = Math.floor(x / columnStride)
  if (column >= rowCount) {
    const lastColumn = rowCount - 1
    return {
      type: 'insertion',
      insertionIndex: rowStart + rowCount,
      orientation: 'vertical',
      left: lastColumn * columnStride + cardWidth,
      top: rowTop,
      height: cardHeight
    }
  }

  const cardIndex = rowStart + Math.max(0, column)
  const cardLeft = Math.max(0, column) * columnStride
  const columnOffset = x - cardLeft
  const edgeWidth = Math.min(cardWidth / 3, Math.max(18, cardWidth * 0.2))
  if (columnOffset <= edgeWidth) {
    return {
      type: 'insertion',
      insertionIndex: cardIndex,
      orientation: 'vertical',
      left: cardLeft,
      top: rowTop,
      height: cardHeight
    }
  }
  if (columnOffset >= cardWidth - edgeWidth) {
    return {
      type: 'insertion',
      insertionIndex: cardIndex + 1,
      orientation: 'vertical',
      left: cardLeft + cardWidth,
      top: rowTop,
      height: cardHeight
    }
  }
  return { type: 'card', targetIndex: cardIndex }
}

export function planViewScrollSwitch(
  activeView,
  nextView,
  liveScrollTop,
  savedScrollTops,
  pendingView = null
) {
  const positions = { ...savedScrollTops }
  if (pendingView !== activeView) {
    positions[activeView] = Math.max(0, Number(liveScrollTop) || 0)
  }
  positions[nextView] = Math.max(0, Number(positions[nextView]) || 0)
  return {
    positions,
    restore: { view: nextView, scrollTop: positions[nextView] }
  }
}

export function chooseViewAfterClose(tabOrder, activeView, closingView, fallbackView = 'input') {
  const order = Array.isArray(tabOrder) ? tabOrder : []
  if (activeView !== closingView) return activeView
  const index = order.indexOf(closingView)
  if (index < 0) return fallbackView
  return order[index + 1] ?? order[index - 1] ?? fallbackView
}

function normalizePickerRelativePath(value) {
  const parts = String(value ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.')
  if (parts.length < 2 || parts.some((part) => part === '..')) return null
  return parts
}

export function groupDirectoryPickerFiles(files, isSupportedFile = () => true) {
  const groups = new Map()
  for (const file of Array.from(files ?? [])) {
    const parts = normalizePickerRelativePath(file?.webkitRelativePath)
    if (!parts) continue
    const rootName = parts[0]
    let group = groups.get(rootName)
    if (!group) {
      group = { name: rootName, files: [], directories: new Set(['']) }
      groups.set(rootName, group)
    }
    for (let index = 1; index < parts.length - 1; index += 1) {
      group.directories.add(parts.slice(1, index + 1).join('/'))
    }
    if (!isSupportedFile(file)) continue
    group.files.push({
      file,
      relativePath: parts.slice(1).join('/')
    })
  }
  return Array.from(groups.values()).map((group) => ({
    name: group.name,
    files: group.files,
    directories: Array.from(group.directories)
  }))
}

export function isDragLeavingDocument(event, documentElement) {
  if (!documentElement) return false

  const target = event?.target ?? null
  if (target === documentElement || target === documentElement.ownerDocument) return true

  const relatedTarget = event?.relatedTarget ?? null
  if (relatedTarget == null) return true
  try {
    return !documentElement.contains(relatedTarget)
  } catch {
    return true
  }
}

export function prepareManagedDuplicateCleanup(groups, protectedPaths = new Set()) {
  const protectedSet = protectedPaths instanceof Set ? protectedPaths : new Set(protectedPaths ?? [])
  let protectedCount = 0
  const cleanupGroups = (Array.isArray(groups) ? groups : []).map((group) => ({
    ...group,
    duplicates: (Array.isArray(group?.duplicates) ? group.duplicates : []).filter((duplicate) => {
      if (!protectedSet.has(String(duplicate?.relative_path ?? ''))) return true
      protectedCount += 1
      return false
    })
  })).filter((group) => group.duplicates.length)
  const duplicateCount = cleanupGroups.reduce((count, group) => count + group.duplicates.length, 0)
  const reclaimableBytes = cleanupGroups.reduce((total, group) => (
    total + group.duplicates.reduce((subtotal, duplicate) => subtotal + (Number(duplicate?.size) || 0), 0)
  ), 0)
  return { groups: cleanupGroups, duplicateCount, reclaimableBytes, protectedCount }
}

export function normalizeImagesPerExecution(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 1
  return Math.max(1, Math.min(9, Math.trunc(number)))
}

export function selectExecutionGroup(items, imagesPerExecution, dontConsume = false) {
  const source = Array.isArray(items) ? items : []
  const count = normalizeImagesPerExecution(imagesPerExecution)
  const eligible = source.filter((item) => (
    dontConsume
      ? item?.status === 'pending' || item?.status === 'queued'
      : item?.status === 'pending'
  ))
  const candidates = dontConsume && eligible.length === 0 ? source : eligible
  return candidates.slice(0, count)
}

function normalizeReservationMember(value) {
  if (!value || typeof value !== 'object') return null
  const id = String(value.id ?? '').trim()
  const annotated = String(value.annotated ?? '').trim()
  return id && annotated ? { id, annotated } : null
}

export function makeQueueReservationPayload(items) {
  const members = (Array.isArray(items) ? items : [])
    .map(normalizeReservationMember)
    .filter(Boolean)
  if (!members.length) return null
  const first = members[0]
  if (members.length === 1) return first
  return { ...first, items: members }
}

export function queueReservationMembers(payload) {
  if (!payload || typeof payload !== 'object') return []
  if (Object.hasOwn(payload, 'items')) {
    if (!Array.isArray(payload.items) || !payload.items.length) return []
    const members = payload.items.map(normalizeReservationMember)
    if (members.some((member) => member == null)) return []
    const ids = new Set(members.map((member) => member.id))
    if (ids.size !== members.length) return []
    const first = normalizeReservationMember(payload)
    if (first && (first.id !== members[0].id || first.annotated !== members[0].annotated)) return []
    return members
  }
  const member = normalizeReservationMember(payload)
  return member ? [member] : []
}

export function markReservedGroupQueued(items, payload, dontConsume = false, now = Date.now()) {
  if (dontConsume) return 0
  const members = queueReservationMembers(payload)
  if (!members.length) return 0
  const ids = new Set(members.map((member) => member.id))
  let changed = 0
  for (const item of Array.isArray(items) ? items : []) {
    if (!ids.has(item?.id)) continue
    item.status = 'queued'
    item.last_queued_at = now
    changed += 1
  }
  return changed
}

export function processedItemIdsFromDelta(delta) {
  if (!delta || typeof delta !== 'object' || delta.consumed === false) return []
  if (Array.isArray(delta.processed_items) && delta.processed_items.length) {
    const ids = delta.processed_items
      .map((item) => String(item?.id ?? '').trim())
      .filter(Boolean)
    return Array.from(new Set(ids))
  }
  const id = String(delta.processed_item_id ?? '').trim()
  return id ? [id] : []
}

export function completeExecutionGroupCount(pendingCount, imagesPerExecution) {
  const pending = Math.max(0, Math.floor(Number(pendingCount) || 0))
  const count = normalizeImagesPerExecution(imagesPerExecution)
  return Math.floor(pending / count)
}

export function calculateAutoQueueExtraExecutions(
  pendingCount,
  imagesPerExecution,
  requestedBatchCount = 1
) {
  const completeGroups = completeExecutionGroupCount(pendingCount, imagesPerExecution)
  const requested = Math.max(1, Math.floor(Number(requestedBatchCount) || 1))
  return Math.max(0, completeGroups - requested)
}

export function shouldReanchorGalleryResize(
  previousWidgetWidth,
  currentWidgetWidth,
  previousViewportWidth,
  currentViewportWidth
) {
  const previousWidget = Number(previousWidgetWidth)
  const currentWidget = Number(currentWidgetWidth)
  const previousViewport = Number(previousViewportWidth)
  const currentViewport = Number(currentViewportWidth)
  return Number.isFinite(previousWidget) && Number.isFinite(currentWidget) &&
    Number.isFinite(previousViewport) && Number.isFinite(currentViewport) &&
    previousWidget > 0 && currentWidget > 0 &&
    previousWidget !== currentWidget && previousViewport !== currentViewport
}

export const OUTPUT_MODE_PERSISTENT = 'persistent_refs'
export const OUTPUT_MODE_QUEUE_GROUP = 'queue_group'
export const REFERENCE_SLOT_COUNT = 8
const REFERENCE_IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'avif'
])

export function normalizeOutputMode(value, imagesPerExecution = 1, hasExplicitMode = true) {
  if (!hasExplicitMode) {
    return normalizeImagesPerExecution(imagesPerExecution) > 1
      ? OUTPUT_MODE_QUEUE_GROUP
      : OUTPUT_MODE_PERSISTENT
  }
  return value === OUTPUT_MODE_QUEUE_GROUP
    ? OUTPUT_MODE_QUEUE_GROUP
    : OUTPUT_MODE_PERSISTENT
}

export function effectiveQueueGroupSize(outputMode, imagesPerExecution) {
  return normalizeOutputMode(outputMode, imagesPerExecution, true) === OUTPUT_MODE_QUEUE_GROUP
    ? normalizeImagesPerExecution(imagesPerExecution)
    : 1
}

export function normalizeReferenceSlot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const annotated = String(value.annotated ?? '').trim()
  const type = String(value.type ?? 'input').trim().toLowerCase() || 'input'
  if (!annotated.endsWith(' [input]') || type !== 'input') return null
  const relativePath = annotated.slice(0, -' [input]'.length).trim().replaceAll('\\', '/')
  const parts = relativePath.split('/')
  const extension = parts.at(-1)?.split('.').at(-1)?.toLowerCase() ?? ''
  if (
    !relativePath || relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath) ||
    parts.some((part) => !part || part === '.' || part === '..') ||
    !REFERENCE_IMAGE_EXTENSIONS.has(extension)
  ) return null
  const filename = parts.at(-1)
  return {
    annotated: `${relativePath} [input]`,
    filename,
    subfolder: parts.slice(0, -1).join('/'),
    type: 'input'
  }
}

export function normalizeReferenceSlots(value) {
  const source = Array.isArray(value) ? value : []
  return Array.from({ length: REFERENCE_SLOT_COUNT }, (_, index) => (
    normalizeReferenceSlot(source[index])
  ))
}

export function updateReferenceSlot(slots, index, value) {
  const normalized = normalizeReferenceSlots(slots)
  const numericIndex = Math.trunc(Number(index))
  if (numericIndex < 0 || numericIndex >= REFERENCE_SLOT_COUNT) return normalized
  normalized[numericIndex] = normalizeReferenceSlot(value)
  return normalized
}

export function applyReferenceAssignments(state, startIndex, references) {
  const source = state && typeof state === 'object' ? state : {}
  const next = { ...source, reference_slots: normalizeReferenceSlots(source.reference_slots) }
  const start = Math.trunc(Number(startIndex))
  if (!Number.isFinite(start)) return next
  for (let offset = 0; offset < (Array.isArray(references) ? references.length : 0); offset += 1) {
    const index = start + offset
    if (index < 0 || index >= REFERENCE_SLOT_COUNT) break
    const reference = normalizeReferenceSlot(references[offset])
    if (reference) next.reference_slots[index] = reference
  }
  return next
}

export function referenceSlotsEqual(left, right) {
  const a = normalizeReferenceSlots(left)
  const b = normalizeReferenceSlots(right)
  return a.every((slot, index) => (
    slot?.annotated === b[index]?.annotated &&
    slot?.filename === b[index]?.filename &&
    slot?.subfolder === b[index]?.subfolder &&
    slot?.type === b[index]?.type
  ))
}

export function relinkReferenceSlots(slots, replacements) {
  const normalized = normalizeReferenceSlots(slots)
  const mapping = new Map()
  for (const entry of Array.isArray(replacements) ? replacements : []) {
    const oldPath = String(entry?.relative_path ?? '').trim().replaceAll('\\', '/')
    const keepPath = String(entry?.keep_path ?? '').trim().replaceAll('\\', '/')
    if (oldPath && keepPath) mapping.set(oldPath, keepPath)
  }
  let changed = 0
  for (let index = 0; index < normalized.length; index += 1) {
    const slot = normalized[index]
    if (!slot) continue
    const oldPath = slot.annotated.slice(0, -' [input]'.length)
    const keepPath = mapping.get(oldPath)
    if (!keepPath) continue
    const replacement = normalizeReferenceSlot({ annotated: `${keepPath} [input]`, type: 'input' })
    if (!replacement) continue
    normalized[index] = replacement
    changed += 1
  }
  return { slots: normalized, changed }
}

export function loadPresetSnapshot(preset) {
  return {
    activePresetId: String(preset?.id ?? '').trim(),
    slots: normalizeReferenceSlots(preset?.slots)
  }
}

export function classifyReferenceDrag(item, view, canReorder = false) {
  if (!item || typeof item !== 'object' || item.kind === 'folder') return null
  if (view === 'conveyor') return {
    kind: 'conveyor',
    requiresImport: false,
    canReorder: Boolean(canReorder)
  }
  if (view === 'input') return { kind: 'input', requiresImport: false, canReorder: false }
  if (item.localFile) return { kind: 'local', requiresImport: true, canReorder: false }
  return null
}

export function calculateReferenceShelfLayout(
  nodeWidth,
  widgetY,
  outputGutter = 112,
  titleHeight = 30
) {
  const width = Math.max(0, Number(nodeWidth) || 0)
  const bottom = Math.max(titleHeight, Number(widgetY) || 0)
  const left = 10
  const top = titleHeight + 2
  const right = Math.max(left, width - Math.max(72, Number(outputGutter) || 0))
  const availableWidth = Math.max(0, right - left)
  const headerHeight = 25
  const gap = 5
  const gridTop = top + headerHeight + gap
  const availableHeight = Math.max(0, bottom - gridTop - 5)
  const cellWidth = Math.max(0, (availableWidth - gap * 3) / 4)
  const cellHeight = Math.max(0, (availableHeight - gap) / 2)
  const slots = Array.from({ length: REFERENCE_SLOT_COUNT }, (_, index) => ({
    index,
    x: left + (index % 4) * (cellWidth + gap),
    y: gridTop + Math.floor(index / 4) * (cellHeight + gap),
    width: cellWidth,
    height: cellHeight
  }))
  return {
    left,
    top,
    right,
    bottom,
    headerHeight,
    gridTop,
    width: availableWidth,
    height: Math.max(0, bottom - top),
    slots,
    usable: cellWidth >= 38 && cellHeight >= 28
  }
}

export function referenceShelfHit(layout, x, y) {
  if (!layout?.usable) return null
  const px = Number(x)
  const py = Number(y)
  for (const slot of layout.slots ?? []) {
    if (px < slot.x || py < slot.y || px > slot.x + slot.width || py > slot.y + slot.height) continue
    const clearSize = Math.min(18, Math.max(10, slot.height * 0.28))
    const clear = px >= slot.x + slot.width - clearSize && py <= slot.y + clearSize
    return { type: clear ? 'clear' : 'slot', index: slot.index }
  }
  if (px >= layout.left && px <= layout.right && py >= layout.top && py <= layout.top + layout.headerHeight) {
    const menuWidth = Math.min(54, layout.width * 0.18)
    const saveWidth = Math.min(52, layout.width * 0.18)
    if (px >= layout.right - menuWidth) return { type: 'menu' }
    if (px >= layout.right - menuWidth - saveWidth) return { type: 'save' }
    return { type: 'preset' }
  }
  return null
}
