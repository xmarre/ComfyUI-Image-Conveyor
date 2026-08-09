import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'
import '../../scripts/domWidget.js'
import { CARD_FOOTER_HEIGHT, calculateGalleryMetrics, calculateVisibleCardRange } from './image_conveyor_math.mjs'

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
const MIN_WIDGET_HEIGHT = 540
const MIN_NODE_WIDTH = 520
const MIN_NODE_HEIGHT = 760
const CARD_GAP = 10
const GALLERY_OVERSCAN_ROWS = 2
const CARD_SIZES = {
  small: { minWidth: 124, thumbnail: 160 },
  medium: { minWidth: 172, thumbnail: 256 },
  large: { minWidth: 224, thumbnail: 384 }
}

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
    items: [],
    auto_queue: false,
    dont_consume: false,
    catch_canvas_drops: false
  }
}

/**
 * Create the default UI state for the image conveyor widget.
 *
 * @returns {{version:number, selected_ids:string[], source_paths:Object}} An object with:
 *  - `version`: the UI state schema version,
 *  - `selected_ids`: an array of item IDs that are currently selected,
 *  - `source_paths`: a mapping from item ID to the runtime source path string.
 */
function defaultUiState() {
  return {
    version: STATE_VERSION,
    selected_ids: [],
    source_paths: {}
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
    source_path: sanitizePersistedSourcePath(item.source_path),
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
    items,
    auto_queue: Boolean(state.auto_queue),
    dont_consume: Boolean(state.dont_consume),
    catch_canvas_drops: Boolean(state.catch_canvas_drops)
  }
}

/**
 * Parse a stored UI-state JSON value into a normalized runtime UI state.
 *
 * Parses `raw` using safe JSON parsing and normalizes `selected_ids` into an array of non-empty strings
 * and `source_paths` into an object mapping item ids to normalized source path strings. Always returns
 * the current `STATE_VERSION` along with the normalized fields.
 *
 * @param {*} raw - The raw stored widget value (JSON string or object) to parse.
 * @returns {{version:number, selected_ids:string[], source_paths:Record<string,string>}} The normalized UI state containing `version`, `selected_ids`, and `source_paths`.
 */
function parseUiState(raw) {
  const uiState = safeJsonParse(raw, defaultUiState())
  const selectedIds = Array.isArray(uiState.selected_ids)
    ? uiState.selected_ids.map((value) => String(value)).filter(Boolean)
    : []
  const sourcePaths = {}
  if (uiState.source_paths && typeof uiState.source_paths === 'object') {
    for (const [key, value] of Object.entries(uiState.source_paths)) {
      const itemId = String(key ?? '').trim()
      const sourcePath = normalizeSourcePath(value)
      if (itemId && sourcePath) sourcePaths[itemId] = sourcePath
    }
  }
  return {
    version: STATE_VERSION,
    selected_ids: selectedIds,
    source_paths: sourcePaths
  }
}

function serializeState(state) {
  return JSON.stringify(
    {
      version: STATE_VERSION,
      items: state.items,
      auto_queue: Boolean(state.auto_queue),
      dont_consume: Boolean(state.dont_consume),
      catch_canvas_drops: Boolean(state.catch_canvas_drops)
    },
    null,
    0
  )
}

/**
 * Serialize the UI state into a compact JSON string suitable for widget storage.
 * @param {{selected_ids: string[], source_paths: Record<string, string>}} uiState - UI state containing selected item IDs and optional per-item runtime source paths.
 * @returns {string} JSON text containing `version` (STATE_VERSION), `selected_ids`, and `source_paths`.
 */
function serializeUiState(uiState) {
  return JSON.stringify(
    {
      version: STATE_VERSION,
      selected_ids: uiState.selected_ids,
      source_paths: uiState.source_paths
    },
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

/**
 * Read and normalize the node's stored state and UI state, pruning UI selections and source paths to items that exist in the state.
 * @param {object} node - The ComfyUI node containing the hidden `state` and `ui_state` widgets.
 * @returns {{state: object, uiState: object}} An object with `state` (normalized state shape) and `uiState` (normalized UI shape). `uiState.selected_ids` will contain only IDs present in `state.items`, and `uiState.source_paths` will only include entries whose keys match `state.items` IDs.
 */
function getCurrentState(node, { fromWidgets = false } = {}) {
  const cached = node.__bil
  if (!fromWidgets && cached?.state && cached?.uiState) {
    return { state: cached.state, uiState: cached.uiState }
  }
  const { stateWidget, uiStateWidget } = getWidgets(node)
  const state = parseState(stateWidget?.value ?? '')
  const uiState = parseUiState(uiStateWidget?.value ?? '')
  const validIds = new Set(state.items.map((item) => item.id))
  uiState.selected_ids = uiState.selected_ids.filter((id) => validIds.has(id))
  uiState.source_paths = Object.fromEntries(
    Object.entries(uiState.source_paths).filter(([itemId]) => validIds.has(itemId))
  )
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

function updateState(
  node,
  state,
  uiState,
  { rerender = true, commitState = true, commitUi = true } = {}
) {
  const { stateWidget, uiStateWidget } = getWidgets(node)
  if (!stateWidget || !uiStateWidget) return
  if (commitState) setWidgetValue(stateWidget, serializeState(state))
  if (commitUi) setWidgetValue(uiStateWidget, serializeUiState(uiState))
  if (commitState && node.__bil) {
    node.__bil.queueRevision = (node.__bil.queueRevision || 0) + 1
    node.__bil.annotatedCountsRevision = -1
  }
  cacheRenderableState(node, state, uiState)
  if (commitState) markNodeDirty(node)
  if (rerender) scheduleRenderNode(node)
}

function scheduleRenderNode(node, { viewportOnly = false, forceVisibleRows = false } = {}) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return
  if (forceVisibleRows) ctx.renderedRangeKey = ''
  ctx.renderViewportOnly = ctx.renderFrame
    ? Boolean(ctx.renderViewportOnly && viewportOnly)
    : Boolean(viewportOnly)
  if (ctx.renderFrame) return
  ctx.renderFrame = requestAnimationFrame(() => {
    const renderViewportOnly = ctx.renderViewportOnly
    ctx.renderFrame = 0
    ctx.renderViewportOnly = false
    if (renderViewportOnly) {
      renderVisibleCards(node)
    } else {
      renderGalleryNode(node)
    }
  })
}

function getFiniteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function getWidgetOuterHeight(node, widget) {
  const nodeHeight = Math.max(
    MIN_NODE_HEIGHT,
    getFiniteNumber(node?.size?.[1], MIN_NODE_HEIGHT)
  )
  const widgetY = Math.max(
    0,
    getFiniteNumber(widget?.y, getFiniteNumber(widget?.last_y, 0))
  )
  return Math.max(MIN_WIDGET_HEIGHT, Math.floor(nodeHeight - widgetY))
}

function syncDomWidgetSize(node, widget) {
  const ctx = node.__bil
  if (!ctx || !widget) return

  const margin = Math.max(0, getFiniteNumber(widget.margin, 10))
  const outerHeight = getWidgetOuterHeight(node, widget)
  const innerHeight = Math.max(0, outerHeight - margin * 2)
  const width = Math.max(
    MIN_NODE_WIDTH,
    getFiniteNumber(node?.size?.[0], MIN_NODE_WIDTH)
  )

  const changed =
    ctx.widgetOuterHeight !== outerHeight ||
    ctx.widgetInnerHeight !== innerHeight ||
    ctx.widgetWidth !== width

  widget.computedHeight = outerHeight
  widget.width = width

  if (ctx.widgetInnerHeight !== innerHeight) {
    ctx.root.style.height = `${innerHeight}px`
    ctx.root.style.minHeight = `${Math.max(0, MIN_WIDGET_HEIGHT - margin * 2)}px`
  }
  ctx.widgetOuterHeight = outerHeight
  ctx.widgetInnerHeight = innerHeight
  ctx.widgetWidth = width

  if (changed) {
    scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
  }
}

function updateQueueWidget(node, payload) {
  const { queueWidget } = getWidgets(node)
  if (!queueWidget) return
  setWidgetValue(queueWidget, payload ? JSON.stringify(payload) : '')
}

function findFirstByStatus(state, statuses) {
  return state.items.find((item) => statuses.includes(item.status)) ?? null
}

function findNextLoadItem(state) {
  if (state.dont_consume) {
    return findFirstByStatus(state, ['pending', 'queued']) ?? state.items[0] ?? null
  }
  return findFirstByStatus(state, ['pending'])
}

function countItemsByStatus(state, status) {
  let count = 0
  for (const item of state.items) {
    if (item.status === status) count += 1
  }
  return count
}

const autoQueueCoordinator = {
  nodes: new Set(),
  listenerAttached: false,
  pendingInternalQueueRequests: 0,
  warnedAboutMultipleNodes: false,

  registerNode(node) {
    this.nodes.add(node)
    this.attach()
  },

  unregisterNode(node) {
    this.nodes.delete(node)
    if (!this.nodes.size) {
      this.warnedAboutMultipleNodes = false
    }
  },

  attach() {
    if (this.listenerAttached) return
    this.listenerAttached = true
    api.addEventListener('promptQueueing', (event) => {
      this.handlePromptQueueing(event)
    })
  },

  getEligibleNodes() {
    const eligible = []
    for (const node of this.nodes) {
      if (!node?.graph || !node.__bilInitialized) continue
      const { state } = getCurrentState(node)
      if (!state.auto_queue || state.dont_consume) continue
      const pendingCount = countItemsByStatus(state, 'pending')
      if (pendingCount <= 0) continue
      eligible.push({ node, pendingCount })
    }
    return eligible
  },

  handlePromptQueueing(event) {
    if (this.pendingInternalQueueRequests > 0) {
      this.pendingInternalQueueRequests -= 1
      return
    }

    const eligibleNodes = this.getEligibleNodes()
    if (eligibleNodes.length !== 1) {
      if (eligibleNodes.length > 1 && !this.warnedAboutMultipleNodes) {
        this.warnedAboutMultipleNodes = true
        console.warn(
          'Image Conveyor: auto-queue is only applied when exactly one conveyor node with pending items has auto-queue enabled.'
        )
      }
      if (eligibleNodes.length <= 1) {
        this.warnedAboutMultipleNodes = false
      }
      return
    }

    this.warnedAboutMultipleNodes = false

    const requestedBatchCount = Math.max(
      1,
      Math.floor(Number(event?.detail?.batchCount) || 1)
    )
    const { pendingCount } = eligibleNodes[0]
    const extraCount = pendingCount - requestedBatchCount
    if (extraCount <= 0) return

    this.pendingInternalQueueRequests += 1
    queueMicrotask(() => {
      void app.queuePrompt(0, extraCount).catch((error) => {
        console.error(
          'Image Conveyor: failed to auto-queue remaining pending images.',
          error
        )
      })
    })
  }

}

function isTargetInsideConveyorWidget(target) {
  return target instanceof Element && Boolean(target.closest('.bil-root'))
}

function isGraphCanvasDropTarget(target) {
  if (!(target instanceof Node)) return false

  const container =
    app.canvasContainer ??
    document.getElementById('graph-canvas-container') ??
    app.canvas?.canvas?.parentElement ??
    null
  if (container?.contains?.(target)) return true

  const canvasElement = app.canvas?.canvas ?? app.canvasEl ?? null
  return canvasElement === target
}

function getCanvasNodeAtEvent(event) {
  if (!app.canvas?.graph) return null
  try {
    app.canvas.adjustMouseEvent?.(event)
  } catch {
    // Some frontend versions may not accept DragEvent in adjustMouseEvent.
  }
  const canvasX = Number(event?.canvasX)
  const canvasY = Number(event?.canvasY)
  if (!Number.isFinite(canvasX) || !Number.isFinite(canvasY)) return null
  return app.canvas.graph.getNodeOnPos?.(canvasX, canvasY) ?? null
}

function isCanvasNodeSelected(node) {
  if (!node || !app.canvas) return false
  const selected = app.canvas.selected_nodes
  if (!selected) return Boolean(node.selected || node.flags?.selected)
  if (selected instanceof Set) return selected.has(node)
  if (Array.isArray(selected)) return selected.includes(node)
  if (typeof selected === 'object') {
    if (selected[node.id] === node || selected[String(node.id)] === node) return true
    return Object.values(selected).includes(node)
  }
  return Boolean(node.selected || node.flags?.selected)
}

function setCanvasDropTargetActive(node, active) {
  const ctx = node?.__bil
  if (!ctx) return
  ctx.root.classList.toggle('bil-dragover', active)
  ctx.dropzone.classList.toggle('bil-dragover', active)
  if (!active && ctx.cardPool) clearCardDragTargets(ctx)
}

const canvasDropCoordinator = {
  nodes: new Set(),
  listenerAttached: false,
  dragOverHandler: null,
  dropHandler: null,
  dragLeaveHandler: null,
  dragEndHandler: null,
  activeNode: null,
  warnedAboutMultipleNodes: false,

  registerNode(node) {
    this.nodes.add(node)
    this.attach()
  },

  unregisterNode(node) {
    this.nodes.delete(node)
    if (this.activeNode === node) this.setActiveNode(null)
    if (!this.nodes.size) {
      this.warnedAboutMultipleNodes = false
      this.detach()
    }
  },

  attach() {
    if (this.listenerAttached) return
    this.listenerAttached = true
    this.dragOverHandler = (event) => this.handleDragOver(event)
    this.dropHandler = (event) => {
      void this.handleDrop(event)
    }
    this.dragLeaveHandler = (event) => this.handleDragLeave(event)
    this.dragEndHandler = () => this.setActiveNode(null)
    document.addEventListener('dragover', this.dragOverHandler, true)
    document.addEventListener('drop', this.dropHandler, true)
    document.addEventListener('dragleave', this.dragLeaveHandler, true)
    document.addEventListener('dragend', this.dragEndHandler, true)
  },

  detach() {
    if (!this.listenerAttached) return
    document.removeEventListener('dragover', this.dragOverHandler, true)
    document.removeEventListener('drop', this.dropHandler, true)
    document.removeEventListener('dragleave', this.dragLeaveHandler, true)
    document.removeEventListener('dragend', this.dragEndHandler, true)
    this.listenerAttached = false
    this.dragOverHandler = null
    this.dropHandler = null
    this.dragLeaveHandler = null
    this.dragEndHandler = null
    this.setActiveNode(null)
  },

  getEligibleNodes() {
    const eligible = []
    for (const node of this.nodes) {
      if (!node?.graph || !node.__bilInitialized) continue
      const { state } = getCurrentState(node)
      if (!state.catch_canvas_drops) continue
      eligible.push(node)
    }
    return eligible
  },

  resolveDropNode(event) {
    if (!isGraphCanvasDropTarget(event?.target)) return null
    if (isTargetInsideConveyorWidget(event?.target)) return null

    const eligibleNodes = this.getEligibleNodes()
    if (!eligibleNodes.length) {
      this.warnedAboutMultipleNodes = false
      return null
    }

    const selectedNodes = eligibleNodes.filter((node) => isCanvasNodeSelected(node))
    if (selectedNodes.length === 1) {
      this.warnedAboutMultipleNodes = false
      return selectedNodes[0]
    }

    const nodeAtDropPosition = getCanvasNodeAtEvent(event)
    if (eligibleNodes.includes(nodeAtDropPosition)) {
      this.warnedAboutMultipleNodes = false
      return nodeAtDropPosition
    }

    if (eligibleNodes.length === 1) {
      this.warnedAboutMultipleNodes = false
      return eligibleNodes[0]
    }

    if (!this.warnedAboutMultipleNodes) {
      this.warnedAboutMultipleNodes = true
      console.warn(
        'Image Conveyor: multiple conveyors have canvas-drop capture enabled. Select one conveyor before dropping images on empty canvas.'
      )
    }
    return null
  },

  setActiveNode(node) {
    if (this.activeNode === node) return
    if (this.activeNode) setCanvasDropTargetActive(this.activeNode, false)
    this.activeNode = node
    if (this.activeNode) setCanvasDropTargetActive(this.activeNode, true)
  },

  handleDragOver(event) {
    if (event.defaultPrevented && !isGraphCanvasDropTarget(event.target)) return
    const node = this.resolveDropNode(event)
    if (!node) {
      this.setActiveNode(null)
      return
    }
    if (!hasExternalFileDrag(event) && !hasPotentialExternalFileDrag(event)) {
      this.setActiveNode(null)
      return
    }
    activatePotentialExternalFileDrag(event)
    this.setActiveNode(node)
  },

  async handleDrop(event) {
    if (event.defaultPrevented && !isGraphCanvasDropTarget(event.target)) return
    const node = this.resolveDropNode(event)
    if (!node) {
      this.setActiveNode(null)
      return
    }
    if (!hasExternalFileDrag(event)) {
      this.setActiveNode(null)
      return
    }

    finalizeExternalFileDrag(event)
    this.setActiveNode(null)

    const files = await getDroppedImageFiles(event)
    if (!files.length) return
    await uploadViaNode(node, files)
  },

  handleDragLeave(event) {
    if (event.target === document || event.target === document.documentElement) {
      this.setActiveNode(null)
    }
  }
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

function normalizeRelativeSubfolder(path) {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
}

function normalizeSourcePath(path) {
  const trimmed = String(path ?? '').trim()
  if (!trimmed) return ''

  const windowsAbsolute = /^[a-zA-Z]:[\\/]/.test(trimmed)
  const uncAbsolute = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(trimmed)
  if (windowsAbsolute || uncAbsolute) {
    return trimmed.replace(/\\/g, '/')
  }

  const hasLeadingSlash = /^\/+/.test(trimmed)
  const normalized = trimmed
    .replace(/\\/g, '/')
    .replace(/^\/+/, hasLeadingSlash ? '/' : '')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
  if (!normalized) return ''
  if (hasLeadingSlash && !normalized.startsWith('/')) return `/${normalized}`
  return normalized
}

function isAbsoluteSourcePath(path) {
  return /^[a-zA-Z]:\//.test(path) || path.startsWith('//') || path.startsWith('/')
}

function sanitizePersistedSourcePath(path) {
  const normalized = normalizeSourcePath(path)
  if (!normalized) return ''
  if (!isAbsoluteSourcePath(normalized)) return normalized
  const segments = normalized.split('/').filter(Boolean)
  return segments.length ? segments[segments.length - 1] : ''
}

function isMeaningfulSourcePath(path) {
  return /^[a-zA-Z]:\//.test(path) || path.startsWith('//') || path.includes('/')
}

/**
 * Derives a meaningful persisted source path hint from a dropped file entry.
 *
 * Examines available metadata on `entry` in priority order and returns the first plausible path:
 * 1. `file.path` (normalized) unless it appears to be a browser "fakepath",
 * 2. `entry.entry.fullPath` (normalized and trimmed of leading slashes),
 * 3. `file.webkitRelativePath` (normalized),
 * 4. `<relativeSubfolder>/<file.name>` when `relativeSubfolder` is present and normalized;
 * otherwise returns an empty string.
 *
 * @param {object} entry - Drop entry wrapper from drag/drop or file input handling.
 * @param {File} [entry.file] - The File object for the dropped item.
 * @param {object} [entry.entry] - Optional FileSystem entry (may contain `fullPath`).
 * @param {string} [entry.relativeSubfolder] - Optional relative subfolder inferred during directory traversal.
 * @returns {string} A normalized, meaningful source path hint when available, or an empty string.
 */
function getSourcePathHint(entry) {
  const file = entry?.file
  if (!(file instanceof File)) return ''

  const nativePath = typeof file.path === 'string' ? normalizeSourcePath(file.path) : ''
  if (nativePath && !/^[a-zA-Z]:\/fakepath\//i.test(nativePath)) return nativePath

  const entryFullPath = normalizeSourcePath(entry?.entry?.fullPath).replace(/^\/+/, '')
  if (isMeaningfulSourcePath(entryFullPath)) return entryFullPath

  const relativePath = normalizeSourcePath(file.webkitRelativePath)
  if (isMeaningfulSourcePath(relativePath)) return relativePath

  const relativeSubfolder = normalizeRelativeSubfolder(entry?.relativeSubfolder)
  if (!relativeSubfolder) return ''
  return normalizeSourcePath(`${relativeSubfolder}/${file.name}`)
}

/**
 * Selects the runtime source path to display for an item, preferring a UI-provided override.
 * @param {Object} item - Item object with at least `id` and `source_path`.
 * @param {Object|null} uiState - UI state that may contain a `source_paths` map of item id → override path.
 * @returns {string} The normalized source path to use for display, or an empty string if none is available.
 */
function getRuntimeSourcePath(item, uiState = null) {
  const sourcePath = normalizeSourcePath(uiState?.source_paths?.[item.id] ?? item.source_path)
  return sourcePath || ''
}

function stripAnnotatedStorageTypeSuffix(value) {
  return String(value ?? '').replace(/ \[(input|output|temp)\]$/, '')
}

/**
 * Choose the display path for an item, preferring a runtime source path when available.
 * @param {Object} item - Item object containing at least `annotated` and persisted `source_path`.
 * @param {Object|null} [uiState=null] - Optional UI state that may contain `source_paths[item.id]` to override the item's persisted path.
 * @returns {string} The runtime `source_path` if it appears meaningful, otherwise the item's `annotated` text without the storage-type suffix.
 */
function getItemDisplayPath(item, uiState = null) {
  const sourcePath = getRuntimeSourcePath(item, uiState)
  return isMeaningfulSourcePath(sourcePath)
    ? sourcePath
    : stripAnnotatedStorageTypeSuffix(item.annotated)
}

/**
 * Build the upload subfolder path used for image uploads.
 * @param {string} relativeSubfolder - A relative subfolder path (may be empty or contain redundant segments); treated as relative to the base upload folder.
 * @returns {string} The resulting upload subfolder path; if `relativeSubfolder` is empty or normalizes to empty, returns the base upload folder.
 */
function buildUploadSubfolder(relativeSubfolder = '') {
  const normalized = normalizeRelativeSubfolder(relativeSubfolder)
  return normalized ? `${DEFAULT_SUBFOLDER}/${normalized}` : DEFAULT_SUBFOLDER
}

function normalizeUploadFiles(files) {
  return Array.from(files ?? [])
    .map((entry) => {
      if (entry instanceof File) {
        return { file: entry, relativeSubfolder: '' }
      }
      if (entry?.file instanceof File) {
        return {
          file: entry.file,
          relativeSubfolder: normalizeRelativeSubfolder(entry.relativeSubfolder)
        }
      }
      return null
    })
    .filter((entry) => entry && isProbablyImageFile(entry.file))
}

function getTransferItemEntry(item) {
  if (!item || typeof item.webkitGetAsEntry !== 'function') return null
  try {
    return item.webkitGetAsEntry()
  } catch {
    return null
  }
}

function getTransferItemFile(item) {
  if (!item || typeof item.getAsFile !== 'function') return null
  try {
    return item.getAsFile()
  } catch {
    return null
  }
}

function hasExternalFileDrag(event) {
  const transfer = event?.dataTransfer
  if (!transfer) return false

  const items = Array.from(transfer.items ?? []).filter((item) => item?.kind === 'file')
  if (
    items.some((item) => {
      const entry = getTransferItemEntry(item)
      if (entry?.isDirectory) return true
      return isProbablyImageFile(getTransferItemFile(item))
    })
  ) {
    return true
  }

  const files = Array.from(transfer.files ?? [])
  return files.some((file) => isProbablyImageFile(file))
}

function hasPotentialExternalFileDrag(event) {
  const transfer = event?.dataTransfer
  if (!transfer) return false
  if (hasExternalFileDrag(event)) return true

  const types = Array.from(transfer.types ?? [])
  return types.includes('Files')
}

function finalizeExternalFileDrag(event) {
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
}

function readDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const entries = []

    const pump = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            resolve(entries)
            return
          }
          entries.push(...batch)
          pump()
        },
        (error) => reject(error)
      )
    }

    pump()
  })
}

function compareFileSystemEntryNames(left, right) {
  return String(left?.name ?? '').localeCompare(String(right?.name ?? ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  })
}

async function collectImageFilesFromEntry(entry, parentPath = '') {
  if (!entry) return []

  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => {
      entry.file(resolve, reject)
    })
    if (!isProbablyImageFile(file)) return []
    return [
      {
        file,
        relativeSubfolder: normalizeRelativeSubfolder(parentPath)
      }
    ]
  }

  if (!entry.isDirectory || typeof entry.createReader !== 'function') return []

  const directoryPath = normalizeRelativeSubfolder(
    parentPath ? `${parentPath}/${entry.name}` : entry.name
  )
  const reader = entry.createReader()
  const children = await readDirectoryEntries(reader)
  children.sort(compareFileSystemEntryNames)

  const files = []
  for (const child of children) {
    files.push(...(await collectImageFilesFromEntry(child, directoryPath)))
  }
  return files
}

async function getDroppedImageFiles(event) {
  const transfer = event?.dataTransfer
  const fallbackFiles = Array.from(transfer?.files ?? [])
  const items = Array.from(transfer?.items ?? []).filter((item) => item?.kind === 'file')

  if (items.length) {
    const snapshots = items
      .map((item) => {
        let entry = null
        try {
          entry = getTransferItemEntry(item)
        } catch {
          // fall back to plain file extraction when entry lookup fails
        }

        const file = getTransferItemFile(item)
        if (!entry && !file) return null
        return { entry, file }
      })
      .filter(Boolean)

    const expanded = []
    for (const snapshot of snapshots) {
      if (snapshot.entry) {
        try {
          expanded.push(...(await collectImageFilesFromEntry(snapshot.entry)))
          continue
        } catch {
          // fall back to plain file extraction when directory traversal fails
        }
      }
      if (isProbablyImageFile(snapshot.file)) {
        expanded.push({ file: snapshot.file, relativeSubfolder: '' })
      }
    }
    if (expanded.length) return expanded
  }

  return normalizeUploadFiles(fallbackFiles)
}

function consumeExternalFileDrag(event) {
  if (!hasExternalFileDrag(event)) return false
  finalizeExternalFileDrag(event)
  return true
}

function activatePotentialExternalFileDrag(event) {
  if (!hasPotentialExternalFileDrag(event)) return false
  event.preventDefault()
  if (event.dataTransfer) {
    try {
      event.dataTransfer.dropEffect = 'copy'
    } catch {
      // ignore browser-specific dropEffect failures
    }
  }
  return true
}

function getClipboardImageFiles(event) {
  const transfer = event?.clipboardData
  if (!transfer) return []

  const items = Array.from(transfer.items ?? [])
  const filesFromItems = items
    .filter((item) => item?.kind === 'file' && String(item.type ?? '').startsWith('image/'))
    .map((item) => {
      try {
        return item.getAsFile()
      } catch {
        return null
      }
    })
    .filter((file) => file instanceof File && isProbablyImageFile(file))

  if (filesFromItems.length) return filesFromItems

  return Array.from(transfer.files ?? []).filter((file) => isProbablyImageFile(file))
}

function shouldIgnoreClipboardPasteTarget(target) {
  if (target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(target.type)
  }
  for (let element = target instanceof HTMLElement ? target : null; element; element = element.parentElement) {
    if (element.isContentEditable) return true
  }
  return Boolean(window.getSelection?.()?.toString().trim())
}

function isModifiedPlainTextPaste(event) {
  return event.shiftKey && (event.ctrlKey || event.metaKey)
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

function getInputRelativePath(item) {
  if (String(item?.type ?? 'input') !== 'input') return ''
  const annotated = stripAnnotatedStorageTypeSuffix(item?.annotated)
  const explicit = String(item?.relative_path ?? '').trim()
  return normalizeSourcePath(explicit || annotated).replace(/^\/+/, '')
}

function thumbnailUrl(item, density = 'medium') {
  const relativePath = getInputRelativePath(item)
  if (!relativePath) return filePreviewUrl(item)
  const params = new URLSearchParams()
  params.set('relative_path', relativePath)
  params.set('size', String(CARD_SIZES[density]?.thumbnail ?? CARD_SIZES.medium.thumbnail))
  if (item.source_version || item.mtime_ns) params.set('v', String(item.source_version || item.mtime_ns))
  return api.apiURL(`/image-conveyor/thumbnail?${params.toString()}`)
}

function makeItemFromInputFile(entry) {
  const relativePath = normalizeSourcePath(entry?.relative_path).replace(/^\/+/, '')
  const filename = String(entry?.filename ?? '').trim()
  if (!relativePath || !filename) return null
  const subfolder = String(entry?.subfolder ?? '').trim()
  return {
    id: makeId(),
    annotated: `${relativePath} [input]`,
    filename,
    subfolder,
    source_path: relativePath,
    type: 'input',
    status: 'pending',
    added_at: Date.now(),
    last_queued_at: 0,
    last_processed_at: 0
  }
}

function makeItemFromUploadResponse(data) {
  const filename = String(data?.name ?? '').trim()
  const subfolder = String(data?.subfolder ?? '').trim()
  const sourcePath = sanitizePersistedSourcePath(data?.source_path)
  const type = String(data?.type ?? 'input').trim() || 'input'
  if (!filename) return null

  const path = subfolder ? `${subfolder}/${filename}` : filename
  return {
    id: makeId(),
    annotated: `${path} [${type}]`,
    filename,
    subfolder,
    source_path: sourcePath,
    type,
    status: 'pending',
    added_at: Date.now(),
    last_queued_at: 0,
    last_processed_at: 0
  }
}

async function uploadFiles(files) {
  const uploaded = []
  const errors = []
  for (const entry of normalizeUploadFiles(files)) {
    const { file, relativeSubfolder } = entry
    try {
      const body = new FormData()
      body.append('image', file)
      body.append('type', 'input')
      body.append('subfolder', buildUploadSubfolder(relativeSubfolder))
      const response = await api.fetchApi('/image-conveyor/resolve-upload', {
        method: 'POST',
        body
      })
      if (!response.ok) {
        let detail = response.statusText
        try {
          const errorPayload = await response.json()
          detail = errorPayload?.error || detail
        } catch {
          // Keep the HTTP status text when the server did not return JSON.
        }
        throw new Error(`Failed to import '${file.name}': ${response.status} ${detail}`)
      }
      const payload = await response.json()
      if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        typeof payload.name !== 'string' ||
        !payload.name.trim()
      ) {
        throw new Error(`Invalid upload response for '${file.name}'.`)
      }
      payload.source_path = getSourcePathHint(entry)
      uploaded.push(payload)
    } catch (error) {
      errors.push({ file, error: error instanceof Error ? error : new Error(String(error)) })
    }
  }
  return { uploaded, errors }
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .bil-root {
      --comfy-widget-min-height: ${MIN_WIDGET_HEIGHT}px;
      --comfy-widget-height: 100%;
      display: flex; flex-direction: column; gap: 8px; height: 100%;
      min-height: ${MIN_WIDGET_HEIGHT}px; overflow: hidden; box-sizing: border-box;
      padding: 2px 0; color: var(--input-text, #ddd); font: 12px/1.35 system-ui, sans-serif;
    }
    .bil-root.bil-dragover { outline: 2px dashed #73aef5; outline-offset: -3px; border-radius: 10px; background: rgba(90,155,235,.08); }
    .bil-header, .bil-browserbar, .bil-summary, .bil-contextbar, .bil-settings-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .bil-header { justify-content: space-between; }
    .bil-tabs { display: flex; gap: 3px; min-width: 0; }
    .bil-tab, .bil-btn, .bil-select, .bil-input, .bil-icon-btn {
      border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.055);
      color: inherit; border-radius: 7px; padding: 5px 8px; font: inherit; box-sizing: border-box;
    }
    .bil-tab, .bil-btn, .bil-icon-btn { cursor: pointer; }
    .bil-tab[aria-selected="true"] { background: rgba(105,165,240,.20); border-color: rgba(115,175,250,.65); }
    .bil-btn:disabled, .bil-icon-btn:disabled { opacity: .4; cursor: not-allowed; }
    .bil-add-btn { font-weight: 650; white-space: nowrap; }
    .bil-browserbar { display: grid; grid-template-columns: minmax(110px,1fr) auto auto auto; }
    .bil-input { min-width: 0; width: 100%; }
    .bil-select { min-width: 0; max-width: 132px; }
    .bil-summary { justify-content: space-between; color: color-mix(in srgb, currentColor 78%, transparent); white-space: nowrap; overflow: hidden; }
    .bil-summary > * { overflow: hidden; text-overflow: ellipsis; }
    .bil-contextbar { min-height: 29px; padding: 4px 6px; border-radius: 7px; background: rgba(105,165,240,.11); }
    .bil-contextbar[hidden] { display: none; }
    .bil-context-label { margin-right: auto; font-weight: 650; }
    .bil-settings { border: 1px solid rgba(255,255,255,.10); border-radius: 7px; }
    .bil-settings > summary { cursor: pointer; padding: 5px 7px; user-select: none; opacity: .82; }
    .bil-settings-row { flex-wrap: wrap; padding: 0 7px 7px; }
    .bil-toggle { display: inline-flex; align-items: center; gap: 5px; user-select: none; white-space: nowrap; }
    .bil-toggle input { margin: 0; }
    .bil-list { position: relative; min-height: 0; overflow: auto; flex: 1 1 0; overscroll-behavior: contain; outline: none; }
    .bil-list-inner, .bil-list-window { position: relative; min-height: 100%; }
    .bil-empty { min-height: 100%; display: flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 20px; text-align: center; border: 1px dashed rgba(255,255,255,.14); border-radius: 10px; opacity: .7; }
    .bil-card {
      position: absolute; display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box;
      border: 1px solid rgba(255,255,255,.11); border-radius: 10px; background: rgba(0,0,0,.18);
      contain: layout paint style; transition: border-color 80ms ease, background 80ms ease;
    }
    .bil-card.bil-selected { border-color: rgba(110,175,255,.95); box-shadow: inset 0 0 0 1px rgba(110,175,255,.34); background: rgba(80,145,225,.11); }
    .bil-card.bil-focused { outline: 2px solid rgba(150,200,255,.95); outline-offset: -3px; }
    .bil-card.bil-drag-target { outline: 2px dashed rgba(120,185,255,.95); outline-offset: -4px; }
    .bil-media { position: relative; flex: 1 1 auto; min-height: 0; background: transparent; cursor: pointer; }
    .bil-thumb { width: 100%; height: 100%; display: block; object-fit: contain; background: transparent; }
    .bil-thumb-error { opacity: .32; filter: grayscale(1); outline: 1px dashed rgba(255,110,110,.78); outline-offset: -2px; }
    .bil-card-overlay { position: absolute; inset: 6px 6px auto 6px; display: flex; align-items: flex-start; justify-content: space-between; gap: 4px; pointer-events: none; }
    .bil-card-check { pointer-events: auto; width: 17px; height: 17px; margin: 0; accent-color: #6aaef7; }
    .bil-badge { padding: 2px 6px; border-radius: 999px; font-size: 10px; text-transform: uppercase; letter-spacing: .025em; background: rgba(20,20,20,.72); backdrop-filter: blur(3px); }
    .bil-badge-pending { color: #e2e2e2; } .bil-badge-queued { color: #ffd276; } .bil-badge-processed { color: #8bea9e; }
    .bil-count-badge { color: #cce4ff; text-transform: none; }
    .bil-card-footer { flex: 0 0 ${CARD_FOOTER_HEIGHT}px; display: flex; flex-direction: column; justify-content: center; gap: 4px; padding: 5px 7px 6px; min-width: 0; }
    .bil-card-title-row, .bil-card-actions { display: flex; align-items: center; gap: 4px; min-width: 0; }
    .bil-name { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 620; }
    .bil-index { flex: 0 0 auto; opacity: .65; font-variant-numeric: tabular-nums; }
    .bil-path { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .62; font-size: 10px; }
    .bil-card-actions { justify-content: flex-end; }
    .bil-mini-btn { border: 0; background: transparent; color: inherit; border-radius: 5px; padding: 2px 5px; font: inherit; cursor: pointer; opacity: .78; }
    .bil-mini-btn:hover { background: rgba(255,255,255,.10); opacity: 1; }
    .bil-position { margin-left: auto; opacity: .65; font-variant-numeric: tabular-nums; }
    .bil-lightbox { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: center; justify-content: center; padding: 36px; background: rgba(0,0,0,.86); }
    .bil-lightbox[hidden] { display: none; }
    .bil-lightbox img { max-width: 94vw; max-height: 90vh; object-fit: contain; box-shadow: 0 18px 60px rgba(0,0,0,.45); }
    .bil-lightbox-label { position: absolute; left: 24px; bottom: 18px; right: 70px; color: white; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bil-lightbox-close { position: absolute; top: 18px; right: 20px; font-size: 24px; color: white; background: rgba(255,255,255,.12); border: 0; border-radius: 8px; width: 38px; height: 38px; cursor: pointer; }
    @media (max-width: 600px) { .bil-browserbar { grid-template-columns: minmax(100px,1fr) auto auto; } .bil-browserbar .bil-size-select { display: none; } }
  `
  document.head.appendChild(style)
}

function applyBackendDelta(node, delta) {
  if (!delta || typeof delta !== 'object') return
  const { state, uiState } = getCurrentState(node)
  const item = state.items.find((entry) => entry.id === delta.processed_item_id)
  if (!item || delta.consumed === false) return
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
    const item = findNextLoadItem(state)
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
    if (state.dont_consume) return
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

function createBrowserState() {
  return {
    activeView: 'conveyor',
    conveyor: {
      query: '', filter: 'all', sort: 'manual', size: 'medium', scrollTop: 0,
      focusedId: null, lastSelectedId: null, selected: new Set()
    },
    input: {
      query: '', folder: 'all', sort: 'name_asc', size: 'medium', scrollTop: 0,
      focusedId: null, lastSelectedId: null, files: [], selected: new Set(),
      loaded: false, loading: false, error: '', snapshotVersion: 0
    }
  }
}

function activeBrowser(ctx) {
  return ctx.browser[ctx.browser.activeView]
}

function compareNatural(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  })
}

function getViewItems(node) {
  const ctx = node.__bil
  const browser = activeBrowser(ctx)
  if (ctx.browser.activeView === 'input') {
    const query = browser.query.trim().toLocaleLowerCase()
    const items = browser.files.filter((entry) => {
      if (browser.folder !== 'all') {
        const folder = String(entry.subfolder || '')
        if (folder !== browser.folder && !folder.startsWith(`${browser.folder}/`)) return false
      }
      return !query || `${entry.filename} ${entry.relative_path}`.toLocaleLowerCase().includes(query)
    })
    switch (browser.sort) {
      case 'name_desc': items.sort((a, b) => compareNatural(b.relative_path, a.relative_path)); break
      case 'newest': items.sort((a, b) => (b.mtime_ns || 0) - (a.mtime_ns || 0) || compareNatural(a.relative_path, b.relative_path)); break
      case 'oldest': items.sort((a, b) => (a.mtime_ns || 0) - (b.mtime_ns || 0) || compareNatural(a.relative_path, b.relative_path)); break
      default: items.sort((a, b) => compareNatural(a.relative_path, b.relative_path)); break
    }
    return items
  }

  const { state, uiState } = getRenderableState(node)
  const query = browser.query.trim().toLocaleLowerCase()
  return state.items.filter((item) => {
    if (browser.filter !== 'all' && item.status !== browser.filter) return false
    if (!query) return true
    return `${item.filename} ${getItemDisplayPath(item, uiState)}`.toLocaleLowerCase().includes(query)
  })
}

function getGalleryMetrics(ctx) {
  const browser = activeBrowser(ctx)
  const definition = CARD_SIZES[browser.size] ?? CARD_SIZES.medium
  const width = Math.max(1, Math.floor(ctx.list.clientWidth || ctx.widgetWidth || MIN_NODE_WIDTH))
  return calculateGalleryMetrics(width, definition.minWidth, CARD_GAP)
}

function getVisibleCardRange(ctx, totalItems, metrics) {
  const range = calculateVisibleCardRange(
    totalItems,
    metrics.columns,
    metrics.rowStride,
    CARD_GAP,
    ctx.list.scrollTop,
    ctx.list.clientHeight,
    GALLERY_OVERSCAN_ROWS
  )
  if (range.scrollTop !== ctx.list.scrollTop) ctx.list.scrollTop = range.scrollTop
  return range
}

function canReorderConveyor(ctx) {
  const browser = ctx.browser.conveyor
  return ctx.browser.activeView === 'conveyor' && browser.filter === 'all' && !browser.query.trim()
}

function getViewSelectedIds(node) {
  const ctx = node.__bil
  return activeBrowser(ctx).selected
}

function renderSelectionContext(node) {
  const ctx = node.__bil
  if (!ctx) return
  const inputView = ctx.browser.activeView === 'input'
  const selected = getViewSelectedIds(node)
  ctx.contextBar.hidden = selected.size === 0
  ctx.contextLabel.textContent = `${selected.size} selected`
  ctx.setPendingBtn.hidden = inputView
  ctx.setProcessedBtn.hidden = inputView
  ctx.deleteSelectedBtn.hidden = inputView
  ctx.contextAddBtn.hidden = !inputView
}

function setItemSelected(node, itemId, checked, event = null) {
  const ctx = node.__bil
  const browser = activeBrowser(ctx)
  const items = ctx.visibleItems || []
  const itemIdentifier = ctx.browser.activeView === 'input'
    ? (item) => item.relative_path
    : (item) => item.id
  const selected = browser.selected
  if (event?.shiftKey && browser.lastSelectedId) {
    const anchor = items.findIndex((item) => itemIdentifier(item) === browser.lastSelectedId)
    const current = items.findIndex((item) => itemIdentifier(item) === itemId)
    if (anchor >= 0 && current >= 0) {
      for (let index = Math.min(anchor, current); index <= Math.max(anchor, current); index += 1) {
        selected.add(itemIdentifier(items[index]))
      }
    }
  } else if (checked) selected.add(itemId)
  else selected.delete(itemId)
  browser.lastSelectedId = itemId
  renderSelectionContext(node)
  scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
}

function createLightbox(node) {
  const lightbox = document.createElement('div')
  lightbox.className = 'bil-lightbox'
  lightbox.hidden = true
  lightbox.setAttribute('role', 'dialog')
  lightbox.setAttribute('aria-modal', 'true')
  lightbox.tabIndex = -1
  const image = document.createElement('img')
  const label = document.createElement('div')
  label.className = 'bil-lightbox-label'
  const close = document.createElement('button')
  close.className = 'bil-lightbox-close'
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', 'Close preview')
  lightbox.append(image, label, close)
  const hide = () => {
    lightbox.hidden = true
    image.removeAttribute('src')
    node.__bil?.root.focus({ preventScroll: true })
  }
  close.addEventListener('click', hide)
  lightbox.addEventListener('click', (event) => { if (event.target === lightbox) hide() })
  document.body.appendChild(lightbox)
  return { root: lightbox, image, label, close, hide }
}

function openPreview(node, item) {
  const ctx = node.__bil
  if (!ctx?.lightbox || !item) return
  const label = item.filename || item.relative_path || getItemDisplayPath(item)
  ctx.lightbox.image.src = filePreviewUrl(item)
  ctx.lightbox.image.alt = label
  ctx.lightbox.label.textContent = label
  ctx.lightbox.root.hidden = false
  ctx.lightbox.close.focus({ preventScroll: true })
}

function clearCardDragTargets(ctx, except = null) {
  for (const slot of ctx.cardPool) {
    if (slot.card !== except) slot.card.classList.remove('bil-drag-target')
  }
}

function createCardSlot(node, ctx) {
  const card = document.createElement('div')
  card.className = 'bil-card'
  card.style.display = 'none'
  const slot = { card, itemId: null, item: null, previewUrl: '', bindToken: 0, draggable: false }

  card.addEventListener('dragstart', (event) => {
    if (!slot.draggable || !slot.itemId) { event.preventDefault(); return }
    ctx.draggedId = slot.itemId
    event.dataTransfer?.setData('text/plain', slot.itemId)
    clearCardDragTargets(ctx)
  })
  card.addEventListener('dragend', () => { ctx.draggedId = null; clearCardDragTargets(ctx) })
  card.addEventListener('dragover', (event) => {
    if (!slot.draggable || !ctx.draggedId) return
    event.preventDefault(); clearCardDragTargets(ctx, card); card.classList.add('bil-drag-target')
  })
  card.addEventListener('dragleave', () => card.classList.remove('bil-drag-target'))
  card.addEventListener('drop', (event) => {
    if (!slot.draggable || !slot.itemId || !ctx.draggedId) return
    event.preventDefault(); clearCardDragTargets(ctx)
    const { state, uiState } = getRenderableState(node)
    if (moveItems(state, ctx.draggedId, slot.itemId)) updateState(node, state, uiState)
    ctx.draggedId = null
  })

  const media = document.createElement('div')
  media.className = 'bil-media'
  media.addEventListener('click', (event) => {
    if (!slot.itemId) return
    activeBrowser(ctx).focusedId = slot.itemId
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      const selected = getViewSelectedIds(node)
      setItemSelected(node, slot.itemId, !selected.has(slot.itemId), event)
    } else scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
  })
  media.addEventListener('dblclick', () => openPreview(node, slot.item))
  const thumb = document.createElement('img')
  thumb.className = 'bil-thumb'
  thumb.loading = 'lazy'
  thumb.decoding = 'async'
  thumb.draggable = false
  const overlay = document.createElement('div')
  overlay.className = 'bil-card-overlay'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.className = 'bil-card-check'
  checkbox.addEventListener('click', (event) => event.stopPropagation())
  checkbox.addEventListener('change', (event) => {
    if (slot.itemId) setItemSelected(node, slot.itemId, checkbox.checked, event)
  })
  const badge = document.createElement('span')
  badge.className = 'bil-badge'
  overlay.append(checkbox, badge)
  media.append(thumb, overlay)

  const footer = document.createElement('div')
  footer.className = 'bil-card-footer'
  const titleRow = document.createElement('div')
  titleRow.className = 'bil-card-title-row'
  const name = document.createElement('div')
  name.className = 'bil-name'
  const indexText = document.createElement('div')
  indexText.className = 'bil-index'
  titleRow.append(name, indexText)
  const actions = document.createElement('div')
  actions.className = 'bil-card-actions'
  const path = document.createElement('div')
  path.className = 'bil-path'
  const pendingBtn = document.createElement('button')
  pendingBtn.className = 'bil-mini-btn'; pendingBtn.type = 'button'; pendingBtn.textContent = '↶'
  const processedBtn = document.createElement('button')
  processedBtn.className = 'bil-mini-btn'; processedBtn.type = 'button'; processedBtn.textContent = '✓'
  const deleteBtn = document.createElement('button')
  deleteBtn.className = 'bil-mini-btn'; deleteBtn.type = 'button'; deleteBtn.textContent = '×'
  const addBtn = document.createElement('button')
  addBtn.className = 'bil-mini-btn'; addBtn.type = 'button'; addBtn.textContent = '+ Add'

  pendingBtn.addEventListener('click', () => {
    const { state, uiState } = getRenderableState(node)
    const item = state.items.find((entry) => entry.id === slot.itemId)
    if (item) { item.status = 'pending'; updateState(node, state, uiState) }
  })
  processedBtn.addEventListener('click', () => {
    const { state, uiState } = getRenderableState(node)
    const item = state.items.find((entry) => entry.id === slot.itemId)
    if (item) { item.status = 'processed'; item.last_processed_at = Date.now(); updateState(node, state, uiState) }
  })
  deleteBtn.addEventListener('click', () => {
    const { state, uiState } = getRenderableState(node)
    state.items = state.items.filter((entry) => entry.id !== slot.itemId)
    ctx.browser.conveyor.selected.delete(slot.itemId)
    uiState.selected_ids = uiState.selected_ids.filter((id) => id !== slot.itemId)
    delete uiState.source_paths[slot.itemId]
    updateState(node, state, uiState)
  })
  addBtn.addEventListener('click', () => { if (slot.item) addInputEntries(node, [slot.item]) })
  actions.append(path, pendingBtn, processedBtn, deleteBtn, addBtn)
  footer.append(titleRow, actions)
  card.append(media, footer)
  Object.assign(slot, { media, thumb, checkbox, badge, name, indexText, path, pendingBtn, processedBtn, deleteBtn, addBtn })
  return slot
}

function ensureCardPool(node, needed) {
  const ctx = node.__bil
  while (ctx.cardPool.length < needed) {
    const slot = createCardSlot(node, ctx)
    ctx.cardPool.push(slot)
    ctx.listWindow.appendChild(slot.card)
  }
}

function hideUnusedCards(ctx, start = 0) {
  for (let index = start; index < ctx.cardPool.length; index += 1) {
    const slot = ctx.cardPool[index]
    slot.itemId = null; slot.item = null; slot.previewUrl = ''; slot.bindToken += 1
    slot.card.style.display = 'none'
    slot.card.classList.remove('bil-selected', 'bil-focused', 'bil-drag-target')
    slot.thumb.removeAttribute('src')
  }
}

function updateCardSlot(node, slot, item, itemIndex, metrics, selected, annotatedCounts) {
  const ctx = node.__bil
  const inputView = ctx.browser.activeView === 'input'
  const itemId = inputView ? item.relative_path : item.id
  const { uiState } = getRenderableState(node)
  const displayPath = inputView ? item.relative_path : getItemDisplayPath(item, uiState)
  const label = item.filename || item.relative_path || displayPath
  const row = Math.floor(itemIndex / metrics.columns)
  const column = itemIndex % metrics.columns
  const left = column * (metrics.cardWidth + CARD_GAP)
  const top = row * metrics.rowStride
  const url = thumbnailUrl(item, activeBrowser(ctx).size)
  slot.itemId = itemId; slot.item = item
  slot.card.style.display = 'flex'
  slot.card.style.width = `${metrics.cardWidth}px`
  slot.card.style.height = `${metrics.cardHeight}px`
  slot.card.style.transform = `translate3d(${left}px, ${top}px, 0)`
  slot.card.classList.toggle('bil-selected', selected.has(itemId))
  slot.card.classList.toggle('bil-focused', activeBrowser(ctx).focusedId === itemId)
  slot.checkbox.checked = selected.has(itemId)
  slot.checkbox.setAttribute('aria-label', `Select ${label}`)
  slot.card.title = displayPath
  slot.name.textContent = label
  slot.indexText.textContent = `#${itemIndex + 1}`
  slot.path.textContent = inputView ? (item.subfolder || 'input root') : displayPath
  slot.path.title = slot.path.textContent
  slot.draggable = !inputView && canReorderConveyor(ctx)
  slot.card.draggable = slot.draggable
  slot.pendingBtn.hidden = inputView
  slot.processedBtn.hidden = inputView
  slot.deleteBtn.hidden = inputView
  slot.addBtn.hidden = !inputView
  if (inputView) {
    const count = annotatedCounts.get(item.relative_path) || 0
    slot.badge.className = 'bil-badge bil-count-badge'
    slot.badge.textContent = count ? `In conveyor ×${count}` : 'Input'
  } else {
    slot.badge.className = `bil-badge bil-badge-${item.status}`
    slot.badge.textContent = item.status
  }
  slot.thumb.alt = label
  if (slot.previewUrl !== url) {
    const token = ++slot.bindToken
    slot.thumb.classList.remove('bil-thumb-error')
    slot.thumb.onload = () => {
      if (token !== slot.bindToken) return
      slot.thumb.classList.remove('bil-thumb-error')
    }
    slot.thumb.onerror = () => {
      if (token !== slot.bindToken) return
      slot.thumb.classList.add('bil-thumb-error')
    }
    slot.thumb.src = url
    slot.previewUrl = url
  }
}

function renderVisibleCards(node) {
  const ctx = node.__bil
  if (!ctx) return
  const items = ctx.visibleItems || []
  if (!items.length) {
    ctx.listInner.style.height = 'auto'; ctx.listWindow.style.height = 'auto'
    hideUnusedCards(ctx); ctx.renderedRangeKey = ''; return
  }
  const metrics = getGalleryMetrics(ctx)
  ctx.lastMetrics = metrics
  const range = getVisibleCardRange(ctx, items.length, metrics)
  const view = ctx.browser.activeView
  const selected = getViewSelectedIds(node)
  const { state } = getRenderableState(node)
  let annotatedCounts = new Map()
  if (view === 'input') {
    if (ctx.annotatedCountsRevision !== ctx.queueRevision) {
      ctx.annotatedCounts = new Map()
      for (const item of state.items) {
        const path = getInputRelativePath(item)
        if (path) ctx.annotatedCounts.set(path, (ctx.annotatedCounts.get(path) || 0) + 1)
      }
      ctx.annotatedCountsRevision = ctx.queueRevision
    }
    annotatedCounts = ctx.annotatedCounts
  }
  const key = `${ctx.renderVersion}:${ctx.inputVersion}:${view}:${items.length}:${metrics.width}:${metrics.columns}:${metrics.cardHeight}:${range.start}:${range.end}`
  if (ctx.renderedRangeKey === key) return
  ctx.listInner.style.height = `${range.totalHeight}px`
  ctx.listWindow.style.height = `${range.totalHeight}px`
  const needed = range.end - range.start
  ensureCardPool(node, needed)
  for (let offset = 0; offset < needed; offset += 1) {
    updateCardSlot(node, ctx.cardPool[offset], items[range.start + offset], range.start + offset, metrics, selected, annotatedCounts)
  }
  hideUnusedCards(ctx, needed)
  ctx.renderedRangeKey = key
}

function updateFolderOptions(ctx) {
  const select = ctx.folderSelect
  const previous = ctx.browser.input.folder
  const folders = new Set()
  for (const entry of ctx.browser.input.files) {
    const folder = String(entry.subfolder || '')
    if (!folder) continue
    const segments = folder.split('/')
    for (let index = 1; index <= segments.length; index += 1) folders.add(segments.slice(0, index).join('/'))
  }
  select.replaceChildren()
  const all = document.createElement('option'); all.value = 'all'; all.textContent = 'All folders'; select.appendChild(all)
  for (const folder of Array.from(folders).sort(compareNatural)) {
    const option = document.createElement('option'); option.value = folder; option.textContent = folder; select.appendChild(option)
  }
  ctx.browser.input.folder = folders.has(previous) ? previous : 'all'
  select.value = ctx.browser.input.folder
}

function renderGalleryNode(node) {
  const ctx = node.__bil
  if (!ctx) return
  const snapshot = getCurrentState(node)
  cacheRenderableState(node, snapshot.state, snapshot.uiState)
  const { state, uiState } = snapshot
  const validQueueIds = new Set(state.items.map((item) => item.id))
  ctx.browser.conveyor.selected = new Set(
    Array.from(ctx.browser.conveyor.selected).filter((id) => validQueueIds.has(id))
  )
  ctx.visibleItems = getViewItems(node)
  const inputView = ctx.browser.activeView === 'input'
  const browser = activeBrowser(ctx)
  const pending = countItemsByStatus(state, 'pending')
  const queued = countItemsByStatus(state, 'queued')
  const processed = countItemsByStatus(state, 'processed')
  const next = state.dont_consume ? findNextLoadItem(state) : findFirstByStatus(state, ['pending', 'queued'])

  ctx.conveyorTab.textContent = `Conveyor ${state.items.length}`
  ctx.inputTab.textContent = `Input Folder ${ctx.browser.input.files.length}`
  ctx.conveyorTab.setAttribute('aria-selected', String(!inputView))
  ctx.inputTab.setAttribute('aria-selected', String(inputView))
  ctx.list.setAttribute('aria-labelledby', inputView ? ctx.inputTab.id : ctx.conveyorTab.id)
  if (document.activeElement !== ctx.searchInput) ctx.searchInput.value = browser.query
  ctx.sizeSelect.value = browser.size
  ctx.conveyorFilter.hidden = inputView
  ctx.folderSelect.hidden = !inputView
  ctx.conveyorSort.hidden = inputView
  ctx.inputSort.hidden = !inputView
  ctx.applySortBtn.hidden = inputView
  ctx.refreshBtn.hidden = !inputView
  ctx.addSelectedInputBtn.hidden = !inputView
  ctx.conveyorFilter.value = ctx.browser.conveyor.filter
  ctx.folderSelect.value = ctx.browser.input.folder
  ctx.conveyorSort.value = ctx.browser.conveyor.sort
  ctx.inputSort.value = ctx.browser.input.sort
  ctx.summary.textContent = inputView
    ? `${ctx.visibleItems.length} shown · ${ctx.browser.input.files.length} images${ctx.browser.input.loading ? ' · refreshing…' : ''}${ctx.browser.input.error ? ` · ${ctx.browser.input.error}` : ''}`
    : `${state.items.length} total · ${pending} pending · ${queued} queued · ${processed} processed`
  const focusedIndex = browser.focusedId
    ? ctx.visibleItems.findIndex((item) => (inputView ? item.relative_path : item.id) === browser.focusedId)
    : -1
  const position = focusedIndex >= 0 ? `${focusedIndex + 1} of ${ctx.visibleItems.length}` : ''
  ctx.nextText.textContent = inputView
    ? position
    : `${next ? `Next: ${next.filename || getItemDisplayPath(next, uiState)}${state.dont_consume ? ' · not consuming' : ''}` : 'Next: none'}${position ? ` · ${position}` : ''}`
  renderSelectionContext(node)
  ctx.autoQueueCheckbox.checked = Boolean(state.auto_queue)
  ctx.dontConsumeCheckbox.checked = Boolean(state.dont_consume)
  ctx.canvasDropCheckbox.checked = Boolean(state.catch_canvas_drops)

  if (!ctx.visibleItems.length) {
    hideUnusedCards(ctx); ctx.renderedRangeKey = ''
    ctx.listInner.style.height = 'auto'; ctx.listWindow.style.height = 'auto'
    if (ctx.list.scrollTop) ctx.list.scrollTop = 0
    if (!ctx.empty) { ctx.empty = document.createElement('div'); ctx.empty.className = 'bil-empty' }
    ctx.empty.textContent = inputView
      ? (ctx.browser.input.loading ? 'Loading the ComfyUI input folder…' : 'No images match this input-folder view.')
      : 'Drop images or folders here, click Add images, or browse the Input Folder tab.'
    if (ctx.empty.parentElement !== ctx.listWindow) ctx.listWindow.appendChild(ctx.empty)
  } else {
    ctx.empty?.remove()
    renderVisibleCards(node)
  }
}

async function refreshInputFiles(node, { force = false } = {}) {
  const ctx = node.__bil
  if (!ctx) return
  ctx.inputRequestId += 1
  const requestId = ctx.inputRequestId
  ctx.inputAbortController?.abort()
  const controller = new AbortController()
  ctx.inputAbortController = controller
  ctx.browser.input.loading = true
  ctx.browser.input.error = ''
  scheduleRenderNode(node)
  try {
    const suffix = force ? '?refresh=1' : ''
    const response = await api.fetchApi(`/image-conveyor/input-files${suffix}`, { signal: controller.signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const payload = await response.json()
    if (requestId !== ctx.inputRequestId || node.__bil !== ctx || ctx.removed) return
    const files = Array.isArray(payload?.files) ? payload.files.filter((entry) => entry?.relative_path && entry?.filename) : []
    ctx.browser.input.files = files
    ctx.browser.input.loaded = true
    ctx.browser.input.snapshotVersion = Number(payload?.snapshot_version || 0)
    const availablePaths = new Set(files.map((entry) => entry.relative_path))
    ctx.browser.input.selected = new Set(Array.from(ctx.browser.input.selected).filter((path) => availablePaths.has(path)))
    ctx.inputVersion += 1
    updateFolderOptions(ctx)
  } catch (error) {
    if (error?.name !== 'AbortError' && requestId === ctx.inputRequestId) {
      ctx.browser.input.error = 'Refresh failed'
      console.error('Image Conveyor: failed to load the input folder.', error)
    }
  } finally {
    if (requestId === ctx.inputRequestId && node.__bil === ctx && !ctx.removed) {
      ctx.browser.input.loading = false
      scheduleRenderNode(node)
    }
  }
}

function addInputEntries(node, entries) {
  if (!entries.length) return
  const { state, uiState } = getRenderableState(node)
  for (const entry of entries) {
    const item = makeItemFromInputFile(entry)
    if (!item) continue
    state.items.push(item)
    uiState.source_paths[item.id] = entry.relative_path
  }
  updateState(node, state, uiState)
}

function addSelectedInputEntries(node) {
  const ctx = node.__bil
  const selected = ctx.browser.input.selected
  addInputEntries(node, ctx.browser.input.files.filter((entry) => selected.has(entry.relative_path)))
}

function switchBrowserView(node, view) {
  const ctx = node.__bil
  if (!ctx || ctx.browser.activeView === view) return
  activeBrowser(ctx).scrollTop = ctx.list.scrollTop
  ctx.browser.activeView = view
  ctx.renderedRangeKey = ''
  ctx.list.scrollTop = activeBrowser(ctx).scrollTop
  scheduleRenderNode(node, { forceVisibleRows: true })
  requestAnimationFrame(() => { if (node.__bil) ctx.list.scrollTop = activeBrowser(ctx).scrollTop })
  if (view === 'input' && !ctx.browser.input.loaded && !ctx.browser.input.loading) void refreshInputFiles(node)
}

function scrollItemIntoView(node, index) {
  const ctx = node.__bil
  const metrics = getGalleryMetrics(ctx)
  const row = Math.floor(index / metrics.columns)
  const top = row * metrics.rowStride
  const bottom = top + metrics.cardHeight
  if (top < ctx.list.scrollTop) ctx.list.scrollTop = top
  else if (bottom > ctx.list.scrollTop + ctx.list.clientHeight) ctx.list.scrollTop = bottom - ctx.list.clientHeight
}

function isTextControl(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable
}

function handleGalleryKeyDown(node, event) {
  const ctx = node.__bil
  if (!ctx || isTextControl(event.target)) return
  if (event.key === 'Escape' && !ctx.lightbox.root.hidden) { event.preventDefault(); ctx.lightbox.hide(); return }
  const items = ctx.visibleItems || []
  if (!items.length) return
  const browser = activeBrowser(ctx)
  const itemId = (item) => ctx.browser.activeView === 'input' ? item.relative_path : item.id
  let index = items.findIndex((item) => itemId(item) === browser.focusedId)
  if (index < 0) index = 0
  const metrics = getGalleryMetrics(ctx)
  const page = Math.max(metrics.columns, Math.floor(ctx.list.clientHeight / metrics.rowStride) * metrics.columns)
  let next = index
  switch (event.key) {
    case 'ArrowLeft': next -= 1; break
    case 'ArrowRight': next += 1; break
    case 'ArrowUp': next -= metrics.columns; break
    case 'ArrowDown': next += metrics.columns; break
    case 'Home': next = 0; break
    case 'End': next = items.length - 1; break
    case 'PageUp': next -= page; break
    case 'PageDown': next += page; break
    case 'Enter': event.preventDefault(); openPreview(node, items[index]); return
    case ' ': {
      event.preventDefault()
      const id = itemId(items[index]); const selected = getViewSelectedIds(node)
      setItemSelected(node, id, !selected.has(id), event); return
    }
    default: return
  }
  event.preventDefault()
  next = Math.max(0, Math.min(items.length - 1, next))
  browser.focusedId = itemId(items[next])
  scrollItemIntoView(node, next)
  scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
}

function buildGalleryDom(node) {
  ensureStyles()
  const root = document.createElement('div')
  root.className = 'bil-root'
  root.tabIndex = 0
  root.setAttribute('aria-label', 'Image Conveyor browser')

  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'image/*,.png,.jpg,.jpeg,.webp,.bmp,.gif,.tif,.tiff,.avif'
  fileInput.multiple = true
  fileInput.hidden = true

  const header = document.createElement('div')
  header.className = 'bil-header'
  const tabs = document.createElement('div')
  tabs.className = 'bil-tabs'
  tabs.setAttribute('role', 'tablist')
  const conveyorTab = document.createElement('button')
  conveyorTab.className = 'bil-tab'; conveyorTab.type = 'button'; conveyorTab.setAttribute('role', 'tab')
  const inputTab = document.createElement('button')
  inputTab.className = 'bil-tab'; inputTab.type = 'button'; inputTab.setAttribute('role', 'tab')
  const tabSetId = makeId()
  conveyorTab.id = `${tabSetId}-conveyor-tab`
  inputTab.id = `${tabSetId}-input-tab`
  tabs.append(conveyorTab, inputTab)
  const addImagesBtn = document.createElement('button')
  addImagesBtn.className = 'bil-btn bil-add-btn'; addImagesBtn.type = 'button'; addImagesBtn.textContent = '+ Add images'
  header.append(tabs, addImagesBtn)

  const browserbar = document.createElement('div')
  browserbar.className = 'bil-browserbar'
  const searchInput = document.createElement('input')
  searchInput.className = 'bil-input'; searchInput.type = 'search'; searchInput.placeholder = 'Search images…'
  const conveyorFilter = document.createElement('select')
  conveyorFilter.className = 'bil-select'
  ;[['all', 'All'], ['pending', 'Pending'], ['queued', 'Queued'], ['processed', 'Processed']].forEach(([value, label]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = label; conveyorFilter.appendChild(option)
  })
  const folderSelect = document.createElement('select')
  folderSelect.className = 'bil-select'; folderSelect.hidden = true
  const conveyorSort = document.createElement('select')
  conveyorSort.className = 'bil-select'
  ;[
    ['manual', 'Manual order'], ['name_asc', 'Name ↑'], ['name_desc', 'Name ↓'],
    ['added_newest', 'Newest'], ['added_oldest', 'Oldest'], ['status', 'Status']
  ].forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; conveyorSort.appendChild(option) })
  const inputSort = document.createElement('select')
  inputSort.className = 'bil-select'; inputSort.hidden = true
  ;[['name_asc', 'Name ↑'], ['name_desc', 'Name ↓'], ['newest', 'Newest'], ['oldest', 'Oldest']].forEach(([value, label]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = label; inputSort.appendChild(option)
  })
  const sizeSelect = document.createElement('select')
  sizeSelect.className = 'bil-select bil-size-select'
  ;[['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']].forEach(([value, label]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = label; sizeSelect.appendChild(option)
  })
  browserbar.append(searchInput, conveyorFilter, folderSelect, conveyorSort, inputSort, sizeSelect)

  const secondary = document.createElement('div')
  secondary.className = 'bil-header'
  const applySortBtn = document.createElement('button')
  applySortBtn.className = 'bil-btn'; applySortBtn.type = 'button'; applySortBtn.textContent = 'Apply queue sort'
  const refreshBtn = document.createElement('button')
  refreshBtn.className = 'bil-btn'; refreshBtn.type = 'button'; refreshBtn.textContent = 'Refresh'; refreshBtn.hidden = true
  const addSelectedInputBtn = document.createElement('button')
  addSelectedInputBtn.className = 'bil-btn'; addSelectedInputBtn.type = 'button'; addSelectedInputBtn.textContent = 'Add selected'; addSelectedInputBtn.hidden = true
  secondary.append(applySortBtn, refreshBtn, addSelectedInputBtn)

  const summaryRow = document.createElement('div')
  summaryRow.className = 'bil-summary'
  const summary = document.createElement('div')
  const nextText = document.createElement('div')
  summaryRow.append(summary, nextText)

  const contextBar = document.createElement('div')
  contextBar.className = 'bil-contextbar'; contextBar.hidden = true
  const contextLabel = document.createElement('span'); contextLabel.className = 'bil-context-label'
  const setPendingBtn = document.createElement('button'); setPendingBtn.className = 'bil-btn'; setPendingBtn.type = 'button'; setPendingBtn.textContent = 'Pending'
  const setProcessedBtn = document.createElement('button'); setProcessedBtn.className = 'bil-btn'; setProcessedBtn.type = 'button'; setProcessedBtn.textContent = 'Done'
  const deleteSelectedBtn = document.createElement('button'); deleteSelectedBtn.className = 'bil-btn'; deleteSelectedBtn.type = 'button'; deleteSelectedBtn.textContent = 'Delete'
  const contextAddBtn = document.createElement('button'); contextAddBtn.className = 'bil-btn'; contextAddBtn.type = 'button'; contextAddBtn.textContent = 'Add to Conveyor'
  const clearSelectionBtn = document.createElement('button'); clearSelectionBtn.className = 'bil-btn'; clearSelectionBtn.type = 'button'; clearSelectionBtn.textContent = 'Clear'
  contextBar.append(contextLabel, setPendingBtn, setProcessedBtn, deleteSelectedBtn, contextAddBtn, clearSelectionBtn)

  const settings = document.createElement('details')
  settings.className = 'bil-settings'
  const settingsSummary = document.createElement('summary'); settingsSummary.textContent = 'Queue options and bulk tools'
  const settingsRow = document.createElement('div'); settingsRow.className = 'bil-settings-row'
  const makeToggle = (labelText, ariaLabel) => {
    const label = document.createElement('label'); label.className = 'bil-toggle'
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', ariaLabel)
    const text = document.createElement('span'); text.textContent = labelText
    label.append(checkbox, text); return { label, checkbox }
  }
  const autoQueue = makeToggle('Auto queue all pending', 'Auto queue all pending images')
  const dontConsume = makeToggle("Don't consume", 'Do not consume images')
  const canvasDrop = makeToggle('Catch canvas drops', 'Catch image drops anywhere on the canvas')
  const selectVisibleBtn = document.createElement('button'); selectVisibleBtn.className = 'bil-btn'; selectVisibleBtn.type = 'button'; selectVisibleBtn.textContent = 'Select all'
  const clearQueuedBtn = document.createElement('button'); clearQueuedBtn.className = 'bil-btn'; clearQueuedBtn.type = 'button'; clearQueuedBtn.textContent = 'Clear queued'
  const clearProcessedBtn = document.createElement('button'); clearProcessedBtn.className = 'bil-btn'; clearProcessedBtn.type = 'button'; clearProcessedBtn.textContent = 'Remove processed'
  const jumpPendingBtn = document.createElement('button'); jumpPendingBtn.className = 'bil-btn'; jumpPendingBtn.type = 'button'; jumpPendingBtn.textContent = 'Jump to next pending'
  settingsRow.append(autoQueue.label, dontConsume.label, canvasDrop.label, selectVisibleBtn, clearQueuedBtn, clearProcessedBtn, jumpPendingBtn)
  settings.append(settingsSummary, settingsRow)

  const list = document.createElement('div')
  list.className = 'bil-list'; list.tabIndex = 0
  list.id = `${tabSetId}-panel`
  list.setAttribute('role', 'tabpanel')
  list.setAttribute('aria-labelledby', conveyorTab.id)
  conveyorTab.setAttribute('aria-controls', list.id)
  inputTab.setAttribute('aria-controls', list.id)
  const listInner = document.createElement('div'); listInner.className = 'bil-list-inner'
  const listWindow = document.createElement('div'); listWindow.className = 'bil-list-window'
  listInner.appendChild(listWindow); list.appendChild(listInner)
  root.append(fileInput, header, browserbar, secondary, summaryRow, contextBar, settings, list)

  node.__bil = {
    root, dropzone: addImagesBtn, addImagesBtn, fileInput, conveyorTab, inputTab,
    searchInput, conveyorFilter, folderSelect, conveyorSort, inputSort, sizeSelect,
    applySortBtn, refreshBtn, addSelectedInputBtn, summary, nextText, contextBar,
    contextLabel, setPendingBtn, setProcessedBtn, deleteSelectedBtn, contextAddBtn,
    autoQueueCheckbox: autoQueue.checkbox, dontConsumeCheckbox: dontConsume.checkbox,
    canvasDropCheckbox: canvasDrop.checkbox, list, listInner, listWindow,
    browser: createBrowserState(), visibleItems: [], cardPool: [],
    draggedId: null, empty: null, state: null, uiState: null, renderVersion: 0,
    inputVersion: 0, renderedRangeKey: '', renderFrame: 0, renderViewportOnly: false,
    listResizeObserver: null, widgetOuterHeight: 0, widgetInnerHeight: 0, widgetWidth: 0,
    pointerInside: false, middlePanPointerId: null, documentPasteHandler: null,
    documentMiddlePanMoveHandler: null, documentMiddlePanEndHandler: null,
    documentKeyHandler: null, inputAbortController: null, inputRequestId: 0,
    searchTimer: 0, lightbox: null, lastMetrics: null, removed: false,
    uploadDepth: 0, dropzoneLabel: '',
    queueRevision: 0, annotatedCountsRevision: -1, annotatedCounts: new Map()
  }
  const ctx = node.__bil
  ctx.lightbox = createLightbox(node)
  updateFolderOptions(ctx)

  const runUpload = (files) => {
    void uploadViaNode(node, files).catch((error) => {
      console.error('Image Conveyor: import failed.', error)
      ctx.browser.input.error = error?.message || 'Import failed'
      scheduleRenderNode(node)
    })
  }
  addImagesBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => { runUpload(fileInput.files); fileInput.value = '' })
  conveyorTab.addEventListener('click', () => switchBrowserView(node, 'conveyor'))
  inputTab.addEventListener('click', () => switchBrowserView(node, 'input'))
  refreshBtn.addEventListener('click', () => void refreshInputFiles(node, { force: true }))
  addSelectedInputBtn.addEventListener('click', () => addSelectedInputEntries(node))
  contextAddBtn.addEventListener('click', () => addSelectedInputEntries(node))

  searchInput.addEventListener('input', () => {
    clearTimeout(ctx.searchTimer)
    const targetView = ctx.browser.activeView
    const query = searchInput.value
    ctx.searchTimer = setTimeout(() => {
      ctx.browser[targetView].query = query
      ctx.browser[targetView].scrollTop = 0
      if (ctx.browser.activeView === targetView) list.scrollTop = 0
      scheduleRenderNode(node)
    }, 70)
  })
  conveyorFilter.addEventListener('change', () => { ctx.browser.conveyor.filter = conveyorFilter.value; list.scrollTop = 0; scheduleRenderNode(node) })
  folderSelect.addEventListener('change', () => { ctx.browser.input.folder = folderSelect.value; list.scrollTop = 0; scheduleRenderNode(node) })
  inputSort.addEventListener('change', () => { ctx.browser.input.sort = inputSort.value; scheduleRenderNode(node) })
  conveyorSort.addEventListener('change', () => { ctx.browser.conveyor.sort = conveyorSort.value })
  sizeSelect.addEventListener('change', () => {
    const items = ctx.visibleItems || []
    const previous = getGalleryMetrics(ctx)
    const anchorIndex = Math.min(items.length - 1, Math.max(0, Math.floor(list.scrollTop / previous.rowStride) * previous.columns))
    const anchorId = items[anchorIndex] ? (ctx.browser.activeView === 'input' ? items[anchorIndex].relative_path : items[anchorIndex].id) : null
    activeBrowser(ctx).size = sizeSelect.value
    ctx.renderedRangeKey = ''
    scheduleRenderNode(node, { forceVisibleRows: true })
    requestAnimationFrame(() => {
      if (!anchorId || !node.__bil) return
      const newIndex = (ctx.visibleItems || []).findIndex((item) => (ctx.browser.activeView === 'input' ? item.relative_path : item.id) === anchorId)
      if (newIndex >= 0) { const metrics = getGalleryMetrics(ctx); list.scrollTop = Math.floor(newIndex / metrics.columns) * metrics.rowStride }
    })
  })

  applySortBtn.addEventListener('click', () => {
    const { state, uiState } = getRenderableState(node)
    switch (conveyorSort.value) {
      case 'name_asc': state.items.sort((a, b) => compareNatural(getItemDisplayPath(a, uiState), getItemDisplayPath(b, uiState))); break
      case 'name_desc': state.items.sort((a, b) => compareNatural(getItemDisplayPath(b, uiState), getItemDisplayPath(a, uiState))); break
      case 'added_newest': state.items.sort((a, b) => (b.added_at || 0) - (a.added_at || 0)); break
      case 'added_oldest': state.items.sort((a, b) => (a.added_at || 0) - (b.added_at || 0)); break
      case 'status': state.items.sort((a, b) => itemStatusRank(a.status) - itemStatusRank(b.status) || (a.added_at || 0) - (b.added_at || 0)); break
      default: break
    }
    ctx.browser.conveyor.sort = 'manual'; conveyorSort.value = 'manual'; updateState(node, state, uiState)
  })

  const mutateSelected = (status) => {
    const { state, uiState } = getRenderableState(node); const selected = ctx.browser.conveyor.selected; const now = Date.now()
    for (const item of state.items) if (selected.has(item.id)) { item.status = status; if (status === 'processed') item.last_processed_at = now }
    updateState(node, state, uiState)
  }
  setPendingBtn.addEventListener('click', () => mutateSelected('pending'))
  setProcessedBtn.addEventListener('click', () => mutateSelected('processed'))
  deleteSelectedBtn.addEventListener('click', () => {
    const { state, uiState } = getRenderableState(node); const selected = ctx.browser.conveyor.selected
    state.items = state.items.filter((item) => !selected.has(item.id)); uiState.selected_ids = []
    ctx.browser.conveyor.selected.clear()
    uiState.source_paths = Object.fromEntries(Object.entries(uiState.source_paths).filter(([id]) => !selected.has(id)))
    updateState(node, state, uiState)
  })
  clearSelectionBtn.addEventListener('click', () => {
    if (ctx.browser.activeView === 'input') {
      ctx.browser.input.selected.clear(); renderSelectionContext(node); scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
    } else {
      ctx.browser.conveyor.selected.clear(); renderSelectionContext(node); scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
    }
  })
  selectVisibleBtn.addEventListener('click', () => {
    if (ctx.browser.activeView === 'input') {
      ctx.browser.input.selected = new Set(ctx.browser.input.files.map((item) => item.relative_path)); renderSelectionContext(node); scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
    } else {
      const { state } = getRenderableState(node); ctx.browser.conveyor.selected = new Set(state.items.map((item) => item.id)); renderSelectionContext(node); scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
    }
  })
  autoQueue.checkbox.addEventListener('change', () => { const { state, uiState } = getRenderableState(node); state.auto_queue = autoQueue.checkbox.checked; updateState(node, state, uiState) })
  dontConsume.checkbox.addEventListener('change', () => { const { state, uiState } = getRenderableState(node); state.dont_consume = dontConsume.checkbox.checked; updateState(node, state, uiState) })
  canvasDrop.checkbox.addEventListener('change', () => { const { state, uiState } = getRenderableState(node); state.catch_canvas_drops = canvasDrop.checkbox.checked; updateState(node, state, uiState) })
  clearQueuedBtn.addEventListener('click', () => { const { state, uiState } = getRenderableState(node); for (const item of state.items) if (item.status === 'queued') item.status = 'pending'; updateState(node, state, uiState) })
  clearProcessedBtn.addEventListener('click', () => {
    const { state, uiState } = getRenderableState(node); const kept = state.items.filter((item) => item.status !== 'processed'); const ids = new Set(kept.map((item) => item.id)); state.items = kept
    uiState.selected_ids = uiState.selected_ids.filter((id) => ids.has(id)); uiState.source_paths = Object.fromEntries(Object.entries(uiState.source_paths).filter(([id]) => ids.has(id))); updateState(node, state, uiState)
  })
  jumpPendingBtn.addEventListener('click', () => {
    if (ctx.browser.activeView !== 'conveyor') {
      activeBrowser(ctx).scrollTop = list.scrollTop
      ctx.browser.activeView = 'conveyor'
    }
    ctx.browser.conveyor.query = ''
    ctx.browser.conveyor.filter = 'all'
    ctx.visibleItems = getViewItems(node)
    const index = ctx.visibleItems.findIndex((item) => item.status === 'pending')
    if (index >= 0) {
      ctx.browser.conveyor.focusedId = ctx.visibleItems[index].id
      scrollItemIntoView(node, index)
    }
    scheduleRenderNode(node, { forceVisibleRows: true })
  })

  list.addEventListener('scroll', () => { activeBrowser(ctx).scrollTop = list.scrollTop; scheduleRenderNode(node, { viewportOnly: true }) }, { passive: true })
  root.addEventListener('keydown', (event) => handleGalleryKeyDown(node, event))
  ctx.documentKeyHandler = (event) => { if (event.key === 'Escape' && !ctx.lightbox.root.hidden) { event.preventDefault(); ctx.lightbox.hide() } }
  document.addEventListener('keydown', ctx.documentKeyHandler, true)

  if (typeof ResizeObserver === 'function') {
    ctx.listResizeObserver = new ResizeObserver(() => {
      const previous = ctx.lastMetrics
      const items = ctx.visibleItems || []
      const anchorIndex = previous
        ? Math.min(items.length - 1, Math.max(0, Math.floor(list.scrollTop / previous.rowStride) * previous.columns))
        : -1
      const anchorId = anchorIndex >= 0
        ? (ctx.browser.activeView === 'input' ? items[anchorIndex].relative_path : items[anchorIndex].id)
        : null
      ctx.renderedRangeKey = ''
      scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
      if (anchorId && previous && previous.width !== Math.floor(list.clientWidth || 0)) {
        requestAnimationFrame(() => {
          if (ctx.removed) return
          const index = (ctx.visibleItems || []).findIndex((item) => (ctx.browser.activeView === 'input' ? item.relative_path : item.id) === anchorId)
          if (index >= 0) {
            const metrics = getGalleryMetrics(ctx)
            list.scrollTop = Math.floor(index / metrics.columns) * metrics.rowStride
          }
        })
      }
    })
    ctx.listResizeObserver.observe(list)
  }

  root.addEventListener('pointerenter', () => { ctx.pointerInside = true })
  root.addEventListener('pointerleave', () => { ctx.pointerInside = false })
  root.addEventListener('pointerdown', (event) => {
    if (event.button === 1) { if (!app.canvas) return; ctx.middlePanPointerId = event.pointerId; event.preventDefault(); app.canvas.processMouseDown(event); return }
    if (!isTextControl(event.target)) root.focus({ preventScroll: true })
  }, true)
  root.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault() }, true)
  root.addEventListener('auxclick', (event) => { if (event.button === 1) event.preventDefault() }, true)
  ctx.documentMiddlePanMoveHandler = (event) => {
    if (!app.canvas || ctx.middlePanPointerId == null || event.pointerId !== ctx.middlePanPointerId) return
    if ((event.buttons & 4) !== 4) { app.canvas.processMouseUp(event); ctx.middlePanPointerId = null; return }
    event.preventDefault(); app.canvas.processMouseMove(event)
  }
  ctx.documentMiddlePanEndHandler = (event) => {
    if (!app.canvas || ctx.middlePanPointerId == null || event.pointerId !== ctx.middlePanPointerId) return
    app.canvas.processMouseUp(event); ctx.middlePanPointerId = null
  }
  document.addEventListener('pointermove', ctx.documentMiddlePanMoveHandler, true)
  document.addEventListener('pointerup', ctx.documentMiddlePanEndHandler, true)
  document.addEventListener('pointercancel', ctx.documentMiddlePanEndHandler, true)

  ctx.documentPasteHandler = (event) => {
    if (event.defaultPrevented || isModifiedPlainTextPaste(event) || shouldIgnoreClipboardPasteTarget(event.target)) return
    if (!(ctx.pointerInside || root === document.activeElement || root.contains(document.activeElement))) return
    const files = getClipboardImageFiles(event); if (!files.length) return
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.(); runUpload(files)
  }
  document.addEventListener('paste', ctx.documentPasteHandler, true)

  let externalDragDepth = 0
  const setDragActive = (active) => { root.classList.toggle('bil-dragover', active); if (!active) clearCardDragTargets(ctx) }
  root.addEventListener('dragenter', (event) => { if (!consumeExternalFileDrag(event) && !activatePotentialExternalFileDrag(event)) return; externalDragDepth += 1; setDragActive(true) }, true)
  root.addEventListener('dragover', (event) => { if (!consumeExternalFileDrag(event) && !activatePotentialExternalFileDrag(event)) return; setDragActive(true) }, true)
  root.addEventListener('dragleave', (event) => { if (!(externalDragDepth > 0 || hasExternalFileDrag(event))) return; event.preventDefault(); event.stopPropagation(); externalDragDepth = Math.max(0, externalDragDepth - 1); if (!externalDragDepth) setDragActive(false) }, true)
  root.addEventListener('drop', async (event) => {
    if (!consumeExternalFileDrag(event)) { externalDragDepth = 0; setDragActive(false); return }
    const files = await getDroppedImageFiles(event); externalDragDepth = 0; setDragActive(false); if (files.length) runUpload(files)
  }, true)
  root.addEventListener('dragend', () => { externalDragDepth = 0; setDragActive(false) }, true)

  return root
}

/**
 * Uploads the provided files through the node's upload pipeline and appends any created items to the node's state.
 *
 * The node's UI state (`uiState.source_paths`) is updated with normalized source paths for uploaded items, and the node
 * state is written back so the widget reflects the new items.
 *
 * @param {object} node - The ComfyUI node instance that hosts the batch image loader widget.
 * @param {FileList|File[]|Array<{file: File, relativeSubfolder?: string}>} files - Files or normalized file entries to upload.
 * @returns {boolean} `true` if one or more files were uploaded and applied to the node state, `false` if the node widget context is missing or no valid image files were provided.
 */
async function uploadViaNode(node, files) {
  const ctx = node.__bil
  if (!ctx) return false
  const validFiles = normalizeUploadFiles(files)
  if (!validFiles.length) return false

  ctx.uploadDepth += 1
  if (ctx.uploadDepth === 1) ctx.dropzoneLabel = ctx.dropzone.textContent || '+ Add images'
  ctx.dropzone.disabled = true
  ctx.dropzone.textContent = `Importing ${validFiles.length}…`
  try {
    const { uploaded, errors } = await uploadFiles(validFiles)
    if (node.__bil !== ctx || ctx.removed) return false
    if (!uploaded.length && errors.length) {
      throw new Error(errors.length === 1 ? errors[0].error.message : `${errors.length} images failed to import.`)
    }
    const { state, uiState } = getRenderableState(node)
    const inputPosition = ctx.browser?.input?.loaded
      ? new Map(ctx.browser.input.files.map((entry, index) => [entry.relative_path, index]))
      : null
    for (const entry of uploaded) {
      const item = makeItemFromUploadResponse(entry)
      if (!item) continue
      state.items.push(item)
      const runtimeSourcePath = normalizeSourcePath(entry?.source_path)
      if (runtimeSourcePath) uiState.source_paths[item.id] = runtimeSourcePath
      if (ctx.browser?.input?.loaded && entry.relative_path) {
        const inputEntry = {
          filename: entry.name,
          subfolder: entry.subfolder || '',
          relative_path: entry.relative_path,
          type: 'input',
          size: Number(entry.size || 0),
          mtime_ns: Number(entry.mtime_ns || 0),
          source_version: String(entry.source_version || '')
        }
        const existingIndex = inputPosition.get(inputEntry.relative_path) ?? -1
        if (existingIndex >= 0) ctx.browser.input.files[existingIndex] = inputEntry
        else {
          inputPosition.set(inputEntry.relative_path, ctx.browser.input.files.length)
          ctx.browser.input.files.push(inputEntry)
        }
      }
    }
    if (ctx.browser?.input?.loaded && uploaded.length) {
      ctx.inputVersion += 1
      updateFolderOptions(ctx)
    }
    if (uploaded.length) updateState(node, state, uiState)
    if (errors.length) {
      const firstFailure = errors[0].error.message
      ctx.browser.input.error = errors.length === 1
        ? firstFailure
        : `${errors.length} images failed to import. First error: ${firstFailure}`
      console.error('Image Conveyor: some images failed to import.', ...errors.map(({ error }) => error))
      scheduleRenderNode(node)
    }
    return uploaded.length > 0
  } finally {
    ctx.uploadDepth = Math.max(0, ctx.uploadDepth - 1)
    if (ctx.uploadDepth === 0) {
      ctx.dropzone.disabled = false
      ctx.dropzone.textContent = ctx.dropzoneLabel || '+ Add images'
      ctx.dropzoneLabel = ''
    }
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
  node.setSize?.([Math.max(oldSize[0], MIN_NODE_WIDTH), Math.max(oldSize[1], MIN_NODE_HEIGHT)])

  attachQueueLifecycle(node)
  autoQueueCoordinator.registerNode(node)
  canvasDropCoordinator.registerNode(node)

  node.onDragOver = (event) => {
    if (!hasExternalFileDrag(event)) return false
    event.preventDefault?.()
    event.stopPropagation?.()
    event.stopImmediatePropagation?.()
    return true
  }

  node.onDragDrop = async (event) => {
    if (!consumeExternalFileDrag(event)) return false
    const files = await getDroppedImageFiles(event)
    if (!files.length) return false
    return await uploadViaNode(node, files)
  }

  node.pasteFile = (file) => {
    const files = normalizeUploadFiles([file])
    if (!files.length) return false
    void uploadViaNode(node, files).catch((error) => console.error('Image Conveyor: paste import failed.', error))
    return true
  }

  node.pasteFiles = (files) => {
    const validFiles = normalizeUploadFiles(files)
    if (!validFiles.length) return false
    void uploadViaNode(node, validFiles).catch((error) => console.error('Image Conveyor: paste import failed.', error))
    return true
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
    const snapshot = getCurrentState(node, { fromWidgets: true })
    const ctx = node.__bil
    if (ctx) {
      ctx.queueRevision += 1
      ctx.annotatedCountsRevision = -1
      ctx.browser.conveyor.selected = new Set(snapshot.uiState.selected_ids)
    }
    const normalizedStateValue = serializeState(snapshot.state)
    if (stateWidget.value !== normalizedStateValue) {
      setWidgetValue(stateWidget, normalizedStateValue)
      markNodeDirty(node)
    }
    cacheRenderableState(node, snapshot.state, snapshot.uiState)
    queueMicrotask(() => scheduleRenderNode(node))
  })

  chainNodeCallback(node, 'onResize', function () {
    syncDomWidgetSize(node, widget)
    scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
  })

  chainNodeCallback(node, 'onRemoved', function () {
    autoQueueCoordinator.unregisterNode(node)
    canvasDropCoordinator.unregisterNode(node)
    const ctx = node.__bil
    if (!ctx) return
    ctx.removed = true
    ctx.inputRequestId += 1
    if (ctx.documentPasteHandler) {
      document.removeEventListener('paste', ctx.documentPasteHandler, true)
      ctx.documentPasteHandler = null
    }
    if (ctx.documentMiddlePanMoveHandler) {
      document.removeEventListener('pointermove', ctx.documentMiddlePanMoveHandler, true)
      ctx.documentMiddlePanMoveHandler = null
    }
    if (ctx.documentMiddlePanEndHandler) {
      document.removeEventListener('pointerup', ctx.documentMiddlePanEndHandler, true)
      document.removeEventListener('pointercancel', ctx.documentMiddlePanEndHandler, true)
      ctx.documentMiddlePanEndHandler = null
    }
    ctx.middlePanPointerId = null
    if (ctx.documentKeyHandler) {
      document.removeEventListener('keydown', ctx.documentKeyHandler, true)
      ctx.documentKeyHandler = null
    }
    ctx.inputAbortController?.abort?.()
    ctx.inputAbortController = null
    clearTimeout(ctx.searchTimer)
    ctx.lightbox?.root?.remove?.()
    ctx.listResizeObserver?.disconnect?.()
    ctx.listResizeObserver = null
    if (!ctx.renderFrame) return
    cancelAnimationFrame(ctx.renderFrame)
    ctx.renderFrame = 0
    ctx.renderViewportOnly = false
  })

  const snapshot = getCurrentState(node, { fromWidgets: true })
  node.__bil.browser.conveyor.selected = new Set(snapshot.uiState.selected_ids)
  const normalizedStateValue = serializeState(snapshot.state)
  if (stateWidget.value !== normalizedStateValue) {
    setWidgetValue(stateWidget, normalizedStateValue)
    markNodeDirty(node)
  }
  cacheRenderableState(node, snapshot.state, snapshot.uiState)
  queueMicrotask(() => scheduleRenderNode(node))
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
            minHeight: MIN_WIDGET_HEIGHT,
            minWidth: MIN_NODE_WIDTH
          }
        }

        const root = buildGalleryDom(node)
        const widget = node.addDOMWidget(inputName, CUSTOM_WIDGET_TYPE, root, {
          getMinHeight: () => MIN_WIDGET_HEIGHT,
          getHeight: () => '100%',
          onDraw: (domWidget) => syncDomWidgetSize(node, domWidget),
          afterResize: (domWidgetNode) => syncDomWidgetSize(domWidgetNode, widget),
          serialize: false
        })
        syncDomWidgetSize(node, widget)
        widget.serialize = false

        initializeNode(node, widget)

        return {
          widget,
          minHeight: MIN_WIDGET_HEIGHT,
          minWidth: MIN_NODE_WIDTH
        }
      }
    }
  }
})
