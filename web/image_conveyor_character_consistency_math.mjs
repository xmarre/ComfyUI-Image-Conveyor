import { normalizeReferenceSlots } from './image_conveyor_math.mjs'

export function referenceSlotSignature(slots) {
  return normalizeReferenceSlots(slots)
    .map((slot) => slot?.annotated || '')
    .join('\u0000')
}

export function referenceAutosaveTransition(previous, current) {
  if (!previous || !current) return null
  const previousPresetId = String(previous.presetId || '')
  const presetId = String(current.presetId || '')
  if (!presetId || presetId !== previousPresetId) return null
  const previousSignature = String(previous.signature ?? referenceSlotSignature(previous.slots))
  const signature = String(current.signature ?? referenceSlotSignature(current.slots))
  if (signature === previousSignature) return null
  return {
    presetId,
    signature,
    slots: normalizeReferenceSlots(current.slots)
  }
}
