import { app } from '../../scripts/app.js'

const EXTENSION_NAME = 'Comfy.ImageConveyor.InteractionGuards'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const INTERNAL_REFERENCE_MIME = 'application/x-image-conveyor-reference'
const patchedNodes = new WeakSet()

function internalDragKind(event) {
  try {
    const raw = event?.dataTransfer?.getData?.(INTERNAL_REFERENCE_MIME)
    if (!raw) return ''
    const payload = JSON.parse(raw)
    return String(payload?.kind || '')
  } catch {
    return ''
  }
}

function installDragEffectContract() {
  if (window.__imageConveyorDragEffectContractInstalled) return
  window.__imageConveyorDragEffectContractInstalled = true
  window.addEventListener('dragstart', (event) => {
    const transfer = event.dataTransfer
    if (!transfer) return
    const kind = internalDragKind(event)
    if (kind !== 'input' && kind !== 'conveyor') return
    // Managed Input/Conveyor files can be copied to the Conveyor/reference shelf or moved
    // between real Input folders. Advertise both operations so a folder dropEffect='move'
    // remains legal instead of producing Chrome's prohibited-drop cursor.
    try { transfer.effectAllowed = 'copyMove' } catch {}
  })
}

function clearReferencePointerState(node, ctx) {
  if (!ctx || ctx.removed) return false
  if (!ctx.referenceShelfPointerDrag && ctx.referenceDragSourceIndex == null && ctx.referenceDragHoverIndex == null) return false
  ctx.referenceShelfPointerDrag = null
  ctx.referenceDragSourceIndex = null
  ctx.referenceDragHoverIndex = null
  node.setDirtyCanvas?.(true, false)
  return true
}

function installNode(node, attempts = 0) {
  if (!node || node.__bil?.removed || attempts > 90) return
  const ctx = node.__bil
  if (!ctx) {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }
  if (patchedNodes.has(node)) return
  patchedNodes.add(node)

  const documentMouseUp = () => {
    // LiteGraph's canvas mouseup gets first chance to finish a legitimate shelf reorder.
    // If the release happened outside the canvas/node, its handler never runs; clear the
    // still-live pointer state after normal mouseup propagation so the source slot cannot
    // remain highlighted indefinitely.
    queueMicrotask(() => {
      if (node.__bil === ctx && ctx.referenceShelfPointerDrag) clearReferencePointerState(node, ctx)
    })
  }
  const documentPointerCancel = () => clearReferencePointerState(node, ctx)
  const windowBlur = () => clearReferencePointerState(node, ctx)

  document.addEventListener('mouseup', documentMouseUp)
  document.addEventListener('pointercancel', documentPointerCancel, true)
  window.addEventListener('blur', windowBlur)

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    document.removeEventListener('mouseup', documentMouseUp)
    document.removeEventListener('pointercancel', documentPointerCancel, true)
    window.removeEventListener('blur', windowBlur)
    clearReferencePointerState(node, ctx)
    return previousRemoved?.apply(this, args)
  }
}

installDragEffectContract()

app.registerExtension({
  name: EXTENSION_NAME,
  nodeCreated(node) {
    const type = String(node?.comfyClass || node?.type || '')
    if (!NODE_CLASSES.has(type)) return
    queueMicrotask(() => installNode(node))
  }
})
