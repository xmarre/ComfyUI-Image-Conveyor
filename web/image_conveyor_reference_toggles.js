import { app } from '../../scripts/app.js'
import {
  applyReferenceToggleMaskToReservation,
  calculateReferenceToggleRect,
  normalizeReferenceToggleMask,
  referenceToggleHit,
  toggleReferenceToggleMask
} from './image_conveyor_reference_toggles_math.mjs?v=20260817a'

const EXTENSION_NAME = 'Comfy.ImageConveyor.ReferenceSlotToggles'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const QUEUE_WIDGET = 'queue_item_json'
const OUTPUT_MODE_PERSISTENT = 'persistent_refs'
const REFERENCE_SLOT_COUNT = 8
const REFERENCE_OUTPUT_START_INDEX = 6
const PROPERTY_KEY = 'image_conveyor_reference_enabled'
const INSTALL_RETRY_LIMIT = 120
const patchedNodes = new Set()

function getWidget(node, name) {
  return (node.widgets ?? []).find((entry) => entry?.name === name) ?? null
}

function currentMask(node) {
  return normalizeReferenceToggleMask(node?.properties?.[PROPERTY_KEY], REFERENCE_SLOT_COUNT)
}

function setMask(node, mask) {
  if (!node) return
  if (!node.properties || typeof node.properties !== 'object') node.properties = {}
  const normalized = normalizeReferenceToggleMask(mask, REFERENCE_SLOT_COUNT)
  if (normalized.every(Boolean)) delete node.properties[PROPERTY_KEY]
  else node.properties[PROPERTY_KEY] = normalized
  node.graph?.change?.()
  node.setDirtyCanvas?.(true, true)
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

function referenceOutputIndex(node, slotIndex) {
  const expectedName = `ref_image_${slotIndex + 1}`
  const outputs = Array.isArray(node?.outputs) ? node.outputs : []
  const namedIndex = outputs.findIndex((output) => (
    String(output?.name ?? '') === expectedName || String(output?.label ?? '') === expectedName
  ))
  if (namedIndex >= 0) return namedIndex
  const fallback = REFERENCE_OUTPUT_START_INDEX + slotIndex
  return fallback < outputs.length ? fallback : -1
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

function drawReferenceToggles(node, context) {
  const ctx = node?.__bil
  const ext = ctx?.referenceToggles
  if (!ctx || !ext || ctx.removed) return
  ext.hitboxes = []
  if (node.flags?.collapsed || outputMode(node) !== OUTPUT_MODE_PERSISTENT) return
  const shelf = ctx.referenceShelfLayout
  if (!shelf?.usable || typeof node.getConnectionPos !== 'function') return

  const mask = currentMask(node)
  const nodeX = Number(node.pos?.[0] || 0)
  const nodeY = Number(node.pos?.[1] || 0)
  context.save()
  for (let index = 0; index < REFERENCE_SLOT_COUNT; index += 1) {
    const outputIndex = referenceOutputIndex(node, index)
    if (outputIndex < 0) continue
    const output = node.outputs?.[outputIndex]
    if (!output) continue

    const graphPosition = [0, 0]
    const returned = node.getConnectionPos(false, outputIndex, graphPosition) ?? graphPosition
    const socketX = Number(returned?.[0] ?? graphPosition[0]) - nodeX
    const centerY = Number(returned?.[1] ?? graphPosition[1]) - nodeY
    if (!Number.isFinite(socketX) || !Number.isFinite(centerY)) continue

    const label = String(output.label || output.name || `ref_image_${index + 1}`)
    const labelWidth = context.measureText(label).width
    const labelLeft = socketX - 11 - labelWidth
    const rect = calculateReferenceToggleRect(shelf.right, labelLeft, centerY)
    if (!rect) continue

    const hitbox = {
      index,
      x: rect.x - 3,
      y: rect.y - 3,
      width: rect.width + 6,
      height: rect.height + 6
    }
    ext.hitboxes.push(hitbox)
    drawToggle(context, rect, mask[index], ext.hoverIndex === index)
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
  return point ? referenceToggleHit(ext.hitboxes, point.x, point.y) : null
}

function clearTransientQueueSnapshot(node) {
  const queueWidget = getWidget(node, QUEUE_WIDGET)
  if (!queueWidget || !queueWidget.value) return
  queueWidget.value = ''
  queueWidget.callback?.('')
}

function toggleSlot(node, slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= REFERENCE_SLOT_COUNT) return false
  const next = toggleReferenceToggleMask(currentMask(node), slotIndex, REFERENCE_SLOT_COUNT)
  setMask(node, next)
  clearTransientQueueSnapshot(node)
  return true
}

function applyToggleMaskToQueuedSnapshot(node, queueWidget) {
  if (!queueWidget || typeof queueWidget.value !== 'string' || !queueWidget.value.trim()) return
  let payload
  try {
    payload = JSON.parse(queueWidget.value)
  } catch {
    return
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
  if (!Object.hasOwn(payload, 'reference_output_slots')) return

  const masked = applyReferenceToggleMaskToReservation(
    payload,
    currentMask(node),
    REFERENCE_SLOT_COUNT
  )
  if (masked === payload || !Array.isArray(masked?.reference_output_slots)) return
  if (
    Array.isArray(payload.reference_output_slots) &&
    masked.reference_output_slots.length === payload.reference_output_slots.length &&
    masked.reference_output_slots.every((slot, index) => slot === payload.reference_output_slots[index])
  ) return

  const value = JSON.stringify(masked)
  queueWidget.value = value
  queueWidget.callback?.(value)
}

function wrapBeforeQueued(node, queueWidget, ext) {
  const previous = queueWidget.beforeQueued
  ext.previousBeforeQueued = previous
  queueWidget.beforeQueued = function (...args) {
    const result = previous?.apply(this, args)
    applyToggleMaskToQueuedSnapshot(node, queueWidget)
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
    hoverIndex: null,
    previousBeforeQueued: null
  }
  ctx.referenceToggles = ext
  wrapBeforeQueued(node, queueWidget, ext)

  const previousDrawForeground = node.onDrawForeground
  node.onDrawForeground = function (context, ...args) {
    const result = previousDrawForeground?.call(this, context, ...args)
    drawReferenceToggles(node, context)
    return result
  }

  const previousMouseDown = node.onMouseDown
  node.onMouseDown = function (event, localPosition, graphCanvas) {
    const slotIndex = toggleAtEvent(node, event, localPosition)
    if (slotIndex != null && event?.button === 0) {
      toggleSlot(node, slotIndex)
      event.preventDefault?.()
      event.stopPropagation?.()
      event.stopImmediatePropagation?.()
      return true
    }
    return previousMouseDown?.call(this, event, localPosition, graphCanvas)
  }

  const previousMouseMove = node.onMouseMove
  node.onMouseMove = function (event, localPosition, graphCanvas) {
    const nextHover = toggleAtEvent(node, event, localPosition)
    if (ext.hoverIndex !== nextHover) {
      ext.hoverIndex = nextHover
      node.setDirtyCanvas?.(true, false)
    }
    return previousMouseMove?.call(this, event, localPosition, graphCanvas)
  }

  const previousMouseLeave = node.onMouseLeave
  node.onMouseLeave = function (...args) {
    if (ext.hoverIndex != null) {
      ext.hoverIndex = null
      node.setDirtyCanvas?.(true, false)
    }
    return previousMouseLeave?.apply(this, args)
  }

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    patchedNodes.delete(node)
    if (ctx.referenceToggles === ext) ctx.referenceToggles = null
    ext.hitboxes = []
    ext.hoverIndex = null
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
  }
})
