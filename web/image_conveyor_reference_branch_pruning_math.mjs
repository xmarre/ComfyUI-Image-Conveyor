export function disabledReferenceOutputIndexes(enabledMask, outputIndexes) {
  const mask = Array.isArray(enabledMask) ? enabledMask : []
  const indexes = Array.isArray(outputIndexes) ? outputIndexes : []
  const disabled = []
  const seen = new Set()

  for (let slot = 0; slot < indexes.length; slot += 1) {
    if (mask[slot] !== false) continue
    const outputIndex = Number(indexes[slot])
    if (!Number.isInteger(outputIndex) || outputIndex < 0 || seen.has(outputIndex)) continue
    seen.add(outputIndex)
    disabled.push(outputIndex)
  }

  return disabled
}
