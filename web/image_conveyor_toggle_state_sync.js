import { app } from '../../scripts/app.js'
import {
  normalizeMainEnabled,
  normalizeReferenceEnabled,
  serializeToggleRuntimeState
} from './image_conveyor_toggle_state_math.mjs?v=20260817a'

const EXTENSION_NAME = 'Comfy.ImageConveyor.ToggleRuntimeState'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const STATE_WIDGET = 'state_json'
const QUEUE_WIDGET = 'queue_item_json'
const REFERENCE_PROPERTY_KEY = 'image_conveyor_reference_enabled'
const MAIN_PROPERTY_KEY = 'image_conveyor_main_enabled'
const REFERENCE_SLOT_COUNT = 8
const INSTALL_RETRY_LIMIT = 120
const patchedNodes = new Set()

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

function syncRuntimeState(node) {
  const stateWidget = widgetByName(node, STATE_WIDGET)
  if (!stateWidget || typeof stateWidget.value !== 'string') return
  const next = serializeToggleRuntimeState(
    stateWidget.value,
    currentReferenceEnabled(node),
    currentMainEnabled(node),
    REFERENCE_SLOT_COUNT
  )
  if (typeof next !== 'string' || next === stateWidget.value) return
  stateWidget.value = next
  stateWidget.callback?.(next)
}

function installNode(node, attempts = 0) {
  if (!node || patchedNodes.has(node) || attempts > INSTALL_RETRY_LIMIT) return
  const queueWidget = widgetByName(node, QUEUE_WIDGET)
  if (!queueWidget || typeof queueWidget.beforeQueued !== 'function') {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }

  patchedNodes.add(node)
  const previousBeforeQueued = queueWidget.beforeQueued
  queueWidget.beforeQueued = function (...args) {
    const result = previousBeforeQueued?.apply(this, args)
    // ComfyUI calls widget.beforeQueued synchronously before graphToPrompt().
    // Mirror the visual toggle state into state_json so it participates in the
    // backend input signature and cannot reuse a cached result from the opposite
    // toggle state.
    syncRuntimeState(node)
    return result
  }

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    patchedNodes.delete(node)
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
    for (const node of app.rootGraph?.computeExecutionOrder?.(false) ?? []) {
      const type = String(node?.comfyClass || node?.type || '')
      if (NODE_CLASSES.has(type)) installNode(node)
    }
  }
})
