export const REFERENCE_OUTPUT_ENABLED_KEY = 'reference_output_enabled'
export const MAIN_OUTPUT_ENABLED_KEY = 'main_output_enabled'
export const LAST_FRAME_OUTPUT_ENABLED_KEY = 'last_frame_output_enabled'
export const REFERENCE_OUTPUT_SLOTS_KEY = 'reference_output_slots'
export const QUEUE_OUTPUT_SLOTS_KEY = 'queue_output_slots'
export const REFERENCE_TOGGLE_COUNT = 8
export const OUTPUT_MODE_PERSISTENT = 'persistent_refs'

export function normalizeReferenceEnabled(value, count = REFERENCE_TOGGLE_COUNT) {
  const size = Math.max(0, Math.trunc(Number(count) || 0))
  const source = Array.isArray(value) ? value : []
  return Array.from({ length: size }, (_, index) => source[index] !== false)
}

export function normalizeMainEnabled(value) {
  return value !== false
}

export function normalizeQueueOutputSlots(value) {
  const source = Array.isArray(value) ? value : []
  return Array.from(new Set(source.filter((slot) => (
    Number.isInteger(slot) && slot >= 0 && slot <= 1
  )))).sort((a, b) => a - b)
}

export function serializeToggleRuntimeState(
  rawState,
  referenceEnabled,
  mainEnabled,
  count = REFERENCE_TOGGLE_COUNT,
  lastFrameEnabled = true
) {
  let state
  try {
    state = JSON.parse(String(rawState ?? ''))
  } catch {
    return rawState
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return rawState

  const next = {
    ...state,
    [REFERENCE_OUTPUT_ENABLED_KEY]: normalizeReferenceEnabled(referenceEnabled, count),
    [MAIN_OUTPUT_ENABLED_KEY]: normalizeMainEnabled(mainEnabled),
    [LAST_FRAME_OUTPUT_ENABLED_KEY]: normalizeMainEnabled(lastFrameEnabled)
  }
  return JSON.stringify(next)
}

function parseQueuePayload(rawQueue) {
  const text = String(rawQueue ?? '')
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null
  } catch {
    return null
  }
}

function normalizeConnectedSlots(slots, count) {
  const limit = Math.max(0, Math.trunc(Number(count) || 0))
  const source = Array.isArray(slots) ? slots : []
  return Array.from(new Set(source.filter((slot) => (
    Number.isInteger(slot) && slot >= 1 && slot <= limit
  )))).sort((a, b) => a - b)
}

/**
 * Serialize the backend queue snapshot for persistent-reference mode.
 *
 * The snapshot always carries both independent topologies:
 * - queue_output_slots: queue-driven image roles (0=image, 1=last_frame)
 * - reference_output_slots: persistent shelf references (1..8)
 *
 * This remains explicit even when either topology is empty. Missing fields are
 * reserved for legacy prompts and must never be used to represent a disabled
 * output in a newly queued prompt.
 */
export function serializeToggleQueueSnapshot(
  rawQueue,
  outputMode,
  connectedReferenceSlots,
  referenceEnabled,
  mainEnabled,
  count = REFERENCE_TOGGLE_COUNT,
  connectedQueueSlots = [0],
  lastFrameEnabled = true
) {
  if (String(outputMode ?? '') !== OUTPUT_MODE_PERSISTENT) return rawQueue

  const parsed = parseQueuePayload(rawQueue)
  if (parsed == null) return rawQueue

  const enabled = normalizeReferenceEnabled(referenceEnabled, count)
  const connectedReferences = normalizeConnectedSlots(connectedReferenceSlots, enabled.length)
  const activeReferences = connectedReferences.filter((slot) => enabled[slot - 1])
  const main = normalizeMainEnabled(mainEnabled)
  const lastFrame = normalizeMainEnabled(lastFrameEnabled)
  const activeQueueSlots = normalizeQueueOutputSlots(connectedQueueSlots).filter((slot) => (
    slot === 0 ? main : lastFrame
  ))

  // Keep a reservation only when at least one queue-driven output is active.
  // In particular, last_frame-only mode must retain its one-image reservation
  // even though main_output_enabled is false.
  const next = activeQueueSlots.length ? { ...parsed } : {}
  next[REFERENCE_OUTPUT_SLOTS_KEY] = activeReferences
  next[QUEUE_OUTPUT_SLOTS_KEY] = activeQueueSlots
  next[MAIN_OUTPUT_ENABLED_KEY] = main
  next[LAST_FRAME_OUTPUT_ENABLED_KEY] = lastFrame
  return JSON.stringify(next)
}
