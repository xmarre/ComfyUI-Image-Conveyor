export const REFERENCE_TOGGLE_COUNT = 8

export function normalizeReferenceToggleMask(value, count = REFERENCE_TOGGLE_COUNT) {
  const normalizedCount = Math.max(0, Math.trunc(Number(count) || 0))
  const source = Array.isArray(value) ? value : []
  return Array.from({ length: normalizedCount }, (_, index) => source[index] !== false)
}

export function toggleReferenceToggleMask(value, index, count = REFERENCE_TOGGLE_COUNT) {
  const mask = normalizeReferenceToggleMask(value, count)
  const numericIndex = Math.trunc(Number(index))
  if (!Number.isFinite(numericIndex) || numericIndex < 0 || numericIndex >= mask.length) return mask
  mask[numericIndex] = !mask[numericIndex]
  return mask
}

export function filterReferenceOutputSlotsByToggleMask(slots, enabled, count = REFERENCE_TOGGLE_COUNT) {
  if (!Array.isArray(slots)) return slots
  const mask = normalizeReferenceToggleMask(enabled, count)
  return slots.filter((slot) => {
    if (!Number.isInteger(slot) || slot < 1 || slot > mask.length) return true
    return mask[slot - 1]
  })
}

export function applyReferenceToggleMaskToReservation(payload, enabled, count = REFERENCE_TOGGLE_COUNT) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  if (!Object.hasOwn(payload, 'reference_output_slots')) return payload
  const filtered = filterReferenceOutputSlotsByToggleMask(payload.reference_output_slots, enabled, count)
  if (!Array.isArray(filtered)) return payload
  return { ...payload, reference_output_slots: filtered }
}

export function calculateReferenceToggleRect(
  shelfRight,
  labelLeft,
  centerY,
  preferredWidth = 26,
  height = 14,
  gap = 7
) {
  const rightBoundary = Number(labelLeft) - Math.max(0, Number(gap) || 0)
  const leftBoundary = Number(shelfRight) + Math.max(0, Number(gap) || 0)
  const y = Number(centerY)
  const targetHeight = Math.max(10, Number(height) || 14)
  if (!Number.isFinite(rightBoundary) || !Number.isFinite(leftBoundary) || !Number.isFinite(y)) return null
  const availableWidth = rightBoundary - leftBoundary
  if (availableWidth < 18) return null
  const width = Math.min(Math.max(18, Number(preferredWidth) || 26), availableWidth)
  return {
    x: rightBoundary - width,
    y: y - targetHeight / 2,
    width,
    height: targetHeight
  }
}

export function referenceToggleHit(hitboxes, x, y) {
  const px = Number(x)
  const py = Number(y)
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null
  for (const hitbox of Array.isArray(hitboxes) ? hitboxes : []) {
    if (!hitbox || !Number.isInteger(hitbox.index)) continue
    const left = Number(hitbox.x)
    const top = Number(hitbox.y)
    const width = Number(hitbox.width)
    const height = Number(hitbox.height)
    if (![left, top, width, height].every(Number.isFinite)) continue
    if (px >= left && px <= left + width && py >= top && py <= top + height) return hitbox.index
  }
  return null
}
