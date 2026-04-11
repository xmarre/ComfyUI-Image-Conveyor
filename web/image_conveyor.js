import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'
import '../../scripts/domWidget.js'

const EXTENSION_NAME = 'Comfy.ImageConveyor.VueNodes'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const STATE_WIDGET = 'state_json'
const UI_STATE_WIDGET = 'ui_state_json'
const QUEUE_WIDGET = 'queue_item_json'
const CUSTOM_WIDGET_INPUT = 'batch_loader_ui'
const CUSTOM_WIDGET_TYPE = 'BATCH_IMAGE_LOADER_UI'
const DOM_WIDGET_NAME = 'batch_loader_ui'
const DEFAULT_SUBFOLDER = 'image_conveyor'
const STYLE_ID = 'comfy-batch-image-loader-style'
const STATE_VERSION = 1
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'bmp',
  'gif',
  'tif',
  'tiff',
  'avif'
])
const ROW_HEIGHT = 66
const ROW_GAP = 6
const ROW_STRIDE = ROW_HEIGHT + ROW_GAP
const LIST_OVERSCAN = 6

function structuredCloneCompat(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

function safeJsonParse(raw, fallback) {
  if (typeof raw !== 'string' || !raw.trim()) return structuredCloneCompat(fallback)
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object'
      ? parsed
      : structuredCloneCompat(fallback)
  } catch {
    return structuredCloneCompat(fallback)
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    items: []
  }
}

function defaultUiState() {
  return {
    version: STATE_VERSION,
    selected_ids: []
  }
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null
  const id = String(item.id ?? '').trim()
  const annotated = String(item.annotated ?? '').trim()
  if (!id || !annotated) return null

  const rawStatus = String(item.status ?? 'pending').toLowerCase()
  const status = ['pending', 'queued', 'processed'].includes(rawStatus)
    ? rawStatus
    : 'pending'

  return {
    id,
    annotated,
    filename: String(item.filename ?? '').trim(),
    subfolder: String(item.subfolder ?? '').trim(),
    type: String(item.type ?? 'input').trim() || 'input',
    status,
    added_at: Number(item.added_at ?? 0) || 0,
    last_queued_at: Number(item.last_queued_at ?? 0) || 0,
    last_processed_at: Number(item.last_processed_at ?? 0) || 0
  }
}

function parseState(raw) {
  const state = safeJsonParse(raw, defaultState())
  const items = Array.isArray(state.items)
    ? state.items.map(normalizeItem).filter(Boolean)
    : []
  return {
    version: STATE_VERSION,
    items
  }
}

function parseUiState(raw) {
  const uiState = safeJsonParse(raw, defaultUiState())
  const selectedIds = Array.isArray(uiState.selected_ids)
    ? uiState.selected_ids.map((value) => String(value)).filter(Boolean)
    : []
  return {
    version: STATE_VERSION,
    selected_ids: selectedIds
  }
}

function serializeState(state) {
  return JSON.stringify({ version: STATE_VERSION, items: state.items }, null, 0)
}

function serializeUiState(uiState) {
  return JSON.stringify(
    { version: STATE_VERSION, selected_ids: uiState.selected_ids },
    null,
    0
  )
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `bil_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function itemStatusRank(status) {
  switch (status) {
    case 'pending':
      return 0
    case 'queued':
      return 1
    case 'processed':
      return 2
    default:
      return 3
  }
}

function getSelectedIds(uiState) {
  return new Set(uiState.selected_ids)
}

function setWidgetValue(widget, value) {
  widget.value = value
  widget.callback?.(value)
}

function markNodeDirty(node) {
  node.setDirtyCanvas?.(true, true)
  node.graph?.change?.()
}

function getWidgets(node) {
  const widgetsByName = new Map()
  for (const widget of node.widgets ?? []) {
    widgetsByName.set(widget.name, widget)
  }
  return {
    stateWidget: widgetsByName.get(STATE_WIDGET),
    uiStateWidget: widgetsByName.get(UI_STATE_WIDGET),
    queueWidget: widgetsByName.get(QUEUE_WIDGET)
  }
}

function getCurrentState(node) {
  const { stateWidget, uiStateWidget } = getWidgets(node)
  const state = parseState(stateWidget?.value ?? '')
  const uiState = parseUiState(uiStateWidget?.value ?? '')
  const validIds = new Set(state.items.map((item) => item.id))
  uiState.selected_ids = uiState.selected_ids.filter((id) => validIds.has(id))
  return { state, uiState }
}

function cacheRenderableState(node, state, uiState) {
  const ctx = node.__bil
  if (!ctx) return
  ctx.state = state
  ctx.uiState = uiState
  ctx.renderVersion = (ctx.renderVersion || 0) + 1
}

function getRenderableState(node) {
  const ctx = node.__bil
  if (ctx?.state && ctx?.uiState) {
    return { state: ctx.state, uiState: ctx.uiState }
  }
  const snapshot = getCurrentState(node)
  cacheRenderableState(node, snapshot.state, snapshot.uiState)
  return snapshot
}

function updateState(node, state, uiState, { rerender = true } = {}) {
  const { stateWidget, uiStateWidget } = getWidgets(node)
  if (!stateWidget || !uiStateWidget) return
  setWidgetValue(stateWidget, serializeState(state))
  setWidgetValue(uiStateWidget, serializeUiState(uiState))
  cacheRenderableState(node, state, uiState)
  markNodeDirty(node)
  if (rerender) scheduleRenderNode(node)
}

function scheduleRenderNode(node, { viewportOnly = false } = {}) {
  const ctx = node.__bil
  if (!ctx) return
  ctx.renderViewportOnly = ctx.renderFrame
    ? Boolean(ctx.renderViewportOnly && viewportOnly)
    : Boolean(viewportOnly)
  if (ctx.renderFrame) return
  ctx.renderFrame = requestAnimationFrame(() => {
    const renderViewportOnly = ctx.renderViewportOnly
    ctx.renderFrame = 0
    ctx.renderViewportOnly = false
    if (renderViewportOnly) {
      renderVisibleRows(node)
    } else {
      renderNode(node)
    }
  })
}

function updateQueueWidget(node, payload) {
  const { queueWidget } = getWidgets(node)
  if (!queueWidget) return
  setWidgetValue(queueWidget, payload ? JSON.stringify(payload) : '')
}

function findFirstByStatus(state, statuses) {
  return state.items.find((item) => statuses.includes(item.status)) ?? null
}

function applySelectionToggle(uiState, itemId, checked) {
  const selected = getSelectedIds(uiState)
  if (checked) selected.add(itemId)
  else selected.delete(itemId)
  uiState.selected_ids = Array.from(selected)
}

function moveItems(state, draggedId, targetId) {
  if (!draggedId || !targetId || draggedId === targetId) return false
  const fromIndex = state.items.findIndex((item) => item.id === draggedId)
  const toIndex = state.items.findIndex((item) => item.id === targetId)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return false
  const [moved] = state.items.splice(fromIndex, 1)
  state.items.splice(toIndex, 0, moved)
  return true
}

function getFileExtension(name) {
  const fileName = String(name ?? '')
  const match = fileName.match(/\.([^.]+)$/)
  return match ? match[1].toLowerCase() : ''
}

function isProbablyImageFile(file) {
  if (!(file instanceof File)) return false
  if (typeof file.type === 'string' && file.type.startsWith('image/')) return true
  return IMAGE_EXTENSIONS.has(getFileExtension(file.name))
}

function hasExternalFileDrag(event) {
  const transfer = event?.dataTransfer
  if (!transfer) return false

  const files = Array.from(transfer.files ?? [])
  if (files.some((file) => isProbablyImageFile(file))) {
    return true
  }

  const types = Array.from(transfer.types ?? [])
  return types.includes('Files')
}

function getDroppedImageFiles(event) {
  return Array.from(event?.dataTransfer?.files ?? []).filter((file) =>
    isProbablyImageFile(file)
  )
}

function consumeExternalFileDrag(event) {
  if (!hasExternalFileDrag(event)) return false
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation?.()
  if (event.dataTransfer) {
    try {
      event.dataTransfer.dropEffect = 'copy'
    } catch {
      // ignore browser-specific dropEffect failures
    }
  }
  return true
}

function filePreviewUrl(item) {
  const params = new URLSearchParams()
  params.set(
    'filename',
    item.filename || item.annotated.replace(/ \[(input|output|temp)\]$/, '')
  )
  if (item.subfolder) params.set('subfolder', item.subfolder)
  params.set('type', item.type || 'input')
  params.set(
    'rand',
    String(item.last_processed_at || item.last_queued_at || item.added_at || 0)
  )
  return api.apiURL(`/view?${params.toString()}`)
}

function makeItemFromUploadResponse(data) {
  const filename = String(data?.name ?? '').trim()
  const subfolder = String(data?.subfolder ?? '').trim()
  const type = String(data?.type ?? 'input').trim() || 'input'
  if (!filename) return null

  const path = subfolder ? `${subfolder}/${filename}` : filename
  return {
    id: makeId(),
    annotated: `${path} [${type}]`,
    filename,
    subfolder,
    type,
    status: 'pending',
    added_at: Date.now(),
    last_queued_at: 0,
    last_processed_at: 0
  }
}

async function uploadFiles(files) {
  const uploaded = []
  for (const file of files) {
    if (!isProbablyImageFile(file)) continue
    const body = new FormData()
    body.append('image', file)
    body.append('type', 'input')
    body.append('subfolder', DEFAULT_SUBFOLDER)
    const response = await api.fetchApi('/upload/image', {
      method: 'POST',
      body
    })
    if (!response.ok) {
      throw new Error(
        `Failed to upload '${file.name}': ${response.status} ${response.statusText}`
      )
    }
    uploaded.push(await response.json())
  }
  return uploaded
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .bil-root {
      --comfy-widget-min-height: 540px;
      --comfy-widget-max-height: 540px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      height: 100%;
      min-height: 540px;
      color: var(--input-text, #ddd);
      font: 12px/1.35 system-ui, sans-serif;
      box-sizing: border-box;
      padding: 2px 0;
    }
    .bil-root.bil-dragover {
      outline: 1px dashed rgba(120,180,255,0.9);
      outline-offset: -2px;
      border-radius: 10px;
      background: rgba(120,180,255,0.06);
    }
    .bil-toolbar, .bil-subtoolbar, .bil-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .bil-dropzone {
      border: 1px dashed rgba(255,255,255,0.25);
      border-radius: 8px;
      padding: 10px;
      text-align: center;
      background: rgba(255,255,255,0.04);
      cursor: pointer;
      user-select: none;
    }
    .bil-dropzone.bil-dragover {
      border-color: rgba(120,180,255,0.9);
      background: rgba(120,180,255,0.12);
    }
    .bil-btn, .bil-select {
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.06);
      color: inherit;
      border-radius: 6px;
      padding: 4px 8px;
      font: inherit;
    }
    .bil-btn { cursor: pointer; }
    .bil-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .bil-summary {
      justify-content: space-between;
      gap: 8px;
      opacity: 0.9;
    }
    .bil-list {
      position: relative;
      min-height: 180px;
      max-height: 100%;
      overflow: auto;
      padding-right: 2px;
      flex: 1 1 auto;
      contain: layout paint style;
    }
    .bil-list-inner {
      position: relative;
      min-height: 100%;
    }
    .bil-list-window {
      position: absolute;
      inset: 0 2px auto 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      will-change: transform;
    }
    .bil-empty {
      padding: 14px 10px;
      text-align: center;
      border: 1px dashed rgba(255,255,255,0.12);
      border-radius: 8px;
      opacity: 0.7;
    }
    .bil-row {
      display: grid;
      grid-template-columns: 24px 52px minmax(0,1fr) auto auto;
      gap: 8px;
      align-items: center;
      height: 66px;
      padding: 6px;
      box-sizing: border-box;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 8px;
      background: rgba(0,0,0,0.16);
      contain: content;
    }
    .bil-row.bil-selected {
      border-color: rgba(120,180,255,0.85);
      background: rgba(120,180,255,0.10);
    }
    .bil-row.bil-drag-target {
      outline: 1px dashed rgba(120,180,255,0.95);
      outline-offset: -2px;
    }
    .bil-thumb {
      width: 52px;
      height: 52px;
      object-fit: cover;
      border-radius: 6px;
      background: rgba(255,255,255,0.06);
    }
    .bil-meta {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .bil-name,
    .bil-path {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bil-name { font-weight: 600; }
    .bil-path {
      opacity: 0.72;
      font-size: 11px;
    }
    .bil-right {
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-items: flex-end;
      min-width: 82px;
    }
    .bil-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 72px;
      padding: 2px 6px;
      border-radius: 999px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      background: rgba(255,255,255,0.08);
    }
    .bil-badge-pending { background: rgba(160,160,160,0.18); }
    .bil-badge-queued { background: rgba(255,190,70,0.22); }
    .bil-badge-processed { background: rgba(80,190,110,0.24); }
    .bil-index {
      opacity: 0.72;
      font-variant-numeric: tabular-nums;
    }
    .bil-status-text { opacity: 0.8; }
    .bil-row-actions {
      display: flex;
      gap: 4px;
      align-items: center;
      justify-content: flex-end;
      flex-wrap: wrap;
      min-width: 108px;
    }
    .bil-mini-btn {
      border: 1px solid rgba(255,255,255,0.16);
      background: rgba(255,255,255,0.04);
      color: inherit;
      border-radius: 6px;
      padding: 2px 6px;
      font: inherit;
      cursor: pointer;
    }
  `
  document.head.appendChild(style)
}

function applyBackendDelta(node, delta) {
  if (!delta || typeof delta !== 'object') return
  const { state, uiState } = getCurrentState(node)
  const item = state.items.find((entry) => entry.id === delta.processed_item_id)
  if (!item) return
  item.status = delta.new_status === 'processed' ? 'processed' : item.status
  item.last_processed_at = Date.now()
  updateState(node, state, uiState, { rerender: true })
}

function attachQueueLifecycle(node) {
  if (node.__bilQueueLifecycleAttached) return
  node.__bilQueueLifecycleAttached = true

  const { queueWidget } = getWidgets(node)
  if (!queueWidget) return

  queueWidget.beforeQueued = () => {
    const { state } = getCurrentState(node)
    const item = findFirstByStatus(state, ['pending'])
    updateQueueWidget(
      node,
      item
        ? {
            id: item.id,
            annotated: item.annotated
          }
        : null
    )
  }

  queueWidget.afterQueued = () => {
    const queuePayload = safeJsonParse(queueWidget.value, {})
    if (!queuePayload?.id) return
    const { state, uiState } = getCurrentState(node)
    const item = state.items.find((entry) => entry.id === queuePayload.id)
    if (!item) return
    item.status = 'queued'
    item.last_queued_at = Date.now()
    updateState(node, state, uiState, { rerender: true })
  }
}

function chainNodeCallback(node, key, handler) {
  const previous = node[key]
  node[key] = function (...args) {
    previous?.apply(this, args)
    return handler.apply(this, args)
  }
}

function getVisibleRowRange(list, totalItems) {
  if (!totalItems) return { start: 0, end: 0, offset: 0, height: 0 }

  const viewportHeight = Math.max(list.clientHeight || 0, ROW_STRIDE)
  const scrollTop = Math.max(list.scrollTop || 0, 0)
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / ROW_STRIDE))
  const rawStart = Math.max(0, Math.floor(scrollTop / ROW_STRIDE) - LIST_OVERSCAN)
  const maxStart = Math.max(0, totalItems - (visibleCount + LIST_OVERSCAN * 2))
  const start = Math.min(rawStart, maxStart)
  const end = Math.min(totalItems, start + visibleCount + LIST_OVERSCAN * 2)
  const height = Math.max(0, totalItems * ROW_STRIDE - ROW_GAP)
  return {
    start,
    end,
    offset: start * ROW_STRIDE,
    height
  }
}

function buildRow(node, ctx, item, index, selected) {
  const row = document.createElement('div')
  row.className = 'bil-row'
  row.draggable = true
  row.dataset.itemId = item.id

  if (selected.has(item.id)) row.classList.add('bil-selected')

  row.addEventListener('dragstart', () => {
    ctx.draggedId = item.id
  })
  row.addEventListener('dragend', () => {
    ctx.draggedId = null
    row.classList.remove('bil-drag-target')
  })
  row.addEventListener('dragover', (event) => {
    event.preventDefault()
    row.classList.add('bil-drag-target')
  })
  row.addEventListener('dragleave', () => {
    row.classList.remove('bil-drag-target')
  })
  row.addEventListener('drop', (event) => {
    event.preventDefault()
    row.classList.remove('bil-drag-target')
    const { state: liveState, uiState: liveUiState } = getCurrentState(node)
    if (moveItems(liveState, ctx.draggedId, item.id)) {
      updateState(node, liveState, liveUiState)
    }
    ctx.draggedId = null
  })

  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = selected.has(item.id)
  checkbox.addEventListener('change', () => {
    const { state: liveState, uiState: liveUiState } = getCurrentState(node)
    applySelectionToggle(liveUiState, item.id, checkbox.checked)
    updateState(node, liveState, liveUiState)
  })

  const thumb = document.createElement('img')
  thumb.className = 'bil-thumb'
  thumb.alt = item.filename || item.annotated
  thumb.loading = 'lazy'
  thumb.decoding = 'async'
  thumb.src = filePreviewUrl(item)

  const meta = document.createElement('div')
  meta.className = 'bil-meta'

  const name = document.createElement('div')
  name.className = 'bil-name'
  name.textContent = item.filename || item.annotated

  const path = document.createElement('div')
  path.className = 'bil-path'
  path.textContent = item.annotated

  meta.append(name, path)

  const right = document.createElement('div')
  right.className = 'bil-right'

  const badge = document.createElement('div')
  badge.className = `bil-badge bil-badge-${item.status}`
  badge.textContent = item.status

  const indexText = document.createElement('div')
  indexText.className = 'bil-index'
  indexText.textContent = `#${index + 1}`

  right.append(badge, indexText)

  const actions = document.createElement('div')
  actions.className = 'bil-row-actions'

  const pendingBtn = document.createElement('button')
  pendingBtn.className = 'bil-mini-btn'
  pendingBtn.type = 'button'
  pendingBtn.textContent = 'Pending'
  pendingBtn.addEventListener('click', () => {
    const { state: liveState, uiState: liveUiState } = getCurrentState(node)
    const liveItem = liveState.items.find((entry) => entry.id === item.id)
    if (!liveItem) return
    liveItem.status = 'pending'
    updateState(node, liveState, liveUiState)
  })

  const processedBtn = document.createElement('button')
  processedBtn.className = 'bil-mini-btn'
  processedBtn.type = 'button'
  processedBtn.textContent = 'Done'
  processedBtn.addEventListener('click', () => {
    const { state: liveState, uiState: liveUiState } = getCurrentState(node)
    const liveItem = liveState.items.find((entry) => entry.id === item.id)
    if (!liveItem) return
    liveItem.status = 'processed'
    liveItem.last_processed_at = Date.now()
    updateState(node, liveState, liveUiState)
  })

  const deleteBtn = document.createElement('button')
  deleteBtn.className = 'bil-mini-btn'
  deleteBtn.type = 'button'
  deleteBtn.textContent = 'Delete'
  deleteBtn.addEventListener('click', () => {
    const { state: liveState, uiState: liveUiState } = getCurrentState(node)
    liveState.items = liveState.items.filter((entry) => entry.id !== item.id)
    liveUiState.selected_ids = liveUiState.selected_ids.filter(
      (id) => id !== item.id
    )
    updateState(node, liveState, liveUiState)
  })

  actions.append(pendingBtn, processedBtn, deleteBtn)
  row.append(checkbox, thumb, meta, right, actions)
  return row
}

function renderVisibleRows(node) {
  const ctx = node.__bil
  if (!ctx) return

  const { state, uiState } = getRenderableState(node)
  const selected = getSelectedIds(uiState)

  if (!state.items.length) {
    ctx.listWindow.replaceChildren()
    ctx.listInner.style.height = '0px'
    ctx.listWindow.style.transform = 'translateY(0px)'
    ctx.renderedRangeKey = ''
    return
  }

  const { start, end, offset, height } = getVisibleRowRange(ctx.list, state.items.length)
  const rangeKey = `${ctx.renderVersion}:${start}:${end}:${offset}:${selected.size}`
  if (ctx.renderedRangeKey === rangeKey) return

  ctx.listInner.style.height = `${height}px`
  ctx.listWindow.style.transform = `translateY(${offset}px)`
  ctx.listWindow.replaceChildren(
    ...state.items
      .slice(start, end)
      .map((item, localIndex) => buildRow(node, ctx, item, start + localIndex, selected))
  )
  ctx.renderedRangeKey = rangeKey
}

function renderNode(node) {
  const ctx = node.__bil
  if (!ctx) return

  const snapshot = getCurrentState(node)
  cacheRenderableState(node, snapshot.state, snapshot.uiState)
  const { state, uiState } = snapshot
  const selected = getSelectedIds(uiState)

  let pendingCount = 0
  let queuedCount = 0
  let processedCount = 0
  for (const item of state.items) {
    if (item.status === 'pending') pendingCount += 1
    else if (item.status === 'queued') queuedCount += 1
    else if (item.status === 'processed') processedCount += 1
  }
  const nextItem = findFirstByStatus(state, ['pending', 'queued'])

  ctx.summary.textContent = `Total ${state.items.length} · Pending ${pendingCount} · Queued ${queuedCount} · Processed ${processedCount}`
  ctx.nextText.textContent = nextItem
    ? `Next: ${nextItem.filename || nextItem.annotated}`
    : 'Next: none'

  if (!state.items.length) {
    ctx.listWindow.replaceChildren()
    ctx.listInner.style.height = '0px'
    ctx.listWindow.style.transform = 'translateY(0px)'
    ctx.renderedRangeKey = ''
    if (!ctx.empty) {
      ctx.empty = document.createElement('div')
      ctx.empty.className = 'bil-empty'
      ctx.empty.textContent = 'Drop images here or click the drop area to add them.'
    }
    ctx.empty.hidden = false
    if (ctx.empty.parentElement !== ctx.listInner) {
      ctx.listInner.appendChild(ctx.empty)
    }
  } else {
    ctx.empty?.remove()
    renderVisibleRows(node)
  }

  ctx.setPendingBtn.disabled = selected.size === 0
  ctx.setProcessedBtn.disabled = selected.size === 0
  ctx.deleteSelectedBtn.disabled = selected.size === 0
}

function buildDom(node) {
  ensureStyles()

  const root = document.createElement('div')
  root.className = 'bil-root'

  const dropzone = document.createElement('div')
  dropzone.className = 'bil-dropzone'
  dropzone.textContent = 'Click or drop one or more images'

  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'image/*,.png,.jpg,.jpeg,.webp,.bmp,.gif,.tif,.tiff,.avif'
  fileInput.multiple = true
  fileInput.style.display = 'none'

  const toolbar = document.createElement('div')
  toolbar.className = 'bil-toolbar'

  const selectAllBtn = document.createElement('button')
  selectAllBtn.className = 'bil-btn'
  selectAllBtn.type = 'button'
  selectAllBtn.textContent = 'Select all'

  const selectNoneBtn = document.createElement('button')
  selectNoneBtn.className = 'bil-btn'
  selectNoneBtn.type = 'button'
  selectNoneBtn.textContent = 'Clear selection'

  const sortSelect = document.createElement('select')
  sortSelect.className = 'bil-select'
  ;[
    ['manual', 'Manual order'],
    ['name_asc', 'Sort name ↑'],
    ['name_desc', 'Sort name ↓'],
    ['added_newest', 'Sort newest'],
    ['added_oldest', 'Sort oldest'],
    ['status', 'Sort status']
  ].forEach(([value, label]) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    sortSelect.appendChild(option)
  })

  const sortBtn = document.createElement('button')
  sortBtn.className = 'bil-btn'
  sortBtn.type = 'button'
  sortBtn.textContent = 'Apply sort'

  toolbar.append(selectAllBtn, selectNoneBtn, sortSelect, sortBtn)

  const subtoolbar = document.createElement('div')
  subtoolbar.className = 'bil-subtoolbar'

  const setPendingBtn = document.createElement('button')
  setPendingBtn.className = 'bil-btn'
  setPendingBtn.type = 'button'
  setPendingBtn.textContent = 'Set pending'

  const setProcessedBtn = document.createElement('button')
  setProcessedBtn.className = 'bil-btn'
  setProcessedBtn.type = 'button'
  setProcessedBtn.textContent = 'Set processed'

  const clearQueuedBtn = document.createElement('button')
  clearQueuedBtn.className = 'bil-btn'
  clearQueuedBtn.type = 'button'
  clearQueuedBtn.textContent = 'Clear queued'

  const clearProcessedBtn = document.createElement('button')
  clearProcessedBtn.className = 'bil-btn'
  clearProcessedBtn.type = 'button'
  clearProcessedBtn.textContent = 'Remove processed'

  const deleteSelectedBtn = document.createElement('button')
  deleteSelectedBtn.className = 'bil-btn'
  deleteSelectedBtn.type = 'button'
  deleteSelectedBtn.textContent = 'Delete selected'

  subtoolbar.append(
    setPendingBtn,
    setProcessedBtn,
    clearQueuedBtn,
    clearProcessedBtn,
    deleteSelectedBtn
  )

  const summary = document.createElement('div')
  summary.className = 'bil-summary'
  const summaryText = document.createElement('div')
  const nextText = document.createElement('div')
  nextText.className = 'bil-status-text'
  summary.append(summaryText, nextText)

  const list = document.createElement('div')
  list.className = 'bil-list'

  const listInner = document.createElement('div')
  listInner.className = 'bil-list-inner'

  const listWindow = document.createElement('div')
  listWindow.className = 'bil-list-window'

  listInner.appendChild(listWindow)
  list.appendChild(listInner)

  root.append(fileInput, dropzone, toolbar, subtoolbar, summary, list)

  node.__bil = {
    root,
    dropzone,
    fileInput,
    summary: summaryText,
    nextText,
    list,
    listInner,
    listWindow,
    setPendingBtn,
    setProcessedBtn,
    deleteSelectedBtn,
    draggedId: null,
    empty: null,
    state: null,
    uiState: null,
    renderVersion: 0,
    renderedRangeKey: '',
    renderFrame: 0,
    renderViewportOnly: false
  }

  list.addEventListener('scroll', () => scheduleRenderNode(node, { viewportOnly: true }), {
    passive: true
  })

  let externalDragDepth = 0
  const setExternalDragActive = (active) => {
    root.classList.toggle('bil-dragover', active)
    dropzone.classList.toggle('bil-dragover', active)
  }

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList ?? []).filter((file) => isProbablyImageFile(file))
    if (!files.length) return

    dropzone.textContent = `Uploading ${files.length} image${files.length === 1 ? '' : 's'}…`
    try {
      const uploaded = await uploadFiles(files)
      const { state, uiState } = getCurrentState(node)
      for (const entry of uploaded) {
        const item = makeItemFromUploadResponse(entry)
        if (item) state.items.push(item)
      }
      updateState(node, state, uiState)
    } finally {
      dropzone.textContent = 'Click or drop one or more images'
      fileInput.value = ''
    }
  }

  dropzone.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => handleFiles(fileInput.files))

  root.addEventListener(
    'dragenter',
    (event) => {
      if (!consumeExternalFileDrag(event)) return
      externalDragDepth += 1
      setExternalDragActive(true)
    },
    true
  )

  root.addEventListener(
    'dragover',
    (event) => {
      if (!consumeExternalFileDrag(event)) return
      setExternalDragActive(true)
    },
    true
  )

  root.addEventListener(
    'dragleave',
    (event) => {
      if (!(externalDragDepth > 0 || hasExternalFileDrag(event))) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
      externalDragDepth = Math.max(0, externalDragDepth - 1)
      if (externalDragDepth === 0) {
        setExternalDragActive(false)
      }
    },
    true
  )

  root.addEventListener(
    'drop',
    async (event) => {
      const files = getDroppedImageFiles(event)
      externalDragDepth = 0
      setExternalDragActive(false)
      if (!files.length) return
      consumeExternalFileDrag(event)
      await handleFiles(files)
    },
    true
  )

  root.addEventListener(
    'dragend',
    () => {
      externalDragDepth = 0
      setExternalDragActive(false)
    },
    true
  )

  selectAllBtn.addEventListener('click', () => {
    const { state, uiState } = getCurrentState(node)
    uiState.selected_ids = state.items.map((item) => item.id)
    updateState(node, state, uiState)
  })

  selectNoneBtn.addEventListener('click', () => {
    const { state, uiState } = getCurrentState(node)
    uiState.selected_ids = []
    updateState(node, state, uiState)
  })

  sortBtn.addEventListener('click', () => {
    const { state, uiState } = getCurrentState(node)
    switch (sortSelect.value) {
      case 'name_asc':
        state.items.sort((a, b) =>
          a.annotated.localeCompare(b.annotated, undefined, {
            sensitivity: 'base'
          })
        )
        break
      case 'name_desc':
        state.items.sort((a, b) =>
          b.annotated.localeCompare(a.annotated, undefined, {
            sensitivity: 'base'
          })
        )
        break
      case 'added_newest':
        state.items.sort((a, b) => (b.added_at || 0) - (a.added_at || 0))
        break
      case 'added_oldest':
        state.items.sort((a, b) => (a.added_at || 0) - (b.added_at || 0))
        break
      case 'status':
        state.items.sort((a, b) => {
          const rankDiff = itemStatusRank(a.status) - itemStatusRank(b.status)
          if (rankDiff !== 0) return rankDiff
          return (a.added_at || 0) - (b.added_at || 0)
        })
        break
      default:
        break
    }
    updateState(node, state, uiState)
  })

  setPendingBtn.addEventListener('click', () => {
    const { state, uiState } = getCurrentState(node)
    const selected = getSelectedIds(uiState)
    state.items.forEach((item) => {
      if (selected.has(item.id)) item.status = 'pending'
    })
    updateState(node, state, uiState)
  })

  setProcessedBtn.addEventListener('click', () => {
    const { state, uiState } = getCurrentState(node)
    const selected = getSelectedIds(uiState)
    state.items.forEach((item) => {
      if (selected.has(item.id)) {
        item.status = 'processed'
        item.last_processed_at = Date.now()
      }
    })
    updateState(node, state, uiState)
  })

  clearQueuedBtn.addEventListener('click', () => {
    const { state, uiState } = getCurrentState(node)
    state.items.forEach((item) => {
      if (item.status === 'queued') item.status = 'pending'
    })
    updateState(node, state, uiState)
  })

  clearProcessedBtn.addEventListener('click', () => {
    const { state, uiState } = getCurrentState(node)
    state.items = state.items.filter((item) => item.status !== 'processed')
    uiState.selected_ids = uiState.selected_ids.filter((id) =>
      state.items.some((item) => item.id === id)
    )
    updateState(node, state, uiState)
  })

  deleteSelectedBtn.addEventListener('click', () => {
    const { state, uiState } = getCurrentState(node)
    const selected = getSelectedIds(uiState)
    state.items = state.items.filter((item) => !selected.has(item.id))
    uiState.selected_ids = []
    updateState(node, state, uiState)
  })

  return root
}

async function uploadViaNode(node, files) {
  const ctx = node.__bil
  if (!ctx) return false
  const validFiles = files.filter((file) => isProbablyImageFile(file))
  if (!validFiles.length) return false

  ctx.dropzone.textContent = `Uploading ${validFiles.length} image${validFiles.length === 1 ? '' : 's'}…`
  try {
    const uploaded = await uploadFiles(validFiles)
    const { state, uiState } = getCurrentState(node)
    for (const entry of uploaded) {
      const item = makeItemFromUploadResponse(entry)
      if (item) state.items.push(item)
    }
    updateState(node, state, uiState)
    return true
  } finally {
    ctx.dropzone.textContent = 'Click or drop one or more images'
  }
}

function initializeNode(node, widget) {
  if (node.__bilInitialized) return widget
  node.__bilInitialized = true
  node.__bilWidget = widget

  const { stateWidget, uiStateWidget, queueWidget } = getWidgets(node)
  if (!stateWidget || !uiStateWidget || !queueWidget) return widget

  stateWidget.hidden = true
  stateWidget.options.hidden = true

  uiStateWidget.hidden = true
  uiStateWidget.options.hidden = true
  uiStateWidget.serialize = false

  queueWidget.hidden = true
  queueWidget.options.hidden = true
  queueWidget.serialize = false

  const oldSize = node.size || [420, 700]
  node.setSize?.([Math.max(oldSize[0], 520), Math.max(oldSize[1], 760)])

  attachQueueLifecycle(node)

  node.onDragOver = (event) => {
    if (!hasExternalFileDrag(event)) return false
    event.preventDefault?.()
    event.stopPropagation?.()
    event.stopImmediatePropagation?.()
    return true
  }

  node.onDragDrop = async (event) => {
    const files = getDroppedImageFiles(event)
    if (!files.length) return false
    consumeExternalFileDrag(event)
    return await uploadViaNode(node, files)
  }

  chainNodeCallback(node, 'onExecuted', function (output) {
    const payload = output?.batch_image_loader_delta?.[0]
    if (!payload) return
    try {
      applyBackendDelta(node, JSON.parse(payload))
    } catch {
      // ignore malformed UI delta
    }
  })

  chainNodeCallback(node, 'onConfigure', function () {
    const snapshot = getCurrentState(node)
    cacheRenderableState(node, snapshot.state, snapshot.uiState)
    queueMicrotask(() => scheduleRenderNode(node))
    requestAnimationFrame(() => scheduleRenderNode(node))
  })

  chainNodeCallback(node, 'onResize', function () {
    scheduleRenderNode(node, { viewportOnly: true })
  })

  chainNodeCallback(node, 'onRemoved', function () {
    const ctx = node.__bil
    if (!ctx?.renderFrame) return
    cancelAnimationFrame(ctx.renderFrame)
    ctx.renderFrame = 0
    ctx.renderViewportOnly = false
  })

  const snapshot = getCurrentState(node)
  cacheRenderableState(node, snapshot.state, snapshot.uiState)
  queueMicrotask(() => scheduleRenderNode(node))
  requestAnimationFrame(() => scheduleRenderNode(node))
  return widget
}

function maybeInjectWidgetInput(nodeData) {
  if (!NODE_CLASSES.has(nodeData.name)) return
  const required = nodeData?.input?.required
  if (!required || required[CUSTOM_WIDGET_INPUT]) return
  nodeData.input.required = {
    ...required,
    [CUSTOM_WIDGET_INPUT]: [CUSTOM_WIDGET_TYPE, {}]
  }
}

app.registerExtension({
  name: EXTENSION_NAME,

  beforeRegisterNodeDef(_nodeType, nodeData) {
    maybeInjectWidgetInput(nodeData)
  },

  getCustomWidgets() {
    return {
      [CUSTOM_WIDGET_TYPE](node, inputName) {
        if (node.__bilWidget) {
          return {
            widget: node.__bilWidget,
            minHeight: 540,
            minWidth: 520
          }
        }

        const root = buildDom(node)
        const widget = node.addDOMWidget(inputName, CUSTOM_WIDGET_TYPE, root, {
          getMinHeight: () => 540,
          getMaxHeight: () => 540,
          serialize: false
        })
        widget.serialize = false

        initializeNode(node, widget)

        return {
          widget,
          minHeight: 540,
          minWidth: 520
        }
      }
    }
  }
})
