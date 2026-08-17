import { app } from '../../scripts/app.js'
import {
  normalizeMainEnabled,
  normalizeReferenceEnabled,
  serializeToggleRuntimeState
} from './image_conveyor_toggle_state_math.mjs?v=20260817b'

const EXTENSION_NAME = 'Comfy.ImageConveyor.ToggleStateWidgetGuard'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const STATE_WIDGET = 'state_json'
const REFERENCE_PROPERTY_KEY = 'image_conveyor_reference_enabled'
const MAIN_PROPERTY_KEY = 'image_conveyor_main_enabled'
const REFERENCE_SLOT_COUNT = 8
const INSTALL_RETRY_LIMIT = 120
const guardedWidgets = new WeakSet()

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

function runtimeStateValue(node, raw) {
  return serializeToggleRuntimeState(
    raw,
    currentReferenceEnabled(node),
    currentMainEnabled(node),
    REFERENCE_SLOT_COUNT
  )
}

function preserveCurrentValue(node, stateWidget) {
  const next = runtimeStateValue(node, stateWidget.value)
  if (typeof next === 'string' && next !== stateWidget.value) {
    stateWidget.value = next
  }
  return stateWidget.value
}

function installNode(node, attempts = 0) {
  if (!node || attempts > INSTALL_RETRY_LIMIT) return
  const type = String(node?.comfyClass || node?.type || '')
  if (!NODE_CLASSES.has(type)) return

  const stateWidget = widgetByName(node, STATE_WIDGET)
  if (!stateWidget) {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }
  if (guardedWidgets.has(stateWidget)) return
  guardedWidgets.add(stateWidget)

  // Image Conveyor's core serializeState() intentionally emits a normalized
  // schema. The output-toggle fields live outside that historical schema, so a
  // normal core state write can otherwise erase them after the switch UI has
  // set them. Guard every callback-driven write at the widget boundary.
  const previousCallback = stateWidget.callback
  stateWidget.callback = function (value, ...args) {
    const result = previousCallback?.call(this, value, ...args)
    preserveCurrentValue(node, stateWidget)
    return result
  }

  // ComfyUI may serialize a widget through serializeValue() instead of reading
  // .value directly. Re-embed the runtime mask there as the final authority so
  // the backend-visible state cannot lose the current switch values even if a
  // later frontend update rewrote the normalized core state.
  const previousSerializeValue = stateWidget.serializeValue
  stateWidget.serializeValue = function (...args) {
    const raw = typeof previousSerializeValue === 'function'
      ? previousSerializeValue.apply(this, args)
      : this.value

    if (raw && typeof raw.then === 'function') {
      return raw.then((value) => runtimeStateValue(node, value))
    }
    return runtimeStateValue(node, raw)
  }

  preserveCurrentValue(node, stateWidget)
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
      installNode(node)
    }
  }
})
