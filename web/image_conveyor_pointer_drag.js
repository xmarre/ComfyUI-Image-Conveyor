import { app } from '../../scripts/app.js'
import { referenceShelfHit } from './image_conveyor_math.mjs?v=20260813-pointer-drag'

const EXTENSION_NAME = 'Comfy.ImageConveyor.PointerCardDrag'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const DRAG_THRESHOLD = 5
const DRIVE_INTERVAL_MS = 32
const CLICK_SUPPRESS_MS = 240
const patchedNodes = new Set()

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now()
}

function cardSlotAtTarget(ctx, target) {
  if (!(target instanceof Node)) return null
  return ctx.cardPool?.find((slot) => slot?.itemId && slot.card?.contains(target)) ?? null
}

function isInteractiveTarget(target) {
  return target instanceof Element && Boolean(
    target.closest('button, input, textarea, select, a[href], [contenteditable="true"]')
  )
}

function markPointerSynthetic(event) {
  try {
    Object.defineProperty(event, '__icxPointerSyntheticDrag', { value: true })
  } catch {
    try { event.__icxPointerSyntheticDrag = true } catch {}
  }
  return event
}

function syntheticDragEvent(type, clientX, clientY) {
  const options = {
    bubbles: true,
    cancelable: true,
    clientX: Number(clientX) || 0,
    clientY: Number(clientY) || 0
  }
  try {
    return markPointerSynthetic(new DragEvent(type, options))
  } catch {
    const event = new Event(type, { bubbles: true, cancelable: true })
    for (const [key, value] of Object.entries({ clientX: options.clientX, clientY: options.clientY })) {
      try { Object.defineProperty(event, key, { value }) } catch {}
    }
    return markPointerSynthetic(event)
  }
}

function referenceHitAt(node, clientX, clientY) {
  const ctx = node.__bil
  const layout = ctx?.referenceShelfLayout
  if (!layout?.usable) return null
  const event = syntheticDragEvent('dragover', clientX, clientY)
  try { app.canvas?.adjustMouseEvent?.(event) } catch {}
  const canvasX = Number(event.canvasX)
  const canvasY = Number(event.canvasY)
  if (!Number.isFinite(canvasX) || !Number.isFinite(canvasY)) return null
  return referenceShelfHit(
    layout,
    canvasX - Number(node.pos?.[0] || 0),
    canvasY - Number(node.pos?.[1] || 0)
  )
}

function makeGhost(ctx, candidate) {
  const ghost = document.createElement('div')
  ghost.className = 'icx-pointer-drag-ghost'
  const selection = ctx.browser?.[candidate.sourceView]?.selected
    ?? ctx.browser?.folderViews?.get(candidate.sourceView)?.selected
  const selectedCount = selection instanceof Set && selection.has(candidate.itemId)
    ? selection.size
    : 1
  const label = String(candidate.label || 'Image')
  ghost.textContent = selectedCount > 1 ? `${selectedCount} images` : label
  document.body.appendChild(ghost)
  return ghost
}

function positionGhost(session) {
  if (!session?.ghost) return
  session.ghost.style.transform = `translate3d(${session.clientX + 14}px, ${session.clientY + 16}px, 0)`
  const drag = session.ctx.icx?.batchDrag ?? session.ctx.icx?.cardDrag
  const count = drag?.items?.length ?? 0
  if (count > 1 && session.ghost.textContent !== `${count} images`) {
    session.ghost.textContent = `${count} images`
  }
}

function clearReferenceHover(node) {
  const ctx = node.__bil
  if (!ctx || ctx.referenceDragHoverIndex == null) return
  ctx.referenceDragHoverIndex = null
  node.setDirtyCanvas?.(true, false)
}

function driveDragOver(node, session) {
  const ctx = node.__bil
  if (!session?.active || !ctx || ctx.removed || node.__bil !== session.ctx) return
  positionGhost(session)

  const hit = referenceHitAt(node, session.clientX, session.clientY)
  if (hit?.type === 'slot') {
    const event = syntheticDragEvent('dragover', session.clientX, session.clientY)
    node.onDragOver?.call(node, event)
    return
  }
  clearReferenceHover(node)

  const target = document.elementFromPoint(session.clientX, session.clientY)
  if (!(target instanceof Element)) return
  target.dispatchEvent(syntheticDragEvent('dragover', session.clientX, session.clientY))
}

function stopDriveLoop(session) {
  if (!session?.frame) return
  cancelAnimationFrame(session.frame)
  session.frame = 0
}

function startDriveLoop(node, session) {
  const tick = (timestamp) => {
    session.frame = 0
    if (!session.active || node.__bil !== session.ctx || session.ctx.removed) return
    if (!session.lastDriveAt || timestamp - session.lastDriveAt >= DRIVE_INTERVAL_MS) {
      session.lastDriveAt = timestamp
      driveDragOver(node, session)
    } else {
      positionGhost(session)
    }
    session.frame = requestAnimationFrame(tick)
  }
  session.frame = requestAnimationFrame(tick)
}

function restoreSourceDraggable(session) {
  const slot = session?.sourceSlot
  if (!slot?.card) return
  slot.card.draggable = Boolean(slot.draggable)
}

function dispatchDragEnd(session) {
  const sourceCard = session?.sourceCard
  if (!(sourceCard instanceof Element)) return
  sourceCard.dispatchEvent(syntheticDragEvent('dragend', session.clientX, session.clientY))
}

function cleanupSession(node, session, { suppressClick = false } = {}) {
  const ctx = node.__bil
  const ext = session?.ctx?.icx
  stopDriveLoop(session)
  restoreSourceDraggable(session)
  session?.ghost?.remove?.()
  document.body.classList.remove('icx-pointer-card-grabbing')
  clearReferenceHover(node)

  if (ext) {
    if (suppressClick) {
      ext.pointerSuppressClick = {
        until: nowMs() + CLICK_SUPPRESS_MS,
        clientX: session.clientX,
        clientY: session.clientY
      }
    }
    if (ext.pointerCardDrag === session) ext.pointerCardDrag = null
    if (ext.pointerCandidate === session) ext.pointerCandidate = null
  }
  if (ctx && ctx.dragIntent && !ctx.draggedId) ctx.dragIntent = null
}

function startPointerDrag(node, session) {
  const ctx = node.__bil
  const ext = ctx?.icx
  if (!ctx || !ext || session.active || ctx.removed) return false
  session.active = true
  ext.pointerCardDrag = session
  document.body.classList.add('icx-pointer-card-grabbing')
  session.ghost = makeGhost(ctx, session)
  positionGhost(session)

  session.sourceCard.dispatchEvent(syntheticDragEvent('dragstart', session.clientX, session.clientY))
  queueMicrotask(() => {
    if (!session.active || node.__bil !== ctx || ctx.removed) return
    driveDragOver(node, session)
  })
  startDriveLoop(node, session)
  return true
}

function finishPointerDrag(node, session, pointerEvent) {
  if (!session?.active) {
    cleanupSession(node, session)
    return
  }
  session.clientX = Number(pointerEvent?.clientX ?? session.clientX) || 0
  session.clientY = Number(pointerEvent?.clientY ?? session.clientY) || 0
  driveDragOver(node, session)

  const hit = referenceHitAt(node, session.clientX, session.clientY)
  if (hit?.type === 'slot') {
    const dropEvent = syntheticDragEvent('drop', session.clientX, session.clientY)
    try {
      const result = node.onDragDrop?.call(node, dropEvent)
      Promise.resolve(result).catch((error) => {
        console.error('Image Conveyor: pointer reference drop failed.', error)
        window.alert(error?.message || 'Unable to apply the selected reference images.')
      })
    } catch (error) {
      console.error('Image Conveyor: pointer reference drop failed.', error)
      window.alert(error?.message || 'Unable to apply the selected reference images.')
    }
  } else {
    const target = document.elementFromPoint(session.clientX, session.clientY)
    if (target instanceof Element) {
      target.dispatchEvent(syntheticDragEvent('drop', session.clientX, session.clientY))
    }
  }

  dispatchDragEnd(session)
  cleanupSession(node, session, { suppressClick: true })
}

function cancelPointerDrag(node, session) {
  if (!session) return
  if (session.active) dispatchDragEnd(session)
  cleanupSession(node, session)
}

function installStyles() {
  if (document.getElementById('image-conveyor-pointer-drag-style')) return
  const style = document.createElement('style')
  style.id = 'image-conveyor-pointer-drag-style'
  style.textContent = `
    body.icx-pointer-card-grabbing, body.icx-pointer-card-grabbing * { cursor: grabbing !important; }
    .icx-pointer-drag-ghost {
      position: fixed; left: 0; top: 0; z-index: 100004; pointer-events: none;
      max-width: min(320px, 45vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 6px 9px; border: 1px solid rgba(130,190,255,.72); border-radius: 7px;
      background: rgba(28,32,38,.94); color: #eef6ff; box-shadow: 0 8px 24px rgba(0,0,0,.38);
      font: 12px/1.25 system-ui, sans-serif;
    }
  `
  document.head.appendChild(style)
}

function installNode(node) {
  const ctx = node.__bil
  if (!ctx?.icx?.batchDragV2 || ctx.icx.pointerCardDragV1 || ctx.removed) return false
  installStyles()
  const ext = ctx.icx
  ext.pointerCardDragV1 = true
  ext.pointerCandidate = null
  ext.pointerCardDrag = null
  ext.pointerSuppressClick = null
  patchedNodes.add(node)

  ext.pointerRootDown = (event) => {
    if (event.button !== 0 || (event.pointerType && event.pointerType !== 'mouse')) return
    if (event.defaultPrevented || isInteractiveTarget(event.target)) return
    const slot = cardSlotAtTarget(ctx, event.target)
    if (!slot || slot.item?.kind === 'folder' || !slot.draggable || !slot.itemId) return

    if (ext.pointerCandidate) cancelPointerDrag(node, ext.pointerCandidate)
    slot.card.draggable = false
    ext.pointerCandidate = {
      node,
      ctx,
      pointerId: event.pointerId,
      sourceView: ctx.browser.activeView,
      sourceSlot: slot,
      sourceCard: slot.card,
      itemId: String(slot.itemId),
      label: slot.item?.filename || slot.item?.relative_path || slot.itemId,
      startX: Number(event.clientX) || 0,
      startY: Number(event.clientY) || 0,
      clientX: Number(event.clientX) || 0,
      clientY: Number(event.clientY) || 0,
      active: false,
      ghost: null,
      frame: 0,
      lastDriveAt: 0
    }
  }

  ext.pointerWindowMove = (event) => {
    const session = ext.pointerCandidate
    if (!session || event.pointerId !== session.pointerId) return
    session.clientX = Number(event.clientX) || 0
    session.clientY = Number(event.clientY) || 0
    if (!session.active) {
      const distance = Math.hypot(session.clientX - session.startX, session.clientY - session.startY)
      if (distance < DRAG_THRESHOLD) return
      startPointerDrag(node, session)
    }
    if (!session.active) return
    event.preventDefault()
    event.stopPropagation()
    driveDragOver(node, session)
  }

  ext.pointerWindowUp = (event) => {
    const session = ext.pointerCandidate
    if (!session || event.pointerId !== session.pointerId) return
    if (session.active) {
      event.preventDefault()
      event.stopPropagation()
      finishPointerDrag(node, session, event)
    } else {
      cleanupSession(node, session)
    }
  }

  ext.pointerWindowCancel = (event) => {
    const session = ext.pointerCandidate
    if (!session || event.pointerId !== session.pointerId) return
    cancelPointerDrag(node, session)
  }

  ext.pointerWindowWheel = () => {
    const session = ext.pointerCardDrag
    if (!session?.active) return
    queueMicrotask(() => {
      if (session.active && node.__bil === ctx && !ctx.removed) driveDragOver(node, session)
    })
  }

  ext.pointerWindowClick = (event) => {
    const suppression = ext.pointerSuppressClick
    if (!suppression) return
    if (nowMs() > suppression.until) {
      ext.pointerSuppressClick = null
      return
    }
    const distance = Math.hypot(
      Number(event.clientX || 0) - suppression.clientX,
      Number(event.clientY || 0) - suppression.clientY
    )
    if (distance > 18) return
    ext.pointerSuppressClick = null
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation?.()
  }

  ext.pointerWindowBlur = () => {
    if (ext.pointerCandidate) cancelPointerDrag(node, ext.pointerCandidate)
  }

  ext.pointerBlockNativeDragStart = (event) => {
    if (event.__icxPointerSyntheticDrag) return
    if (!ext.pointerCandidate && !ext.pointerCardDrag) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation?.()
  }

  ctx.root.addEventListener('pointerdown', ext.pointerRootDown, true)
  window.addEventListener('pointermove', ext.pointerWindowMove, true)
  window.addEventListener('pointerup', ext.pointerWindowUp, true)
  window.addEventListener('pointercancel', ext.pointerWindowCancel, true)
  window.addEventListener('wheel', ext.pointerWindowWheel, true)
  window.addEventListener('click', ext.pointerWindowClick, true)
  window.addEventListener('blur', ext.pointerWindowBlur)
  window.addEventListener('dragstart', ext.pointerBlockNativeDragStart, true)

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    if (ext.pointerCandidate) cancelPointerDrag(node, ext.pointerCandidate)
    patchedNodes.delete(node)
    ctx.root?.removeEventListener('pointerdown', ext.pointerRootDown, true)
    window.removeEventListener('pointermove', ext.pointerWindowMove, true)
    window.removeEventListener('pointerup', ext.pointerWindowUp, true)
    window.removeEventListener('pointercancel', ext.pointerWindowCancel, true)
    window.removeEventListener('wheel', ext.pointerWindowWheel, true)
    window.removeEventListener('click', ext.pointerWindowClick, true)
    window.removeEventListener('blur', ext.pointerWindowBlur)
    window.removeEventListener('dragstart', ext.pointerBlockNativeDragStart, true)
    return previousRemoved?.apply(this, args)
  }
  return true
}

function scheduleInstall(node, attempts = 0) {
  if (!node || node.__bil?.removed || attempts > 120) return
  if (installNode(node)) return
  requestAnimationFrame(() => scheduleInstall(node, attempts + 1))
}

app.registerExtension({
  name: EXTENSION_NAME,
  nodeCreated(node) {
    const type = String(node?.comfyClass || node?.type || '')
    if (!NODE_CLASSES.has(type)) return
    queueMicrotask(() => scheduleInstall(node))
  }
})
