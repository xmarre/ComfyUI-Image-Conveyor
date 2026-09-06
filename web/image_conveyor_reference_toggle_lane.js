import { app } from '../../scripts/app.js'
import {
  referenceOutputGutterFromLabelWidths,
  reserveReferenceToggleGutter
} from './image_conveyor_reference_toggle_lane_math.mjs'

const EXTENSION_NAME = 'Comfy.ImageConveyor.ReferenceToggleLane'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const INSTALL_RETRY_LIMIT = 120
const patchedNodes = new Set()

function conveyorNodes(graph) {
  const nodes = typeof graph?.computeExecutionOrder === 'function'
    ? graph.computeExecutionOrder(false)
    : (Array.isArray(graph?._nodes) ? graph._nodes : [])
  return nodes.filter((node) => NODE_CLASSES.has(String(node?.comfyClass || node?.type || '')))
}

function measureReservedToggleGutter(node, context) {
  const labels = (node?.outputs ?? []).map((output) => (
    String(output?.label || output?.name || '')
  ))
  const previousFont = context.font
  const fontStyle = String(node?.innerFontStyle ?? '')

  try {
    if (fontStyle) context.font = fontStyle
    const widths = labels.map((label) => context.measureText(label).width)
    return reserveReferenceToggleGutter(referenceOutputGutterFromLabelWidths(widths))
  } finally {
    context.font = previousFont
  }
}

function reserveToggleLane(node, context, ext) {
  const ctx = node?.__bil
  if (!ctx || ctx.removed) return false

  // Wait until image_conveyor.js has established the output-label set for this
  // shelf. Do not reuse its numeric gutter measurement: LiteGraph calls
  // onDrawForeground before assigning the connection-slot font, while the
  // toggle renderers explicitly measure with node.innerFontStyle. Measuring the
  // lane with that same explicit font keeps both sides of the geometry in the
  // same coordinate contract across browsers.
  const shelfGutterKey = String(ctx.referenceOutputGutterKey ?? '')
  if (!shelfGutterKey) return false

  const fontStyle = String(node?.innerFontStyle ?? '')
  const gutterKey = JSON.stringify([shelfGutterKey, fontStyle])
  const currentGutter = Number(ctx.referenceOutputGutter)
  if (
    ext.gutterKey === gutterKey &&
    Number.isFinite(ext.reservedGutter) &&
    currentGutter === ext.reservedGutter
  ) {
    return false
  }

  const reservedGutter = measureReservedToggleGutter(node, context)
  ctx.referenceOutputGutter = reservedGutter
  ctx.referenceShelfLayout = null
  ext.gutterKey = gutterKey
  ext.reservedGutter = reservedGutter
  node.setDirtyCanvas?.(true, false)
  return true
}

function installNode(node, attempts = 0) {
  if (!node || attempts > INSTALL_RETRY_LIMIT) return

  const ctx = node.__bil
  if (ctx?.removed) return
  if (!ctx) {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }
  if (patchedNodes.has(node)) return
  patchedNodes.add(node)

  const ext = {
    gutterKey: null,
    reservedGutter: null
  }

  const previousDrawForeground = node.onDrawForeground
  node.onDrawForeground = function (context, ...args) {
    const result = previousDrawForeground?.call(this, context, ...args)
    reserveToggleLane(node, context, ext)
    return result
  }

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    patchedNodes.delete(node)
    return previousRemoved?.apply(this, args)
  }

  node.setDirtyCanvas?.(true, false)
}

app.registerExtension({
  name: EXTENSION_NAME,

  nodeCreated(node) {
    const type = String(node?.comfyClass || node?.type || '')
    if (!NODE_CLASSES.has(type)) return
    queueMicrotask(() => installNode(node))
  },

  afterConfigureGraph() {
    for (const node of conveyorNodes(app.rootGraph)) installNode(node)
  }
})
