function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

export function reorderSelectedItems(items, selectedIds, insertionIndex) {
  const source = Array.isArray(items) ? items : []
  const selected = new Set(Array.from(selectedIds ?? []).map((value) => String(value)))
  if (!source.length || !selected.size) return { items: source.slice(), changed: false }

  const moving = []
  const remaining = []
  const selectedIndexes = []
  source.forEach((item, index) => {
    const id = String(item?.id ?? '')
    if (id && selected.has(id)) {
      moving.push(item)
      selectedIndexes.push(index)
    } else {
      remaining.push(item)
    }
  })
  if (!moving.length || moving.length === source.length) {
    return { items: source.slice(), changed: false }
  }

  const rawInsertion = clamp(Number.isFinite(Number(insertionIndex)) ? Number(insertionIndex) : 0, 0, source.length)
  const removedBefore = selectedIndexes.reduce(
    (count, index) => count + Number(index < rawInsertion),
    0
  )
  const destination = clamp(rawInsertion - removedBefore, 0, remaining.length)
  const next = [
    ...remaining.slice(0, destination),
    ...moving,
    ...remaining.slice(destination)
  ]
  const changed = next.some((item, index) => item !== source[index])
  return { items: next, changed }
}

export function cardIntentInsertionIndex(items, draggedId, targetId) {
  const source = Array.isArray(items) ? items : []
  const draggedIndex = source.findIndex((item) => String(item?.id ?? '') === String(draggedId ?? ''))
  const targetIndex = source.findIndex((item) => String(item?.id ?? '') === String(targetId ?? ''))
  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) return -1
  return draggedIndex < targetIndex ? targetIndex + 1 : targetIndex
}
