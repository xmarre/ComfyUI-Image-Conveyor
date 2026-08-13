import { app } from '../../scripts/app.js'
import {
  contextTargetIds,
  dragEdgeAutoscrollConfig,
  dragEdgeAutoscrollSpeed,
  jumpPendingItemsToFront,
  normalizeWheelDelta
} from './image_conveyor_queue_qol_math.mjs?v=20260813b'

const EXTENSION_NAME = 'Comfy.ImageConveyor.QueueQualityOfLife'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const STATE_WIDGET = 'state_json'
const UI_STATE_WIDGET = 'ui_state_json'
const patchedNodes = new Set()
let menuObserver = null

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

function widget(node, name) {
  return (node.widgets ?? []).find((entry) => entry?.name === name) ?? null
}

function readJsonWidget(node, name, fallback) {
  const entry = widget(node, name)
  if (!entry || typeof entry.value !== 'string') return clone(fallback)
  try {
    const parsed = JSON.parse(entry.value)
    return parsed && typeof parsed === 'object' ? parsed : clone(fallback)
  } catch {
    return clone(fallback)
  }
}

function readState(node) {
  const fromWidget = readJsonWidget(node, STATE_WIDGET, null)
  const state = fromWidget && typeof fromWidget === 'object'
    ? fromWidget
    : clone(node.__bil?.state ?? { version: 2, items: [] })
  state.items = Array.isArray(state.items) ? state.items : []
  return state
}

function readUiState(node) {
  const fromWidget = readJsonWidget(node, UI_STATE_WIDGET, null)
  const ui = fromWidget && typeof fromWidget === 'object'
    ? fromWidget
    : clone(node.__bil?.uiState ?? { version: 2, selected_ids: [], source_paths: {} })
  ui.selected_ids = Array.isArray(ui.selected_ids) ? ui.selected_ids : []
  ui.source_paths = ui.source_paths && typeof ui.source_paths === 'object' ? ui.source_paths : {}
  return ui
}

function writeWidget(entry, value) {
  if (!entry) return
  entry.value = value
  entry.callback?.(value)
}

function requestRender(node) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return
  ctx.renderedRangeKey = ''
  if (ctx.browser?.activeView === 'conveyor' && ctx.conveyorFilter) {
    ctx.conveyorFilter.dispatchEvent(new Event('change'))
  } else {
    node.setDirtyCanvas?.(true, true)
  }
}

function commitState(node, state, uiState = readUiState(node)) {
  const ctx = node.__bil
  writeWidget(widget(node, STATE_WIDGET), JSON.stringify(state))
  writeWidget(widget(node, UI_STATE_WIDGET), JSON.stringify(uiState))
  if (ctx) {
    ctx.state = state
    ctx.uiState = uiState
    ctx.renderVersion = (ctx.renderVersion || 0) + 1
    ctx.queueRevision = (ctx.queueRevision || 0) + 1
    ctx.annotatedCountsRevision = -1
  }
  node.graph?.change?.()
  requestRender(node)
}

function closeImageMenu(ctx) {
  if (!ctx) return
  if (ctx.imageContextMenuDismiss) {
    document.removeEventListener('pointerdown', ctx.imageContextMenuDismiss.pointerdown, true)
    document.removeEventListener('keydown', ctx.imageContextMenuDismiss.keydown, true)
    window.removeEventListener('blur', ctx.imageContextMenuDismiss.blur)
    ctx.imageContextMenuDismiss = null
  }
  ctx.imageContextMenu?.remove?.()
  ctx.imageContextMenu = null
  ctx.imageContextMenuSource = null
}

function currentContextTargets(node, clickedId) {
  const ctx = node.__bil
  const state = readState(node)
  const selected = ctx?.browser?.conveyor?.selected instanceof Set
    ? ctx.browser.conveyor.selected
    : new Set()
  const ids = contextTargetIds(state.items, selected, clickedId)
  return { state, ids }
}

function applyContextStatus(node, clickedId, status) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return
  const { state, ids } = currentContextTargets(node, clickedId)
  if (!ids.length) return
  const targets = new Set(ids)
  const now = Date.now()
  for (const item of state.items) {
    if (!targets.has(String(item?.id ?? ''))) continue
    item.status = status
    if (status === 'processed') item.last_processed_at = now
  }
  commitState(node, state)
}

function removeContextTargets(node, clickedId) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return
  const { state, ids } = currentContextTargets(node, clickedId)
  if (!ids.length) return
  const targets = new Set(ids)
  const ui = readUiState(node)
  state.items = state.items.filter((item) => !targets.has(String(item?.id ?? '')))
  for (const id of targets) {
    ctx.browser.conveyor.selected.delete(id)
    delete ui.source_paths[id]
  }
  ui.selected_ids = ui.selected_ids.filter((id) => !targets.has(String(id)))
  commitState(node, state, ui)
}

function jumpContextTargets(node, clickedId) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return
  const state = readState(node)
  const selected = ctx.browser?.conveyor?.selected instanceof Set
    ? ctx.browser.conveyor.selected
    : new Set()
  const result = jumpPendingItemsToFront(state.items, selected, clickedId)
  if (!result.changed) return
  state.items = result.items

  // Queue priority must be visible as the actual execution order, even if the user previously
  // chose a one-shot display sort. The persistent queue is always manual after a priority move.
  ctx.browser.conveyor.sort = 'manual'
  if (ctx.conveyorSort) ctx.conveyorSort.value = 'manual'
  commitState(node, state)
}

function menuButton(menu, label) {
  return Array.from(menu.querySelectorAll('button')).find((button) => (
    String(button.textContent || '').trim() === label
  )) ?? null
}

function installOwnedMenuAction(button, ctx, handler) {
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation?.()
    try {
      handler()
    } catch (error) {
      window.alert(error?.message || 'The Conveyor action failed.')
    } finally {
      closeImageMenu(ctx)
    }
  }, true)
}

function ownerForMenu(menu) {
  for (const node of patchedNodes) {
    const ctx = node?.__bil
    if (ctx?.imageContextMenu === menu && !ctx.removed) return node
  }
  return null
}

function enhanceConveyorContextMenu(menu) {
  if (!(menu instanceof Element) || menu.dataset.icQueueQol === '1') return
  const node = ownerForMenu(menu)
  const ctx = node?.__bil
  const source = ctx?.imageContextMenuSource
  if (!node || !ctx || source?.referenceIndex != null || ctx.browser?.activeView !== 'conveyor') return
  const clickedId = String(source?.itemId ?? '').trim()
  if (!clickedId) return
  menu.dataset.icQueueQol = '1'

  const { state, ids } = currentContextTargets(node, clickedId)
  const targetSet = new Set(ids)
  const promotableCount = state.items.filter((item) => (
    item?.status !== 'queued' && targetSet.has(String(item?.id ?? ''))
  )).length
  const markPending = menuButton(menu, 'Mark pending')
  const markProcessed = menuButton(menu, 'Mark processed')
  const remove = menuButton(menu, 'Remove from Conveyor')

  if (markPending) {
    const jumpButton = document.createElement('button')
    jumpButton.type = 'button'
    jumpButton.setAttribute('role', 'menuitem')
    jumpButton.textContent = promotableCount > 1
      ? `Move ${promotableCount} selected images to queue front`
      : 'Move to front of pending queue'
    jumpButton.disabled = promotableCount === 0
    jumpButton.title = promotableCount
      ? 'Make the selected image(s) the next unreserved Conveyor work. Processed selections are re-queued as pending; already queued reservations stay fixed.'
      : 'The selected image(s) are already reserved by queued ComfyUI executions.'
    installOwnedMenuAction(jumpButton, ctx, () => jumpContextTargets(node, clickedId))
    markPending.before(jumpButton)
  }

  if (ids.length > 1) {
    if (markPending) {
      markPending.textContent = `Mark selected pending (${ids.length})`
      installOwnedMenuAction(markPending, ctx, () => applyContextStatus(node, clickedId, 'pending'))
    }
    if (markProcessed) {
      markProcessed.textContent = `Mark selected processed (${ids.length})`
      installOwnedMenuAction(markProcessed, ctx, () => applyContextStatus(node, clickedId, 'processed'))
    }
    if (remove) {
      remove.textContent = `Remove selected from Conveyor (${ids.length})`
      installOwnedMenuAction(remove, ctx, () => removeContextTargets(node, clickedId))
    }
  }
}

function ensureMenuObserver() {
  if (menuObserver || !document.body) return
  menuObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (!(added instanceof Element)) continue
        if (added.matches('.bil-image-menu')) enhanceConveyorContextMenu(added)
        for (const menu of added.querySelectorAll?.('.bil-image-menu') ?? []) enhanceConveyorContextMenu(menu)
      }
    }
  })
  menuObserver.observe(document.body, { childList: true })
}

function releaseMenuObserver() {
  if (patchedNodes.size || !menuObserver) return
  menuObserver.disconnect()
  menuObserver = null
}

function eventOrigin(event) {
  return event.composedPath?.()[0] ?? event.target
}

function internalDragActive(ctx) {
  return Boolean(
    ctx?.draggedId ||
    ctx?.icx?.batchDrag?.items?.length ||
    ctx?.icx?.cardDrag?.items?.length
  )
}

function installGalleryWheelOwnership(ctx, ext) {
  ext.queueQolWheel = (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    const target = eventOrigin(event)
    if (!(target instanceof Node) || !ctx.list?.contains(target)) return
    const maxScroll = Math.max(0, ctx.list.scrollHeight - ctx.list.clientHeight)
    if (maxScroll <= 0) return
    const delta = normalizeWheelDelta(event.deltaY, event.deltaMode, ctx.list.clientHeight)
    if (!delta) return
    event.preventDefault()
    event.stopPropagation()
    ctx.list.scrollTop = Math.min(maxScroll, Math.max(0, ctx.list.scrollTop + delta))
  }
  window.addEventListener('wheel', ext.queueQolWheel, { capture: true, passive: false })
}

function installDragAutoscroll(ctx, ext) {
  ext.queueQolDragPointer = null
  ext.queueQolDragFrame = 0
  ext.queueQolDragLastAt = 0

  const stop = () => {
    ext.queueQolDragPointer = null
    ext.queueQolDragLastAt = 0
    if (ext.queueQolDragFrame) cancelAnimationFrame(ext.queueQolDragFrame)
    ext.queueQolDragFrame = 0
  }

  const frame = (now) => {
    ext.queueQolDragFrame = 0
    const pointer = ext.queueQolDragPointer
    if (!pointer || !internalDragActive(ctx) || !ctx.list || ctx.removed) {
      stop()
      return
    }
    if (now - pointer.observedAt > 700) {
      stop()
      return
    }

    const rect = ctx.list.getBoundingClientRect()
    const config = dragEdgeAutoscrollConfig(ctx.list.clientHeight)
    const speed = dragEdgeAutoscrollSpeed(pointer.clientY, rect.top, rect.bottom, config.edgeSize, config.maxSpeed)
    if (!speed) {
      stop()
      return
    }
    const previousAt = ext.queueQolDragLastAt || now
    const elapsed = Math.min(40, Math.max(0, now - previousAt))
    ext.queueQolDragLastAt = now
    if (elapsed) {
      const maxScroll = Math.max(0, ctx.list.scrollHeight - ctx.list.clientHeight)
      const next = Math.min(maxScroll, Math.max(0, ctx.list.scrollTop + speed * elapsed / 1000))
      if (next === ctx.list.scrollTop) {
        stop()
        return
      }
      ctx.list.scrollTop = next
    }
    ext.queueQolDragFrame = requestAnimationFrame(frame)
  }

  ext.queueQolDragOver = (event) => {
    if (!internalDragActive(ctx) || !ctx.list) {
      stop()
      return
    }
    const rect = ctx.list.getBoundingClientRect()
    const config = dragEdgeAutoscrollConfig(ctx.list.clientHeight)
    const horizontal = event.clientX >= rect.left && event.clientX <= rect.right
    const verticalMargin = config.edgeSize * 0.35
    const relevant = horizontal && event.clientY >= rect.top - verticalMargin && event.clientY <= rect.bottom + verticalMargin
    if (!relevant) {
      stop()
      return
    }
    ext.queueQolDragPointer = {
      clientY: event.clientY,
      observedAt: globalThis.performance?.now?.() ?? Date.now()
    }
    const speed = dragEdgeAutoscrollSpeed(event.clientY, rect.top, rect.bottom, config.edgeSize, config.maxSpeed)
    if (!speed) {
      stop()
      return
    }
    if (!ext.queueQolDragFrame) {
      ext.queueQolDragLastAt = 0
      ext.queueQolDragFrame = requestAnimationFrame(frame)
    }
  }
  ext.queueQolDragStop = stop
  window.addEventListener('dragover', ext.queueQolDragOver, true)
  window.addEventListener('drop', stop, true)
  window.addEventListener('dragend', stop, true)
  window.addEventListener('blur', stop)
}

function installNode(node, attempts = 0) {
  if (!node || node.__bil?.removed || attempts > 120) return
  const ctx = node.__bil
  if (!ctx?.list || !ctx.browser || !ctx.icx) {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }
  if (patchedNodes.has(node)) return
  patchedNodes.add(node)
  ensureMenuObserver()

  const ext = ctx.icx
  installGalleryWheelOwnership(ctx, ext)
  installDragAutoscroll(ctx, ext)

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    patchedNodes.delete(node)
    releaseMenuObserver()
    window.removeEventListener('wheel', ext.queueQolWheel, true)
    window.removeEventListener('dragover', ext.queueQolDragOver, true)
    window.removeEventListener('drop', ext.queueQolDragStop, true)
    window.removeEventListener('dragend', ext.queueQolDragStop, true)
    window.removeEventListener('blur', ext.queueQolDragStop)
    ext.queueQolDragStop?.()
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
