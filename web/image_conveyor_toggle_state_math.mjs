export const REFERENCE_OUTPUT_ENABLED_KEY = 'reference_output_enabled'
export const MAIN_OUTPUT_ENABLED_KEY = 'main_output_enabled'
export const REFERENCE_TOGGLE_COUNT = 8

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
