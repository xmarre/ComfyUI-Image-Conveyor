import { app } from '../../scripts/app.js'
import {
  makeQueueReservationPayload,
  selectExecutionGroup
} from './image_conveyor_math.mjs?v=64d0259bdfdbb853'
import {
  normalizeMainEnabled,
  normalizeReferenceEnabled,
  serializeToggleQueueSnapshot,
  serializeToggleRuntimeState
} from './image_conveyor_toggle_state_math.mjs?v=20260817d'

const EXTENSION_NAME = 'Comfy.ImageConveyor.ToggleStateWidgetGuard'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const STATE_WIDGET = 'state_json'
const QUEUE_WIDGET = 'queue_item_json'
const OUTPUT_MODE_PERSISTENT = 'persistent_refs'
const REFERENCE_PROPERTY_KEY = 'image_conveyor_reference_enabled'
const MAIN_PROPERTY_KEY = 'image_conveyor_main_enabled'
const LAST_FRAME_PROPERTY_KEY = 'image_conveyor_last_frame_enabled'
const REFERENCE_SLOT_COUNT = 8
const REFERENCE_OUTPUT_START_INDEX = 6
const LAST_FRAME_OUTPUT_FALLBACK_INDEX = 14
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

function currentLastFrameEnabled(node) {
  return normalizeMainEnabled(node?.properties?.[LAST_FRAME_PROPERTY_KEY])
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

function outputIndexByName(node, expected, fallback = -1) {
  const outputs = Array.isArray(node?.outputs) ? node.outputs : []
  const named = outputs.findIndex((output) => (
    String(output?.name ?? '') === expected || String(output?.label ?? '') === expected
  ))
  if (named >= 0) return named
  return fallback >= 0 && fallback < outputs.length ? fallback : -1
}

function referenceOutputIndex(node, slotIndex) {
  return outputIndexByName(
    node,
    `ref_image_${slotIndex + 1}`,
    REFERENCE_OUTPUT_START_INDEX + slotIndex
  )
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

function outputConnected(node, name, fallback) {
  const index = outputIndexByName(node, name, fallback)
  const links = index >= 0 ? node?.outputs?.[index]?.links : null
  return Array.isArray(links) && links.length > 0
}

function connectedQueueSlots(node) {
  if (outputMode(node) !== OUTPUT_MODE_PERSISTENT) return []
  const slots = []
  if (currentMainEnabled(node) && outputConnected(node, 'image', 0)) slots.push(0)
  if (
    currentLastFrameEnabled(node) &&
    outputConnected(node, 'last_frame', LAST_FRAME_OUTPUT_FALLBACK_INDEX)
  ) {
    slots.push(1)
  }
  return slots
}

function runtimeStateValue(node, raw) {
  return serializeToggleRuntimeState(
    raw,
    currentReferenceEnabled(node),
    currentMainEnabled(node),
    REFERENCE_SLOT_COUNT,
    currentLastFrameEnabled(node)
  )
}

function runtimeQueueValue(node, raw) {
  return serializeToggleQueueSnapshot(
    raw,
    outputMode(node),
    connectedReferenceSlots(node),
    currentReferenceEnabled(node),
    currentMainEnabled(node),
    REFERENCE_SLOT_COUNT,
    connectedQueueSlots(node),
    currentLastFrameEnabled(node)
  )
}

function preserveStateValue(node, stateWidget) {
  const next = runtimeStateValue(node, stateWidget.value)
  if (typeof next === 'string' && next !== stateWidget.value) stateWidget.value = next
  return stateWidget.value
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

function currentQueueState(node, stateWidget) {
  if (node?.__bil?.state && typeof node.__bil.state === 'object') return node.__bil.state
  try {
    const parsed = JSON.parse(String(stateWidget?.value ?? ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function buildPersistentQueueValue(node, stateWidget) {
  const queueSlots = connectedQueueSlots(node)
  const state = currentQueueState(node, stateWidget)
  let reservation = null

  if (queueSlots.length && state) {
    const group = selectExecutionGroup(
      Array.isArray(state.items) ? state.items : [],
      queueSlots.length,
      Boolean(state.dont_consume)
    )
    if (group.length === queueSlots.length) reservation = makeQueueReservationPayload(group)
  }

  const raw = reservation ? JSON.stringify(reservation) : '{}'
  return runtimeQueueValue(node, raw)
}

function authoritativeQueueValue(node, stateWidget, raw) {
  if (outputMode(node) !== OUTPUT_MODE_PERSISTENT) return runtimeQueueValue(node, raw)
  return buildPersistentQueueValue(node, stateWidget)
}

function replacePersistentReservation(node, stateWidget, queueWidget) {
  if (outputMode(node) !== OUTPUT_MODE_PERSISTENT) return
  const next = buildPersistentQueueValue(node, stateWidget)
  queueWidget.value = next
  queueWidget.callback?.(next)
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

  // The core persistent reservation is historically fixed at one queue image.
  // Let it run first for compatibility, then replace that reservation with the
  // exact 0/1/2 members required by the connected+enabled image roles.
  const previousBeforeQueued = queueWidget.beforeQueued
  queueWidget.beforeQueued = function (...args) {
    const result = previousBeforeQueued?.apply(this, args)
    replacePersistentReservation(node, stateWidget, queueWidget)
    return result
  }

  // Other extensions from older revisions may also wrap beforeQueued and can
  // rewrite the transient widget after our wrapper. Rebuild the reservation at
  // the actual serialization boundary, where the API prompt gets its value.
  wrapSerializer(
    queueWidget,
    (raw) => authoritativeQueueValue(node, stateWidget, raw)
  )

  // afterQueued marks the frozen reservation members as queued. Rebuild the
  // authoritative value immediately before that lifecycle hook too, so wrapper
  // registration order cannot make last_frame-only mode lose its reservation.
  const previousAfterQueued = queueWidget.afterQueued
  queueWidget.afterQueued = function (...args) {
    replacePersistentReservation(node, stateWidget, queueWidget)
    return previousAfterQueued?.apply(this, args)
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
