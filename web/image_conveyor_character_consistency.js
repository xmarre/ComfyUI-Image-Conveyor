import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'
import { normalizeReferenceSlots } from './image_conveyor_math.mjs'
import {
  referenceAutosaveTransition,
  referenceSlotSignature
} from './image_conveyor_character_consistency_math.mjs'

const EXTENSION_NAME = 'Comfy.ImageConveyor.CharacterConsistency'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const STATE_WIDGET = 'state_json'
const INSTALL_RETRY_LIMIT = 120
const installedNodes = new WeakSet()

function stateWidget(node) {
  return (node?.widgets ?? []).find((widget) => widget?.name === STATE_WIDGET) ?? null
}

function parseState(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function snapshot(node) {
  const widget = stateWidget(node)
  const state = node?.__bil?.state ?? parseState(widget?.value)
  if (!state) return null
  const slots = normalizeReferenceSlots(state.reference_slots)
  return {
    presetId: String(state.active_reference_preset_id || ''),
    slots,
    signature: referenceSlotSignature(slots)
  }
}

function presetById(ctx, presetId) {
  return (ctx?.presets ?? []).find((preset) => String(preset?.id || '') === String(presetId || '')) ?? null
}

function replacePresetSlots(ctx, presetId, slots) {
  const preset = presetById(ctx, presetId)
  if (!preset) return null
  const previous = normalizeReferenceSlots(preset.slots)
  preset.slots = normalizeReferenceSlots(slots)
  return previous
}

function upsertPreset(ctx, preset) {
  if (!preset?.id) return
  const index = (ctx.presets ?? []).findIndex((entry) => String(entry?.id || '') === String(preset.id))
  const normalized = { ...preset, slots: normalizeReferenceSlots(preset.slots) }
  if (index >= 0) ctx.presets[index] = normalized
  else ctx.presets = [...(ctx.presets ?? []), normalized]
}

async function persistPreset(node, desired, revision) {
  const ctx = node.__bil
  const ext = ctx?.characterConsistency
  if (!ctx || !ext || ctx.removed) return
  const response = await api.fetchApi(
    `/image-conveyor/reference-presets/${encodeURIComponent(desired.presetId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots: desired.slots })
    }
  )
  let payload = null
  try { payload = await response.json() } catch {}
  if (!response.ok) throw new Error(payload?.error || `${response.status} ${response.statusText}`)

  const latest = ext.desiredByPreset.get(desired.presetId)
  if (!latest || latest.revision !== revision) return
  if (payload?.preset) upsertPreset(ctx, payload.preset)
  else replacePresetSlots(ctx, desired.presetId, desired.slots)
  ext.desiredByPreset.delete(desired.presetId)
  ext.autosaveFailureShown = false
  node.setDirtyCanvas?.(true, false)
}

function queuePresetAutosave(node, desired) {
  const ctx = node.__bil
  const ext = ctx?.characterConsistency
  if (!ctx || !ext || ctx.removed) return

  const preset = presetById(ctx, desired.presetId)
  if (preset && referenceSlotSignature(preset.slots) === desired.signature) return

  const revision = ++ext.saveRevision
  const previousSlots = preset ? replacePresetSlots(ctx, desired.presetId, desired.slots) : null
  ext.desiredByPreset.set(desired.presetId, { ...desired, revision })
  node.setDirtyCanvas?.(true, false)

  ext.saveChain = ext.saveChain
    .catch(() => {})
    .then(async () => {
      const latest = ext.desiredByPreset.get(desired.presetId)
      if (!latest || latest.revision !== revision) return
      await persistPreset(node, desired, revision)
    })
    .catch((error) => {
      const latest = ext.desiredByPreset.get(desired.presetId)
      if (!latest || latest.revision !== revision) return
      ext.desiredByPreset.delete(desired.presetId)
      if (previousSlots) replacePresetSlots(ctx, desired.presetId, previousSlots)
      ctx.presetsLoaded = false
      node.setDirtyCanvas?.(true, false)
      console.error('Image Conveyor: character reference autosave failed.', error)
      if (!ext.autosaveFailureShown) {
        ext.autosaveFailureShown = true
        window.alert(
          `Character preset autosave failed: ${error?.message || error}. ` +
          'The current Reference Shelf remains in the workflow; use Save after resolving the error.'
        )
      }
    })
}

function observe(node) {
  const ctx = node.__bil
  const ext = ctx?.characterConsistency
  if (!ctx || !ext || ctx.removed) return
  const current = snapshot(node)
  if (!current) return
  const previous = ext.lastSnapshot
  ext.lastSnapshot = current
  const desired = referenceAutosaveTransition(previous, current)
  if (desired) queuePresetAutosave(node, desired)
}

function installNode(node, attempts = 0) {
  if (!node || installedNodes.has(node) || attempts > INSTALL_RETRY_LIMIT) return
  const type = String(node?.comfyClass || node?.type || '')
  if (!NODE_CLASSES.has(type)) return
  const ctx = node.__bil
  const widget = stateWidget(node)
  if (!ctx || !widget) {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }

  installedNodes.add(node)
  const ext = {
    lastSnapshot: snapshot(node),
    saveRevision: 0,
    saveChain: Promise.resolve(),
    desiredByPreset: new Map(),
    autosaveFailureShown: false
  }
  ctx.characterConsistency = ext

  const previousCallback = widget.callback
  widget.callback = function (value, ...args) {
    const result = previousCallback?.call(this, value, ...args)
    queueMicrotask(() => observe(node))
    return result
  }

  const previousDraw = node.onDrawForeground
  node.onDrawForeground = function (...args) {
    const result = previousDraw?.apply(this, args)
    observe(node)
    return result
  }

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    ext.desiredByPreset.clear()
    return previousRemoved?.apply(this, args)
  }
}

app.registerExtension({
  name: EXTENSION_NAME,
  nodeCreated(node) {
    const type = String(node?.comfyClass || node?.type || '')
    if (!NODE_CLASSES.has(type)) return
    queueMicrotask(() => installNode(node))
  },
  afterConfigureGraph() {
    for (const node of app.rootGraph?.computeExecutionOrder?.(false) ?? []) installNode(node)
  }
})
