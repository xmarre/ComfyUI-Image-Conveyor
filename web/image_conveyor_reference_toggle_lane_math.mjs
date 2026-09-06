export const REFERENCE_TOGGLE_LANE_RESERVE = 28
export const REFERENCE_OUTPUT_GUTTER_MINIMUM = 72
export const REFERENCE_OUTPUT_LABEL_PADDING = 30

export function referenceOutputGutterFromLabelWidths(
  labelWidths,
  minimum = REFERENCE_OUTPUT_GUTTER_MINIMUM,
  padding = REFERENCE_OUTPUT_LABEL_PADDING
) {
  const source = Array.isArray(labelWidths) ? labelWidths : []
  const floor = Math.max(0, Number(minimum) || 0)
  const pad = Math.max(0, Number(padding) || 0)
  let gutter = Math.max(REFERENCE_OUTPUT_GUTTER_MINIMUM, floor)

  for (const value of source) {
    const width = Number(value)
    if (!Number.isFinite(width)) continue
    gutter = Math.max(gutter, Math.max(0, width) + pad)
  }
  return gutter
}

export function reserveReferenceToggleGutter(outputGutter, reserve = REFERENCE_TOGGLE_LANE_RESERVE) {
  const gutter = Math.max(REFERENCE_OUTPUT_GUTTER_MINIMUM, Number(outputGutter) || 0)
  const lane = Math.max(0, Number(reserve) || 0)
  return gutter + lane
}
