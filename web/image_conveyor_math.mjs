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
