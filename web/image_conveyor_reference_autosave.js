import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'
import {
  referencePresetSaveKey,
  referencePresetStateSnapshot,
  shouldAutosaveReferencePreset
} from './image_conveyor_reference_autosave_math.mjs'

const EXTENSION_NAME = 'Comfy.ImageConveyor.ReferencePresetAutosave'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const STATE_WIDGET = 'state_json'
const MAX_SAVE_ATTEMPTS = 3
const RETRY_BASE_MS = 400

const controllers = new WeakMap()

function cloneSlots(slots) {
  return slots.map((slot) => (slot ? { ...slot } : null))
}

function readState(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function stateWidget(node) {
  return (node.widgets ?? []).find((widget) => widget?.name === STATE_WIDGET) ?? null
}

function updateCachedPreset(node, snapshot) {
  const presets = node.__bil?.presets
  if (!Array.isArray(presets)) return
  const preset = presets.find((entry) => String(entry?.id || '') === snapshot.presetId)
  if (preset) preset.slots = cloneSlots(snapshot.slots)
}

function scheduleRetry(node, controller, attempts) {
  if (controller.retryTimer) return
  controller.retryTimer = setTimeout(() => {
    controller.retryTimer = 0
    void drainSaves(node, controller)
  }, RETRY_BASE_MS * Math.max(1, attempts))
}

async function saveSnapshot(snapshot) {
  const response = await api.fetchApi(
    `/image-conveyor/reference-presets/${encodeURIComponent(snapshot.presetId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots: snapshot.slots })
    }
  )

  let payload = null
  try { payload = await response.json() } catch {}
  if (!response.ok) {
    throw new Error(payload?.error || `${response.status} ${response.statusText}`)
  }
  return payload?.preset ?? null
}

async function drainSaves(node, controller) {
  if (controller.saving) return
  controller.saving = true
  try {
    while (controller.pending.size) {
      const [presetId, entry] = controller.pending.entries().next().value
      controller.pending.delete(presetId)

      const key = referencePresetSaveKey(presetId, entry.snapshot.slots)
      if (!key || controller.savedKeys.get(presetId) === key) continue

      try {
        await saveSnapshot(entry.snapshot)
        controller.savedKeys.set(presetId, key)
      } catch (error) {
        const newer = controller.pending.get(presetId)
        const attempts = entry.attempts + 1
        if (!newer && attempts < MAX_SAVE_ATTEMPTS) {
          controller.pending.set(presetId, { ...entry, attempts })
          scheduleRetry(node, controller, attempts)
        } else if (newer) {
          scheduleRetry(node, controller, newer.attempts || 1)
        } else {
          console.error(
            `Image Conveyor: failed to autosave reference preset '${presetId}' after ${MAX_SAVE_ATTEMPTS} attempts.`,
            error
          )
          if (controller.pending.size) scheduleRetry(node, controller, 1)
        }
        return
      }
    }
  } finally {
    controller.saving = false
  }
}

function queueSave(node, controller, snapshot) {
  updateCachedPreset(node, snapshot)
  controller.pending.set(snapshot.presetId, {
    snapshot: {
      presetId: snapshot.presetId,
      slots: cloneSlots(snapshot.slots),
      slotKey: snapshot.slotKey
    },
    attempts: 0
  })
  if (controller.retryTimer) {
    clearTimeout(controller.retryTimer)
    controller.retryTimer = 0
  }
  void drainSaves(node, controller)
}

function observeState(node, controller, raw) {
  const parsed = readState(raw)
  if (!parsed) return
  const current = referencePresetStateSnapshot(parsed)
  const previous = controller.lastSnapshot
  controller.lastSnapshot = current

  // Loading/configuring/switching presets changes the active preset id and must never write.
  // Autosave only owns edits made while the same named preset remains active.
  if (!shouldAutosaveReferencePreset(previous, current)) return
  queueSave(node, controller, current)
}

function installNode(node, attempts = 0) {
  if (!node || attempts > 120 || controllers.has(node)) return
  const ctx = node.__bil
  const widget = stateWidget(node)
  if (!ctx || !widget) {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }

  const initialState = readState(widget.value)
  const controller = {
    lastSnapshot: referencePresetStateSnapshot(initialState ?? {}),
    pending: new Map(),
    savedKeys: new Map(),
    saving: false,
    retryTimer: 0
  }
  controllers.set(node, controller)

  const previousCallback = widget.callback
  const wrappedCallback = function (...args) {
    const result = previousCallback?.apply(this, args)
    observeState(node, controller, widget.value)
    return result
  }
  widget.callback = wrappedCallback

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    if (widget.callback === wrappedCallback) widget.callback = previousCallback
    // Pending/in-flight saves deliberately continue from their immutable snapshots after node
    // removal so closing/reloading a workflow cannot discard the user's latest preset edit.
    return previousRemoved?.apply(this, args)
  }
}

app.registerExtension({
  name: EXTENSION_NAME,
  nodeCreated(node) {
    const type = String(node?.comfyClass || node?.type || '')
    if (!NODE_CLASSES.has(type)) return
    queueMicrotask(() => installNode(node))
  }
})
