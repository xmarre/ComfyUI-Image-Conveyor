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

export function normalizeMainOutputEnabled(value) {
  return value !== false
}

export function toggleMainOutputEnabled(value) {
  return !normalizeMainOutputEnabled(value)
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

export function applyMainOutputToggleToReservation(payload, enabled) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  if (normalizeMainOutputEnabled(enabled)) {
    return { ...payload, main_output_enabled: true }
  }

  // A disabled main output must never carry a conveyor reservation. Keeping an
  // id/items member would make the core afterQueued hook mark that image queued
  // even though the backend intentionally does not select or consume it.
  const referenceOnly = { main_output_enabled: false }
  if (Object.hasOwn(payload, 'reference_output_slots')) {
    referenceOnly.reference_output_slots = payload.reference_output_slots
  }
  return referenceOnly
}

/**
 * Resolve whether an input is required from ComfyUI's authoritative V1 node
 * definition schema returned by /object_info. Returns null when the definition
 * does not describe the input.
 */
export function inputRequiredFromNodeDef(nodeDef, inputName) {
  const name = String(inputName ?? '')
  const required = nodeDef?.input?.required
  if (required && typeof required === 'object' && Object.hasOwn(required, name)) return true
  const optional = nodeDef?.input?.optional
  if (optional && typeof optional === 'object' && Object.hasOwn(optional, name)) return false
  return null
}

function promptLink(value) {
  if (!Array.isArray(value) || value.length !== 2) return null
  const nodeId = String(value[0] ?? '')
  const outputIndex = Number(value[1])
  if (!nodeId || !Number.isInteger(outputIndex)) return null
  return { nodeId, outputIndex }
}

function usedOutputIndexes(prompt, sourceNodeId) {
  const sourceId = String(sourceNodeId)
  const indexes = new Set()
  for (const node of Object.values(prompt)) {
    if (!node?.inputs || typeof node.inputs !== 'object') continue
    for (const value of Object.values(node.inputs)) {
      const link = promptLink(value)
      if (link?.nodeId === sourceId) indexes.add(link.outputIndex)
    }
  }
  return indexes
}

/**
 * Remove disabled output branches from a freshly serialized ComfyUI API prompt.
 *
 * The important invariant is that pruning never deletes serialized nodes. A
 * disabled value is propagated through required-only transforms by marking the
 * transform's used outputs unavailable, then the connection is severed at the
 * first optional/unknown input boundary. The now-invalid required transforms are
 * left in the prompt but become unreachable from surviving output nodes, so
 * ComfyUI neither validates nor executes them.
 *
 * This is deliberately less destructive than recursively deleting nodes. A
 * prompt transformer must not manufacture `prompt_no_outputs` simply because a
 * disabled first-frame branch happens to pass through required preprocessing.
 * The workflow graph itself is never mutated, so editor links remain connected
 * and saved workflow topology is unchanged.
 */
export function pruneDisabledOutputBranches(
  prompt,
  disabledOutputs,
  isRequiredInput = () => null
) {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return prompt

  const unavailable = new Set()
  const queue = []
  const enqueueOutput = (nodeId, outputIndex) => {
    const id = String(nodeId ?? '')
    const index = Number(outputIndex)
    if (!id || !Number.isInteger(index)) return
    const key = `${id}:${index}`
    if (unavailable.has(key)) return
    unavailable.add(key)
    queue.push(key)
  }

  for (const source of Array.isArray(disabledOutputs) ? disabledOutputs : []) {
    const nodeId = String(source?.nodeId ?? '')
    if (!nodeId) continue
    for (const value of Array.isArray(source?.outputIndexes) ? source.outputIndexes : []) {
      enqueueOutput(nodeId, value)
    }
  }
  if (!queue.length) return prompt

  const requirement = (nodeId, inputName) => {
    try {
      const value = isRequiredInput(String(nodeId), String(inputName))
      if (value === true) return true
      if (value === false) return false
      return null
    } catch {
      return null
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const unavailableKey = queue[cursor]
    for (const [nodeId, node] of Object.entries(prompt)) {
      if (!node?.inputs || typeof node.inputs !== 'object') continue
      for (const [inputName, value] of Object.entries(node.inputs)) {
        const link = promptLink(value)
        if (!link || `${link.nodeId}:${link.outputIndex}` !== unavailableKey) continue

        // Always remove the unavailable link itself. If this was a required
        // input, the consumer can no longer produce any valid output, so taint
        // every output index from that consumer that is actually used by the
        // serialized prompt. Optional/unknown inputs are the stopping boundary.
        delete node.inputs[inputName]
        if (requirement(nodeId, inputName) !== true) continue

        for (const outputIndex of usedOutputIndexes(prompt, nodeId)) {
          enqueueOutput(nodeId, outputIndex)
        }
      }
    }
  }

  return prompt
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
