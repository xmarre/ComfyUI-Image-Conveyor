import { app } from '../../scripts/app.js'
import { middleAutoscrollSpeed } from './image_conveyor_middle_autoscroll_math.mjs?v=20260813a'

const EXTENSION_NAME = 'Comfy.ImageConveyor.MiddleAutoscroll'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const patchedNodes = new Set()
let activeSession = null

function eventOrigin(event) {
  return event.composedPath?.()[0] ?? event.target
}

function insideGallery(ctx, event) {
  const target = eventOrigin(event)
  return target instanceof Node && Boolean(ctx?.list?.contains(target))
}

function installStyles() {
  if (document.getElementById('image-conveyor-middle-autoscroll-style')) return
  const style = document.createElement('style')
  style.id = 'image-conveyor-middle-autoscroll-style'
  style.textContent = `
    .icx-middle-autoscroll-anchor {
      position: fixed;
      z-index: 100006;
      width: 30px;
      height: 30px;
      margin: -15px 0 0 -15px;
      display: grid;
      place-items: center;
      pointer-events: none;
      border: 1px solid rgba(145, 200, 255, .88);
      border-radius: 50%;
      background: rgba(24, 29, 35, .94);
      color: rgba(235, 247, 255, .98);
      box-shadow: 0 4px 16px rgba(0, 0, 0, .38);
      font: 17px/1 system-ui, sans-serif;
      user-select: none;
    }
    body.icx-middle-autoscrolling,
    body.icx-middle-autoscrolling * {
      cursor: all-scroll !important;
    }
  `
  document.head.appendChild(style)
}

function cancelFrame(session) {
  if (!session?.frame) return
  cancelAnimationFrame(session.frame)
  session.frame = 0
  session.lastAt = 0
}

function stopSession(session = activeSession) {
  if (!session) return
  cancelFrame(session)
  session.anchor?.remove?.()
  document.body.classList.remove('icx-middle-autoscrolling')
  if (activeSession === session) activeSession = null
}

function frame(session, now) {
  session.frame = 0
  const ctx = session.node?.__bil
  if (!ctx || ctx !== session.ctx || ctx.removed || !ctx.list || activeSession !== session) {
    stopSession(session)
    return
  }

  const speed = middleAutoscrollSpeed(session.clientY, session.originY, ctx.list.clientHeight)
  if (!speed) {
    session.lastAt = 0
    return
  }

  const previous = session.lastAt || now
  const elapsed = Math.min(40, Math.max(0, now - previous))
  session.lastAt = now
  if (elapsed) {
    const maxScroll = Math.max(0, ctx.list.scrollHeight - ctx.list.clientHeight)
    const next = Math.min(maxScroll, Math.max(0, ctx.list.scrollTop + speed * elapsed / 1000))
    if (next !== ctx.list.scrollTop) ctx.list.scrollTop = next
  }
  session.frame = requestAnimationFrame((timestamp) => frame(session, timestamp))
}

function ensureFrame(session) {
  if (!session || session.frame || activeSession !== session) return
  const ctx = session.node?.__bil
  if (!ctx?.list || ctx.removed) return
  const speed = middleAutoscrollSpeed(session.clientY, session.originY, ctx.list.clientHeight)
  if (!speed) return
  session.lastAt = 0
  session.frame = requestAnimationFrame((timestamp) => frame(session, timestamp))
}

function startSession(node, ctx, event) {
  stopSession()
  const anchor = document.createElement('div')
  anchor.className = 'icx-middle-autoscroll-anchor'
  anchor.textContent = '↕'
  anchor.style.left = `${Number(event.clientX) || 0}px`
  anchor.style.top = `${Number(event.clientY) || 0}px`
  document.body.appendChild(anchor)
  document.body.classList.add('icx-middle-autoscrolling')

  activeSession = {
    node,
    ctx,
    originY: Number(event.clientY) || 0,
    clientY: Number(event.clientY) || 0,
    anchor,
    frame: 0,
    lastAt: 0
  }
}

function consume(event) {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation?.()
}

function installNode(node, attempts = 0) {
  if (!node || node.__bil?.removed || attempts > 120) return
  const ctx = node.__bil
  if (!ctx?.list || !ctx.icx) {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }
  if (patchedNodes.has(node)) return
  installStyles()
  patchedNodes.add(node)

  const ext = ctx.icx
  ext.middleAutoscrollPointerDown = (event) => {
    const mouse = !event.pointerType || event.pointerType === 'mouse'
    if (!mouse) return

    if (event.button === 1 && insideGallery(ctx, event)) {
      consume(event)
      if (activeSession?.node === node) stopSession(activeSession)
      else startSession(node, ctx, event)
      return
    }

    if (activeSession) stopSession(activeSession)
  }

  ext.middleAutoscrollMouseDown = (event) => {
    if (event.button !== 1 || !insideGallery(ctx, event)) return
    consume(event)
  }

  ext.middleAutoscrollAuxClick = (event) => {
    if (event.button !== 1 || !insideGallery(ctx, event)) return
    consume(event)
  }

  ext.middleAutoscrollPointerMove = (event) => {
    const session = activeSession
    if (!session || session.node !== node) return
    session.clientY = Number(event.clientY) || 0
    const speed = middleAutoscrollSpeed(session.clientY, session.originY, ctx.list.clientHeight)
    if (!speed) cancelFrame(session)
    else ensureFrame(session)
  }

  ext.middleAutoscrollKeyDown = (event) => {
    if (event.key !== 'Escape' || activeSession?.node !== node) return
    stopSession(activeSession)
    consume(event)
  }

  ext.middleAutoscrollWheel = () => {
    if (activeSession?.node === node) stopSession(activeSession)
  }

  ext.middleAutoscrollBlur = () => {
    if (activeSession?.node === node) stopSession(activeSession)
  }

  window.addEventListener('pointerdown', ext.middleAutoscrollPointerDown, true)
  window.addEventListener('mousedown', ext.middleAutoscrollMouseDown, true)
  window.addEventListener('auxclick', ext.middleAutoscrollAuxClick, true)
  window.addEventListener('pointermove', ext.middleAutoscrollPointerMove, true)
  window.addEventListener('keydown', ext.middleAutoscrollKeyDown, true)
  window.addEventListener('wheel', ext.middleAutoscrollWheel, true)
  window.addEventListener('blur', ext.middleAutoscrollBlur)

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    if (activeSession?.node === node) stopSession(activeSession)
    patchedNodes.delete(node)
    window.removeEventListener('pointerdown', ext.middleAutoscrollPointerDown, true)
    window.removeEventListener('mousedown', ext.middleAutoscrollMouseDown, true)
    window.removeEventListener('auxclick', ext.middleAutoscrollAuxClick, true)
    window.removeEventListener('pointermove', ext.middleAutoscrollPointerMove, true)
    window.removeEventListener('keydown', ext.middleAutoscrollKeyDown, true)
    window.removeEventListener('wheel', ext.middleAutoscrollWheel, true)
    window.removeEventListener('blur', ext.middleAutoscrollBlur)
    return previousRemoved?.apply(this, args)
  }
}

app.registerExtension({
  name: EXTENSION_NAME,
  nodeCreated(node) {
    const type = String(node?.comfyClass || node?.type || '')
    if (!NODE_CLASSES.has(type)) return
    queueMicrotask(() => installNode(node))
  }
})
