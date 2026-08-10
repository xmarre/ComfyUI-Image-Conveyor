export const CARD_FOOTER_HEIGHT = 58

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

export function delegateGraphKeyboardEvent(event, processKey, receiver = null, graphTarget = null) {
  if (!event || event.defaultPrevented || event.isComposing || typeof processKey !== 'function') return false
  // Retarget the native event without reconstructing read-only legacy fields such as keyCode and which.
  const delegatedEvent = graphTarget && event.target !== graphTarget
    ? new Proxy(event, {
        get(source, property) {
          if (property === 'target') return graphTarget
          const value = Reflect.get(source, property, source)
          return typeof value === 'function' ? value.bind(source) : value
        }
      })
    : event
  processKey.call(receiver, delegatedEvent)
  return true
}

export function isConveyorDeleteShortcut(event) {
  if (!event || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  return event.key === 'Delete' || event.code === 'Delete'
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
