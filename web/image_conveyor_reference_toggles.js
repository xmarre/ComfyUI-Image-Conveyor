import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'
import { snapshotReferenceOutputConnections } from './image_conveyor_math.mjs?v=64d0259bdfdbb853'
import {
  applyMainOutputToggleToReservation,
  applyReferenceToggleMaskToReservation,
  calculateReferenceToggleRect,
  inputRequiredFromNodeDef,
  normalizeMainOutputEnabled,
  normalizeReferenceToggleMask,
  pruneDisabledOutputBranches,
  referenceToggleHit,
  toggleMainOutputEnabled,
  toggleReferenceToggleMask
} from './image_conveyor_reference_toggles_math.mjs?v=20260817d'

const EXTENSION_NAME = 'Comfy.ImageConveyor.ReferenceSlotToggles'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const QUEUE_WIDGET = 'queue_item_json'
const OUTPUT_MODE_PERSISTENT = 'persistent_refs'
const REFERENCE_SLOT_COUNT = 8
const REFERENCE_OUTPUT_START_INDEX = 6
const REFERENCE_PROPERTY_KEY = 'image_conveyor_reference_enabled'
const MAIN_PROPERTY_KEY = 'image_conveyor_main_enabled'
const INSTALL_RETRY_LIMIT = 120
const patchedNodes = new Set()
let graphToPromptPatched = false
let promptNodeDefsPromise = null

function getWidget(node, name) {
  return (node.widgets ?? []).find((entry) => entry?.name === name) ?? null
}

function currentMask(node) {
  return normalizeReferenceToggleMask(node?.properties?.[REFERENCE_PROPERTY_KEY], REFERENCE_SLOT_COUNT)
}

function currentMainEnabled(node) {
  return normalizeMainOutputEnabled(node?.properties?.[MAIN_PROPERTY_KEY])
}

function ensureProperties(node) {
  if (!node.properties || typeof node.properties !== 'object') node.properties = {}
  return node.properties
}

function commitProperties(node) {
  node.graph?.change?.()
  node.setDirtyCanvas?.(true, true)
}

function setMask(node, mask) {
  if (!node) return
  const properties = ensureProperties(node)
  const normalized = normalizeReferenceToggleMask(mask, REFERENCE_SLOT_COUNT)
  if (normalized.every(Boolean)) delete properties[REFERENCE_PROPERTY_KEY]
  else properties[REFERENCE_PROPERTY_KEY] = normalized
  commitProperties(node)
}

function setMainEnabled(node, enabled) {
  if (!node) return
  const properties = ensureProperties(node)
  if (normalizeMainOutputEnabled(enabled)) delete properties[MAIN_PROPERTY_KEY]
  else properties[MAIN_PROPERTY_KEY] = false
  commitProperties(node)
}

function outputMode(node) {
  const cached = node?.__bil?.state?.output_mode
  if (cached) return String(cached)
  const stateWidget = getWidget(node, 'state_json')
  if (typeof stateWidget?.value !== 'string') return ''
  try {
    return String(JSON.parse(stateWidget.value)?.output_mode ?? '')
  } catch {
    return ''
  }
}

function outputIndexByName(node, expectedName, fallback = -1) {
  const outputs = Array.isArray(node?.outputs) ? node.outputs : []
  const namedIndex = outputs.findIndex((output) => (
    String(output?.name ?? '') === expectedName || String(output?.label ?? '') === expectedName
  ))
  if (namedIndex >= 0) return namedIndex
  return fallback >= 0 && fallback < outputs.length ? fallback : -1
}

function referenceOutputIndex(node, slotIndex) {
  return outputIndexByName(
    node,
    `ref_image_${slotIndex + 1}`,
    REFERENCE_OUTPUT_START_INDEX + slotIndex
  )
}

async function getPromptNodeDefs() {
  if (!promptNodeDefsPromise) {
    promptNodeDefsPromise = Promise.resolve(api.getNodeDefs())
      .then((nodeDefs) => {
        if (!nodeDefs || typeof nodeDefs !== 'object' || Array.isArray(nodeDefs)) {
          throw new Error('ComfyUI returned an invalid /object_info node-definition payload')
        }
        return nodeDefs
      })
      .catch((error) => {
        // Permit a later queue attempt to retry a transient /object_info failure.
        promptNodeDefsPromise = null
        throw error
      })
  }
  return await promptNodeDefsPromise
}

function promptInputRequired(prompt, nodeDefs, nodeId, inputName) {
  const classType = String(prompt?.[String(nodeId)]?.class_type ?? '')
  const contract = inputRequiredFromNodeDef(nodeDefs?.[classType], inputName)
  if (contract !== null) return contract

  // Frontend-only routing helpers such as Reroute may not exist in /object_info.
  // Unknown contracts still fail closed as required, but ordinary backend nodes
  // now use the authoritative required/optional schema instead of nodeData.
  return true
}

function disabledMainPromptOutputs(graph) {
  const nodes = typeof graph?.computeExecutionOrder === 'function'
    ? graph.computeExecutionOrder(false)
    : (Array.isArray(graph?._nodes) ? graph._nodes : [])
  const disabled = []
  for (const node of nodes) {
    const type = String(node?.comfyClass || node?.type || '')
    if (!NODE_CLASSES.has(type)) continue
    if (outputMode(node) !== OUTPUT_MODE_PERSISTENT || currentMainEnabled(node)) continue
    const outputIndexes = [
      outputIndexByName(node, 'image', 0),
      outputIndexByName(node, 'mask', 1)
    ].filter((index, offset, all) => index >= 0 && all.indexOf(index) === offset)
    if (outputIndexes.length) disabled.push({ nodeId: String(node.id), outputIndexes })
  }
  return disabled
}

function installGraphToPromptFilter() {
  if (graphToPromptPatched || typeof app.graphToPrompt !== 'function') return
  graphToPromptPatched = true
  const previous = app.graphToPrompt
  app.graphToPrompt = async function (...args) {
    const graph = args[0] ?? this.rootGraph ?? app.graph
    const result = await previous.apply(this, args)
    const disabled = disabledMainPromptOutputs(graph)
    if (disabled.length && result?.output && typeof result.output === 'object') {
      // Current LGraphNode.nodeData intentionally contains only high-level node
      // metadata. Required/optional input categories come from /object_info.
      const nodeDefs = await getPromptNodeDefs()
      pruneDisabledOutputBranches(
        result.output,
        disabled,
        (nodeId, inputName) => promptInputRequired(result.output, nodeDefs, nodeId, inputName)
      )
    }
    return result
  }
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath()
  if (typeof context.roundRect === 'function') context.roundRect(x, y, width, height, radius)
  else context.rect(x, y, width, height)
}

function drawToggle(context, rect, enabled, hovered) {
  const radius = rect.height / 2
  roundedRect(context, rect.x, rect.y, rect.width, rect.height, radius)
  context.fillStyle = enabled
    ? (hovered ? 'rgba(104,174,255,.86)' : 'rgba(91,158,238,.72)')
    : (hovered ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.10)')
  context.fill()
  context.strokeStyle = enabled
    ? (hovered ? 'rgba(177,218,255,.98)' : 'rgba(145,200,255,.88)')
    : (hovered ? 'rgba(255,255,255,.42)' : 'rgba(255,255,255,.26)')
  context.lineWidth = 1
  context.stroke()

  const knobRadius = Math.max(3.5, rect.height / 2 - 2.5)
  const knobX = enabled
    ? rect.x + rect.width - rect.height / 2
    : rect.x + rect.height / 2
  const knobY = rect.y + rect.height / 2
  context.beginPath()
  context.arc(knobX, knobY, knobRadius, 0, Math.PI * 2)
  context.fillStyle = enabled ? 'rgba(248,251,255,.98)' : 'rgba(220,224,230,.82)'
  context.fill()
}

function outputToggleRect(node, context, outputIndex, shelfRight) {
  if (outputIndex < 0 || typeof node.getConnectionPos !== 'function') return null
  const output = node.outputs?.[outputIndex]
  if (!output) return null
  const graphPosition = [0, 0]
  const returned = node.getConnectionPos(false, outputIndex, graphPosition) ?? graphPosition
  const nodeX = Number(node.pos?.[0] || 0)
  const nodeY = Number(node.pos?.[1] || 0)
  const socketX = Number(returned?.[0] ?? graphPosition[0]) - nodeX
  const centerY = Number(returned?.[1] ?? graphPosition[1]) - nodeY
  if (!Number.isFinite(socketX) || !Number.isFinite(centerY)) return null
  const label = String(output.label || output.name || '')
  context.font = node.innerFontStyle
  const labelWidth = context.measureText(label).width
  const labelLeft = socketX - 11 - labelWidth
  return calculateReferenceToggleRect(shelfRight, labelLeft, centerY)
}

function expandedHitbox(index, rect) {
  return {
    index,
    x: rect.x - 3,
    y: rect.y - 3,
    width: rect.width + 6,
    height: rect.height + 6
  }
}

function drawOutputToggles(node, context) {
  const ctx = node?.__bil
  const ext = ctx?.referenceToggles
  if (!ctx || !ext || ctx.removed) return
  ext.hitboxes = []
  ext.mainHitbox = null
  if (node.flags?.collapsed || outputMode(node) !== OUTPUT_MODE_PERSISTENT) return
  const shelf = ctx.referenceShelfLayout
  if (!shelf?.usable || typeof node.getConnectionPos !== 'function') return

  context.save()

  const mainIndex = outputIndexByName(node, 'image', 0)
  const mainRect = outputToggleRect(node, context, mainIndex, shelf.right)
  if (mainRect) {
    ext.mainHitbox = expandedHitbox(0, mainRect)
    drawToggle(context, mainRect, currentMainEnabled(node), ext.hoverTarget === 'main')
  }

  const mask = currentMask(node)
  for (let index = 0; index < REFERENCE_SLOT_COUNT; index += 1) {
    const outputIndex = referenceOutputIndex(node, index)
    const rect = outputToggleRect(node, context, outputIndex, shelf.right)
    if (!rect) continue
    ext.hitboxes.push(expandedHitbox(index, rect))
    drawToggle(context, rect, mask[index], ext.hoverTarget === `reference:${index}`)
  }
  context.restore()
}

function eventLocalPoint(node, event, localPosition = null) {
  if (Array.isArray(localPosition) && localPosition.length >= 2) {
    const x = Number(localPosition[0])
    const y = Number(localPosition[1])
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
  }
  try { app.canvas?.adjustMouseEvent?.(event) } catch {}
  const canvasX = Number(event?.canvasX)
  const canvasY = Number(event?.canvasY)
  if (!Number.isFinite(canvasX) || !Number.isFinite(canvasY)) return null
  return {
    x: canvasX - Number(node.pos?.[0] || 0),
    y: canvasY - Number(node.pos?.[1] || 0)
  }
}

function toggleAtEvent(node, event, localPosition = null) {
  const ext = node?.__bil?.referenceToggles
  if (!ext || outputMode(node) !== OUTPUT_MODE_PERSISTENT) return null
  const point = eventLocalPoint(node, event, localPosition)
  if (!point) return null
  if (referenceToggleHit(ext.mainHitbox ? [ext.mainHitbox] : [], point.x, point.y) != null) {
    return { kind: 'main' }
  }
  const referenceIndex = referenceToggleHit(ext.hitboxes, point.x, point.y)
  return referenceIndex == null ? null : { kind: 'reference', index: referenceIndex }
}

function clearTransientQueueSnapshot(node) {
  const queueWidget = getWidget(node, QUEUE_WIDGET)
  if (!queueWidget || !queueWidget.value) return
  queueWidget.value = ''
  queueWidget.callback?.('')
}

function toggleTarget(node, target) {
  if (target?.kind === 'main') {
    setMainEnabled(node, toggleMainOutputEnabled(currentMainEnabled(node)))
    clearTransientQueueSnapshot(node)
    return true
  }
  if (
    target?.kind !== 'reference' ||
    !Number.isInteger(target.index) ||
    target.index < 0 ||
    target.index >= REFERENCE_SLOT_COUNT
  ) return false
  const next = toggleReferenceToggleMask(currentMask(node), target.index, REFERENCE_SLOT_COUNT)
  setMask(node, next)
  clearTransientQueueSnapshot(node)
  return true
}

function parseQueuedPayload(queueWidget) {
  if (!queueWidget || typeof queueWidget.value !== 'string' || !queueWidget.value.trim()) return null
  try {
    const payload = JSON.parse(queueWidget.value)
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null
  } catch {
    return null
  }
}

function writeQueuedPayload(queueWidget, payload) {
  const value = JSON.stringify(payload)
  queueWidget.value = value
  queueWidget.callback?.(value)
}

function applyOutputTogglesToQueuedSnapshot(node, queueWidget) {
  if (outputMode(node) !== OUTPUT_MODE_PERSISTENT || !queueWidget) return
  const mainEnabled = currentMainEnabled(node)
  let payload = parseQueuedPayload(queueWidget)

  if (!mainEnabled) {
    // Rebuild a reference-only snapshot. This intentionally discards any queue
    // reservation produced by the core beforeQueued hook, so afterQueued has no
    // members to mark as queued and the backend has no image to consume.
    payload = snapshotReferenceOutputConnections({}, OUTPUT_MODE_PERSISTENT, node.outputs)
  } else if (!payload) {
    return
  }

  payload = applyReferenceToggleMaskToReservation(
    payload,
    currentMask(node),
    REFERENCE_SLOT_COUNT
  )
  payload = applyMainOutputToggleToReservation(payload, mainEnabled)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
  writeQueuedPayload(queueWidget, payload)
}

function wrapBeforeQueued(node, queueWidget, ext) {
  const previous = queueWidget.beforeQueued
  ext.previousBeforeQueued = previous
  queueWidget.beforeQueued = function (...args) {
    const result = previous?.apply(this, args)
    applyOutputTogglesToQueuedSnapshot(node, queueWidget)
    return result
  }
}

function installNode(node, attempts = 0) {
  if (!node || attempts > INSTALL_RETRY_LIMIT) return
  const ctx = node.__bil
  if (ctx?.removed) return
  const queueWidget = getWidget(node, QUEUE_WIDGET)
  if (!ctx || !queueWidget || typeof queueWidget.beforeQueued !== 'function') {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }
  if (patchedNodes.has(node)) return
  patchedNodes.add(node)

  const ext = {
    hitboxes: [],
    mainHitbox: null,
    hoverTarget: null,
    previousBeforeQueued: null
  }
  ctx.referenceToggles = ext
  wrapBeforeQueued(node, queueWidget, ext)

  const previousDrawForeground = node.onDrawForeground
  node.onDrawForeground = function (context, ...args) {
    const result = previousDrawForeground?.call(this, context, ...args)
    drawOutputToggles(node, context)
    return result
  }

  const previousMouseDown = node.onMouseDown
  node.onMouseDown = function (event, localPosition, graphCanvas) {
    const target = toggleAtEvent(node, event, localPosition)
    if (target && event?.button === 0) {
      toggleTarget(node, target)
      event.preventDefault?.()
      event.stopPropagation?.()
      event.stopImmediatePropagation?.()
      return true
    }
    return previousMouseDown?.call(this, event, localPosition, graphCanvas)
  }

  const previousMouseMove = node.onMouseMove
  node.onMouseMove = function (event, localPosition, graphCanvas) {
    const target = toggleAtEvent(node, event, localPosition)
    const nextHover = target?.kind === 'main'
      ? 'main'
      : target?.kind === 'reference'
        ? `reference:${target.index}`
        : null
    if (ext.hoverTarget !== nextHover) {
      ext.hoverTarget = nextHover
      node.setDirtyCanvas?.(true, false)
    }
    return previousMouseMove?.call(this, event, localPosition, graphCanvas)
  }

  const previousMouseLeave = node.onMouseLeave
  node.onMouseLeave = function (...args) {
    if (ext.hoverTarget != null) {
      ext.hoverTarget = null
      node.setDirtyCanvas?.(true, false)
    }
    return previousMouseLeave?.apply(this, args)
  }

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    patchedNodes.delete(node)
    if (ctx.referenceToggles === ext) ctx.referenceToggles = null
    ext.hitboxes = []
    ext.mainHitbox = null
    ext.hoverTarget = null
    return previousRemoved?.apply(this, args)
  }

  node.setDirtyCanvas?.(true, false)
}

app.registerExtension({
  name: EXTENSION_NAME,
  setup() {
    // Pre-warm the authoritative input contract cache. Queue-time lookup still
    // awaits/retries it if this request is transiently unavailable.
    void getPromptNodeDefs().catch((error) => {
      console.warn('Image Conveyor: unable to pre-load ComfyUI node definitions.', error)
    })
    installGraphToPromptFilter()
  },
  nodeCreated(node) {
    const type = String(node?.comfyClass || node?.type || '')
    if (!NODE_CLASSES.has(type)) return
    queueMicrotask(() => installNode(node))
  }
})
