export const REFERENCE_OUTPUT_ENABLED_KEY = 'reference_output_enabled'
export const MAIN_OUTPUT_ENABLED_KEY = 'main_output_enabled'
export const REFERENCE_OUTPUT_SLOTS_KEY = 'reference_output_slots'
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

export function serializeToggleRuntimeState(
  rawState,
  referenceEnabled,
  mainEnabled,
  count = REFERENCE_TOGGLE_COUNT
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
    [MAIN_OUTPUT_ENABLED_KEY]: normalizeMainEnabled(mainEnabled)
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
 * Unlike the historical snapshot helper, this deliberately emits a snapshot
 * even when there is no main Conveyor reservation. That distinction matters:
 * absence of reference_output_slots is the backend's legacy compatibility
 * signal meaning "all reference outputs may be active". A disabled reference
 * therefore must never be represented by an absent snapshot.
 */
export function serializeToggleQueueSnapshot(
  rawQueue,
  outputMode,
  connectedReferenceSlots,
  referenceEnabled,
  mainEnabled,
  count = REFERENCE_TOGGLE_COUNT
) {
  if (String(outputMode ?? '') !== OUTPUT_MODE_PERSISTENT) return rawQueue

  const parsed = parseQueuePayload(rawQueue)
  if (parsed == null) return rawQueue

  const enabled = normalizeReferenceEnabled(referenceEnabled, count)
  const connected = normalizeConnectedSlots(connectedReferenceSlots, enabled.length)
  const activeSlots = connected.filter((slot) => enabled[slot - 1])
  const main = normalizeMainEnabled(mainEnabled)

  // A disabled main output must not retain a queued Conveyor reservation;
  // afterQueued would otherwise mark an image queued even though the backend
  // intentionally does not select or consume it.
  const next = main ? { ...parsed } : {}
  next[REFERENCE_OUTPUT_SLOTS_KEY] = activeSlots
  next[MAIN_OUTPUT_ENABLED_KEY] = main
  return JSON.stringify(next)
}
