export function contextTargetIds(items, selectedIds, clickedId) {
  const source = Array.isArray(items) ? items : []
  const clicked = String(clickedId ?? '').trim()
  if (!clicked) return []
  const selected = selectedIds instanceof Set
    ? selectedIds
    : new Set(Array.from(selectedIds ?? [], (value) => String(value)))
  const target = selected.has(clicked)
    ? new Set(Array.from(selected, (value) => String(value)))
    : new Set([clicked])
  return source
    .map((item) => String(item?.id ?? '').trim())
    .filter((id) => id && target.has(id))
}

export function jumpPendingItemsToFront(items, selectedIds, clickedId) {
  const source = Array.isArray(items) ? items : []
  const targetIds = new Set(contextTargetIds(source, selectedIds, clickedId))
  const firstPendingIndex = source.findIndex((item) => item?.status === 'pending')
  if (firstPendingIndex < 0 || targetIds.size === 0) {
    return { items: source.slice(), movedIds: [], changed: false, boundaryIndex: -1 }
  }

  const jumpers = source.filter((item) => (
    item?.status === 'pending' && targetIds.has(String(item?.id ?? ''))
  ))
  if (!jumpers.length) {
    return {
      items: source.slice(),
      movedIds: [],
      changed: false,
      boundaryIndex: firstPendingIndex
    }
  }

  const jumperIds = new Set(jumpers.map((item) => String(item.id)))
  let insertionIndex = 0
  for (let index = 0; index < firstPendingIndex; index += 1) {
    if (!jumperIds.has(String(source[index]?.id ?? ''))) insertionIndex += 1
  }

  const remainder = source.filter((item) => !jumperIds.has(String(item?.id ?? '')))
  const next = [
    ...remainder.slice(0, insertionIndex),
    ...jumpers,
    ...remainder.slice(insertionIndex)
  ]
  const changed = next.some((item, index) => item !== source[index])
  return {
    items: next,
    movedIds: jumpers.map((item) => String(item.id)),
    changed,
    boundaryIndex: insertionIndex
  }
}

export function normalizeWheelDelta(deltaY, deltaMode, viewportHeight, lineHeight = 32) {
  const delta = Number(deltaY) || 0
  const mode = Math.trunc(Number(deltaMode) || 0)
  if (!delta) return 0
  if (mode === 1) return delta * Math.max(1, Number(lineHeight) || 32)
  if (mode === 2) return delta * Math.max(1, Number(viewportHeight) || 1) * 0.9
  return delta
}

export function dragEdgeAutoscrollConfig(viewportHeight) {
  const height = Math.max(1, Number(viewportHeight) || 1)
  return {
    edgeSize: Math.min(120, Math.max(56, height * 0.18)),
    maxSpeed: Math.min(1600, Math.max(900, height * 2.2))
  }
}

export function dragEdgeAutoscrollSpeed(clientY, top, bottom, edgeSize, maxSpeed) {
  const y = Number(clientY)
  const minY = Number(top)
  const maxY = Number(bottom)
  const edge = Math.max(1, Number(edgeSize) || 1)
  const speed = Math.max(0, Number(maxSpeed) || 0)
  if (!Number.isFinite(y) || !Number.isFinite(minY) || !Number.isFinite(maxY) || maxY <= minY || !speed) return 0

  let direction = 0
  let proximity = 0
  if (y < minY + edge) {
    direction = -1
    proximity = (minY + edge - y) / edge
  } else if (y > maxY - edge) {
    direction = 1
    proximity = (y - (maxY - edge)) / edge
  } else {
    return 0
  }

  const t = Math.min(1, Math.max(0, proximity))
  const smooth = t * t * (3 - 2 * t)
  return direction * speed * smooth
}
