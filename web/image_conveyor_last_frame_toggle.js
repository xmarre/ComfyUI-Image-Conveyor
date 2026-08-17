import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'
import {
  calculateReferenceToggleRect,
  inputRequiredFromNodeDef,
  normalizeMainOutputEnabled,
  pruneDisabledOutputBranches,
  referenceToggleHit,
  toggleMainOutputEnabled
} from './image_conveyor_reference_toggles_math.mjs?v=20260817e'

const EXTENSION_NAME = 'Comfy.ImageConveyor.LastFrameToggle'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const QUEUE_WIDGET = 'queue_item_json'
const OUTPUT_MODE_PERSISTENT = 'persistent_refs'
const LAST_FRAME_PROPERTY_KEY = 'image_conveyor_last_frame_enabled'
const LAST_FRAME_OUTPUT_FALLBACK_INDEX = 14
const INSTALL_RETRY_LIMIT = 120
const patchedNodes = new WeakSet()
let graphToPromptPatched = false
let promptNodeDefsPromise = null

function getWidget(node, name) {
  return (node?.widgets ?? []).find((entry) => entry?.name === name) ?? null
}

function currentLastFrameEnabled(node) {
  return normalizeMainOutputEnabled(node?.properties?.[LAST_FRAME_PROPERTY_KEY])
}

function setLastFrameEnabled(node, enabled) {
  if (!node) return
  if (!node.properties || typeof node.properties !== 'object') node.properties = {}
  if (normalizeMainOutputEnabled(enabled)) delete node.properties[LAST_FRAME_PROPERTY_KEY]
  else node.properties[LAST_FRAME_PROPERTY_KEY] = false
  const queueWidget = getWidget(node, QUEUE_WIDGET)
  if (queueWidget?.value) {
    queueWidget.value = ''
    queueWidget.callback?.('')
  }
  node.graph?.change?.()
  node.setDirtyCanvas?.(true, true)
}

function outputMode(node) {
  const cached = node?.__bil?.state?.output_mode
  if (cached) return String(cached)
  return ''
}

function outputIndexByName(node, name, fallback = -1) {
  const outputs = Array.isArray(node?.outputs) ? node.outputs : []
  const named = outputs.findIndex((output) => (
    String(output?.name ?? '') === name || String(output?.label ?? '') === name
  ))
  if (named >= 0) return named
  return fallback >= 0 && fallback < outputs.length ? fallback : -1
}

function lastFrameOutputIndex(node) {
  return outputIndexByName(node, 'last_frame', LAST_FRAME_OUTPUT_FALLBACK_INDEX)
}

function ensureLastFrameOutput(node) {
  const existing = lastFrameOutputIndex(node)
  if (existing >= 0) return existing

  // Older saved workflows serialize the node's original 14-output array. The
  // current backend schema appends last_frame at 14, but loading that saved
  // array can temporarily hide the new socket. Append it in place instead of
  // requiring node recreation. Existing 0..13 output indices never move.
  if (Array.isArray(node?.outputs) && node.outputs.length === LAST_FRAME_OUTPUT_FALLBACK_INDEX) {
    node.addOutput?.('last_frame', 'IMAGE')
  }
  return lastFrameOutputIndex(node)
}

function conveyorNodes(graph) {
  const nodes = typeof graph?.computeExecutionOrder === 'function'
    ? graph.computeExecutionOrder(false)
    : (Array.isArray(graph?._nodes) ? graph._nodes : [])
  return nodes.filter((node) => NODE_CLASSES.has(String(node?.comfyClass || node?.type || '')))
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
        promptNodeDefsPromise = null
        throw error
      })
  }
  return await promptNodeDefsPromise
}

function promptInputRequired(prompt, nodeDefs, nodeId, inputName) {
  const classType = String(prompt?.[String(nodeId)]?.class_type ?? '')
  const contract = inputRequiredFromNodeDef(nodeDefs?.[classType], inputName)
  return contract !== null ? contract : true
}

function disabledLastFrameOutputs(graph) {
  const disabled = []
  for (const node of conveyorNodes(graph)) {
    if (outputMode(node) !== OUTPUT_MODE_PERSISTENT || currentLastFrameEnabled(node)) continue
    const outputIndex = lastFrameOutputIndex(node)
    if (outputIndex >= 0) disabled.push({ nodeId: String(node.id), outputIndexes: [outputIndex] })
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
    const disabled = disabledLastFrameOutputs(graph)
    if (disabled.length && result?.output && typeof result.output === 'object') {
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

function toggleRect(node, context) {
  const outputIndex = lastFrameOutputIndex(node)
  if (outputIndex < 0 || typeof node.getConnectionPos !== 'function') return null
  const output = node.outputs?.[outputIndex]
  if (!output) return null

  const graphPosition = [0, 0]
  const returned = node.getConnectionPos(false, outputIndex, graphPosition) ?? graphPosition
  const socketX = Number(returned?.[0] ?? graphPosition[0]) - Number(node.pos?.[0] || 0)
  const centerY = Number(returned?.[1] ?? graphPosition[1]) - Number(node.pos?.[1] || 0)
  if (!Number.isFinite(socketX) || !Number.isFinite(centerY)) return null

  context.font = node.innerFontStyle
  const label = String(output.label || output.name || 'last_frame')
  const labelLeft = socketX - 11 - context.measureText(label).width
  const shelfRight = Number(node?.__bil?.referenceShelfLayout?.right)
  const leftBoundary = Number.isFinite(shelfRight)
    ? shelfRight
    : Math.max(8, Math.min(labelLeft - 40, Number(node.size?.[0] || 0) * 0.55))
  return calculateReferenceToggleRect(leftBoundary, labelLeft, centerY)
}

function expandedHitbox(rect) {
  return rect ? {
    index: 0,
    x: rect.x - 3,
    y: rect.y - 3,
    width: rect.width + 6,
    height: rect.height + 6
  } : null
}

function eventLocalPoint(node, event, localPosition = null) {
  if (Array.isArray(localPosition) && localPosition.length >= 2) {
    const x = Number(localPosition[0])
    const y = Number(localPosition[1])
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y }
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

function installNode(node, attempts = 0) {
  if (!node || attempts > INSTALL_RETRY_LIMIT || patchedNodes.has(node)) return
  const type = String(node?.comfyClass || node?.type || '')
  if (!NODE_CLASSES.has(type)) return
  const lastFrameIndex = ensureLastFrameOutput(node)
  if (!node.__bil || lastFrameIndex < 0) {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }
  patchedNodes.add(node)

  const ext = { hitbox: null, hovered: false }
  node.__bil.lastFrameToggle = ext

  const previousDrawForeground = node.onDrawForeground
  node.onDrawForeground = function (context, ...args) {
    const result = previousDrawForeground?.call(this, context, ...args)
    ext.hitbox = null
    if (!node.flags?.collapsed && outputMode(node) === OUTPUT_MODE_PERSISTENT) {
      const rect = toggleRect(node, context)
      if (rect) {
        ext.hitbox = expandedHitbox(rect)
        context.save()
        drawToggle(context, rect, currentLastFrameEnabled(node), ext.hovered)
        context.restore()
      }
    }
    return result
  }

  const previousMouseDown = node.onMouseDown
  node.onMouseDown = function (event, localPosition, graphCanvas) {
    const point = eventLocalPoint(node, event, localPosition)
    const hit = point && ext.hitbox
      ? referenceToggleHit([ext.hitbox], point.x, point.y)
      : null
    if (hit != null && event?.button === 0) {
      setLastFrameEnabled(node, toggleMainOutputEnabled(currentLastFrameEnabled(node)))
      event.preventDefault?.()
      event.stopPropagation?.()
      event.stopImmediatePropagation?.()
      return true
    }
    return previousMouseDown?.call(this, event, localPosition, graphCanvas)
  }

  const previousMouseMove = node.onMouseMove
  node.onMouseMove = function (event, localPosition, graphCanvas) {
    const point = eventLocalPoint(node, event, localPosition)
    const hovered = Boolean(point && ext.hitbox && referenceToggleHit([ext.hitbox], point.x, point.y) != null)
    if (ext.hovered !== hovered) {
      ext.hovered = hovered
      node.setDirtyCanvas?.(true, false)
    }
    return previousMouseMove?.call(this, event, localPosition, graphCanvas)
  }

  const previousMouseLeave = node.onMouseLeave
  node.onMouseLeave = function (...args) {
    if (ext.hovered) {
      ext.hovered = false
      node.setDirtyCanvas?.(true, false)
    }
    return previousMouseLeave?.apply(this, args)
  }

  node.setDirtyCanvas?.(true, false)
}

app.registerExtension({
  name: EXTENSION_NAME,
  setup() {
    void getPromptNodeDefs().catch((error) => {
      console.warn('Image Conveyor: unable to pre-load ComfyUI node definitions for last_frame.', error)
    })
    installGraphToPromptFilter()
  },
  nodeCreated(node) {
    if (!NODE_CLASSES.has(String(node?.comfyClass || node?.type || ''))) return
    queueMicrotask(() => installNode(node))
  },
  afterConfigureGraph() {
    for (const node of conveyorNodes(app.rootGraph)) installNode(node)
  }
})
