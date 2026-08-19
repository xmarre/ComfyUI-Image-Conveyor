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

/**
 * Remove branches that depend on disabled Image Conveyor outputs from a freshly
 * serialized ComfyUI API prompt.
 *
 * Invariant: no surviving serialized node may have a required input removed by
 * this pruner. Optional/unknown inputs are stopping boundaries; only the missing
 * link is removed there. A consumer whose proven-required input is removed is
 * unavailable as a whole, so all of its used outputs become unavailable and the
 * consumer is removed from the API prompt after propagation completes.
 *
 * The workflow/editor graph is never mutated. Only the API prompt copy is
 * changed, so disabled image-only output targets disappear while valid ref-only
 * conditioning/output paths remain intact.
 */
export function pruneDisabledOutputBranches(
  prompt,
  disabledOutputs,
  isRequiredInput = () => null
) {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return prompt

  const downstreamLinks = new Map()
  const usedOutputsByNode = new Map()

  for (const [consumerNodeId, node] of Object.entries(prompt)) {
    if (!node?.inputs || typeof node.inputs !== 'object') continue
    for (const [inputName, value] of Object.entries(node.inputs)) {
      const link = promptLink(value)
      if (!link) continue

      const key = `${link.nodeId}:${link.outputIndex}`
      const consumers = downstreamLinks.get(key) ?? []
      consumers.push({ nodeId: consumerNodeId, inputName })
      downstreamLinks.set(key, consumers)

      const used = usedOutputsByNode.get(link.nodeId) ?? new Set()
      used.add(link.outputIndex)
      usedOutputsByNode.set(link.nodeId, used)
    }
  }

  const unavailableOutputs = new Set()
  const unavailableNodes = new Set()
  const queue = []

  const enqueueOutput = (nodeId, outputIndex) => {
    const id = String(nodeId ?? '')
    const index = Number(outputIndex)
    if (!id || !Number.isInteger(index)) return
    const key = `${id}:${index}`
    if (unavailableOutputs.has(key)) return
    unavailableOutputs.add(key)
    queue.push(key)
  }

  const markNodeUnavailable = (nodeId) => {
    const id = String(nodeId ?? '')
    if (!id || unavailableNodes.has(id) || !Object.hasOwn(prompt, id)) return
    unavailableNodes.add(id)
    for (const outputIndex of usedOutputsByNode.get(id) ?? []) {
      enqueueOutput(id, outputIndex)
    }
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
    for (const consumer of downstreamLinks.get(unavailableKey) ?? []) {
      const node = prompt[consumer.nodeId]
      if (!node?.inputs || unavailableNodes.has(consumer.nodeId)) continue

      const currentLink = promptLink(node.inputs[consumer.inputName])
      if (!currentLink || `${currentLink.nodeId}:${currentLink.outputIndex}` !== unavailableKey) continue

      delete node.inputs[consumer.inputName]
      if (requirement(consumer.nodeId, consumer.inputName) === true) {
        markNodeUnavailable(consumer.nodeId)
      }
    }
  }

  for (const nodeId of unavailableNodes) delete prompt[nodeId]

  // Defensive final sweep: a removed required consumer must never leave a
  // dangling serialized link if another extension rewrote the prompt while this
  // filter was running.
  for (const node of Object.values(prompt)) {
    if (!node?.inputs || typeof node.inputs !== 'object') continue
    for (const [inputName, value] of Object.entries(node.inputs)) {
      const link = promptLink(value)
      if (link && !Object.hasOwn(prompt, link.nodeId)) delete node.inputs[inputName]
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
