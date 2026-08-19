import { normalizeReferenceSlots } from './image_conveyor_math.mjs'

export function referencePresetStateSnapshot(state) {
  const source = state && typeof state === 'object' ? state : {}
  const presetId = String(source.active_reference_preset_id ?? '').trim()
  const slots = normalizeReferenceSlots(source.reference_slots)
  return {
    presetId,
    slots,
    slotKey: JSON.stringify(slots.map((slot) => slot?.annotated || ''))
  }
}

export function shouldAutosaveReferencePreset(previous, current) {
  if (!previous || !current?.presetId) return false
  if (previous.presetId !== current.presetId) return false
  return previous.slotKey !== current.slotKey
}

export function referencePresetSaveKey(presetId, slots) {
  const normalizedId = String(presetId ?? '').trim()
  if (!normalizedId) return ''
  const normalizedSlots = normalizeReferenceSlots(slots)
  return `${normalizedId}:${JSON.stringify(normalizedSlots.map((slot) => slot?.annotated || ''))}`
}
