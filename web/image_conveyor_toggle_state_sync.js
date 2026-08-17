import { app } from '../../scripts/app.js'
import {
  normalizeMainEnabled,
  normalizeReferenceEnabled,
  serializeToggleQueueSnapshot,
  serializeToggleRuntimeState
} from './image_conveyor_toggle_state_math.mjs?v=20260817c'

const EXTENSION_NAME = 'Comfy.ImageConveyor.ToggleStateWidgetGuard'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const STATE_WIDGET = 'state_json'
const QUEUE_WIDGET = 'queue_item_json'
const OUTPUT_MODE_PERSISTENT = 'persistent_refs'
const REFERENCE_PROPERTY_KEY = 'image_conveyor_reference_enabled'
const MAIN_PROPERTY_KEY = 'image_conveyor_main_enabled'
const REFERENCE_SLOT_COUNT = 8
const REFERENCE_OUTPUT_START_INDEX = 6
const INSTALL_RETRY_LIMIT = 120
const guardedNodes = new WeakSet()

function widgetByName(node, name) {
  return (node?.widgets ?? []).find((widget) => widget?.name === name) ?? null
}

function currentReferenceEnabled(node) {
  return normalizeReferenceEnabled(
    node?.properties?.[REFERENCE_PROPERTY_KEY],
    REFERENCE_SLOT_COUNT
  )
}

function currentMainEnabled(node) {
  return normalizeMainEnabled(node?.properties?.[MAIN_PROPERTY_KEY])
}

function outputMode(node) {
  const cached = node?.__bil?.state?.output_mode
  if (cached) return String(cached)
  const stateWidget = widgetByName(node, STATE_WIDGET)
  if (typeof stateWidget?.value !== 'string') return ''
  try {
    return String(JSON.parse(stateWidget.value)?.output_mode ?? '')
  } catch {
    return ''
  }
}

function referenceOutputIndex(node, slotIndex) {
  const expected = `ref_image_${slotIndex + 1}`
  const outputs = Array.isArray(node?.outputs) ? node.outputs : []
  const named = outputs.findIndex((output) => (
    String(output?.name ?? '') === expected || String(output?.label ?? '') === expected
  ))
  if (named >= 0) return named
  const fallback = REFERENCE_OUTPUT_START_INDEX + slotIndex
  return fallback < outputs.length ? fallback : -1
}

function connectedReferenceSlots(node) {
  const slots = []
  for (let index = 0; index < REFERENCE_SLOT_COUNT; index += 1) {
    const outputIndex = referenceOutputIndex(node, index)
    const links = outputIndex >= 0 ? node?.outputs?.[outputIndex]?.links : null
    if (Array.isArray(links) && links.length > 0) slots.push(index + 1)
  }
  return slots
}

function runtimeStateValue(node, raw) {
  return serializeToggleRuntimeState(
    raw,
    currentReferenceEnabled(node),
    currentMainEnabled(node),
    REFERENCE_SLOT_COUNT
  )
}

function runtimeQueueValue(node, raw) {
  return serializeToggleQueueSnapshot(
    raw,
    outputMode(node),
    connectedReferenceSlots(node),
    currentReferenceEnabled(node),
    currentMainEnabled(node),
    REFERENCE_SLOT_COUNT
  )
}

function preserveStateValue(node, stateWidget) {
  const next = runtimeStateValue(node, stateWidget.value)
  if (typeof next === 'string' && next !== stateWidget.value) stateWidget.value = next
  return stateWidget.value
}

function preserveQueueValue(node, queueWidget) {
  const next = runtimeQueueValue(node, queueWidget.value)
  if (typeof next === 'string' && next !== queueWidget.value) queueWidget.value = next
  return queueWidget.value
}

function wrapSerializer(widget, transform) {
  const previousSerializeValue = widget.serializeValue
  widget.serializeValue = function (...args) {
    const raw = typeof previousSerializeValue === 'function'
      ? previousSerializeValue.apply(this, args)
      : this.value
    if (raw && typeof raw.then === 'function') return raw.then(transform)
    return transform(raw)
  }
}

function installNode(node, attempts = 0) {
  if (!node || attempts > INSTALL_RETRY_LIMIT || guardedNodes.has(node)) return
  const type = String(node?.comfyClass || node?.type || '')
  if (!NODE_CLASSES.has(type)) return

  const stateWidget = widgetByName(node, STATE_WIDGET)
  const queueWidget = widgetByName(node, QUEUE_WIDGET)
  if (!stateWidget || !queueWidget || typeof queueWidget.beforeQueued !== 'function') {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }
  guardedNodes.add(node)

  // Core state serialization intentionally normalizes its historical schema.
  // Re-embed toggle state after every callback-driven rewrite and again at the
  // final widget serialization boundary so state_json remains cache-significant.
  const previousStateCallback = stateWidget.callback
  stateWidget.callback = function (value, ...args) {
    const result = previousStateCallback?.call(this, value, ...args)
    preserveStateValue(node, stateWidget)
    return result
  }
  wrapSerializer(stateWidget, (raw) => runtimeStateValue(node, raw))
  preserveStateValue(node, stateWidget)

  // queue_item_json is the backend's released topology contract. Crucially,
  // always serialize reference_output_slots in persistent mode even when there
  // is no main Conveyor reservation. Without that field the backend deliberately
  // falls back to the legacy "all slots active" behavior.
  const previousBeforeQueued = queueWidget.beforeQueued
  queueWidget.beforeQueued = function (...args) {
    const result = previousBeforeQueued?.apply(this, args)
    preserveQueueValue(node, queueWidget)
    return result
  }
  wrapSerializer(queueWidget, (raw) => runtimeQueueValue(node, raw))

  // Do not eagerly create a queue snapshot before a queue action. The core
  // beforeQueued hook first freezes any real reservation; our wrapper then adds
  // the filtered topology without disturbing normal reservation ordering.
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
