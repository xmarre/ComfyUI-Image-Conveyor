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
