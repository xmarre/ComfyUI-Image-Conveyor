import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'
import '../../scripts/domWidget.js'
import {
  CARD_FOOTER_HEIGHT,
  OUTPUT_MODE_PERSISTENT,
  OUTPUT_MODE_QUEUE_GROUP,
  REFERENCE_SLOT_COUNT,
  calculateAutoQueueExtraExecutions,
  applyReferenceAssignments,
  calculateReferenceShelfLayout,
  calculateGalleryDropIntent,
  calculateMarqueeGridIndexes,
  calculateGalleryMetrics,
  calculateReorderDestinationIndex,
  calculateVisibleCardRange,
  chooseViewAfterClose,
  clientPointToScrollContent,
  completeExecutionGroupCount,
  createPreviewNavigation,
  dispatchKeyboundCommandFallback,
  groupDirectoryPickerFiles,
  hasVisibleModalCandidate,
  isDragLeavingDocument,
  isGalleryViewportMeasurable,
  isHighVelocityScroll,
  isConveyorGalleryShortcut,
  makeQueueReservationPayload,
  markReservedGroupQueued,
  moveReferenceSlot,
  normalizeImagesPerExecution,
  normalizeOutputMode,
  normalizeReferenceSlot,
  normalizeReferenceSlots,
  planCardSlotReuse,
  planViewScrollSwitch,
  prepareManagedDuplicateCleanup,
  processedItemIdsFromDelta,
  queueReservationMembers,
  restoreGraphCanvasFocus,
  selectExecutionGroup,
  effectiveQueueGroupSize,
  classifyReferenceDrag,
  loadPresetSnapshot,
  referencePresetDisplay,
  referenceShelfHit,
  relinkReferenceSlots,
  shouldReanchorGalleryResize,
  snapshotReferenceOutputConnections,
  isConveyorDeleteShortcut,
  stepPreviewNavigationIndex
} from './image_conveyor_math.mjs?v=64d0259bdfdbb853'

const EXTENSION_NAME = 'Comfy.ImageConveyor.VueNodes'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const STATE_WIDGET = 'state_json'
const UI_STATE_WIDGET = 'ui_state_json'
const QUEUE_WIDGET = 'queue_item_json'
const CUSTOM_WIDGET_INPUT = 'batch_loader_ui'
const CUSTOM_WIDGET_TYPE = 'BATCH_IMAGE_LOADER_UI'
const DOM_WIDGET_NAME = 'batch_loader_ui'
const STYLE_ID = 'comfy-batch-image-loader-style'
const STATE_VERSION = 2
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
const FAST_SCROLL_SETTLE_MS = 80
const MARQUEE_DRAG_THRESHOLD = 4
const MARQUEE_AUTOSCROLL_EDGE = 36
const MARQUEE_AUTOSCROLL_MAX = 18
const LOCAL_OBJECT_URL_LIMIT = 512
const CARD_SIZES = {
  small: { minWidth: 124, thumbnail: 160 },
  medium: { minWidth: 172, thumbnail: 256 },
  large: { minWidth: 224, thumbnail: 384 }
}
let keyboardOwnerNode = null
const keyboardNodes = new Set()
let activeReferenceDrag = null

function claimGalleryKeyboardOwnership(node) {
  if (keyboardOwnerNode && keyboardOwnerNode !== node) {
    const previous = keyboardOwnerNode.__bil
    if (previous) previous.keyboardActive = false
  }
  keyboardOwnerNode = node
  if (node.__bil) node.__bil.keyboardActive = true
}

function releaseGalleryKeyboardOwnership(node) {
  if (node.__bil) node.__bil.keyboardActive = false
  if (keyboardOwnerNode === node) keyboardOwnerNode = null
}

function eventOrigin(event) {
  return event.composedPath?.()[0] ?? event.target
}

function isNeutralKeyboardTarget(target) {
  return target === document || target === document.body || target === document.documentElement
}

function conveyorForKeyboardTarget(target) {
  if (!(target instanceof Node)) return null
  for (const node of keyboardNodes) {
    if (node.__bil?.root?.contains(target)) return node
  }
  return null
}

const keyboardCoordinator = {
  attached: false,

  registerNode(node) {
    keyboardNodes.add(node)
    if (this.attached) return
    document.addEventListener('keydown', this.handleGalleryKeyDown, true)
    window.addEventListener('keydown', this.handleComfyFallbackKeyDown)
    this.attached = true
  },

  unregisterNode(node) {
    keyboardNodes.delete(node)
    releaseGalleryKeyboardOwnership(node)
    if (keyboardNodes.size || !this.attached) return
    document.removeEventListener('keydown', this.handleGalleryKeyDown, true)
    window.removeEventListener('keydown', this.handleComfyFallbackKeyDown)
    this.attached = false
  },

  handleGalleryKeyDown(event) {
    if (event.defaultPrevented || event.isComposing || !keyboardNodes.size) return
    const target = eventOrigin(event)
    const canvas = app.canvas?.canvas
    const neutralTarget = isNeutralKeyboardTarget(target)
    const targetNode = target === canvas || neutralTarget
      ? null
      : conveyorForKeyboardTarget(target)
    const owner = keyboardOwnerNode?.__bil ? keyboardOwnerNode : null
    const ownerOwnsTarget = owner && (
      target === canvas ||
      targetNode === owner ||
      neutralTarget
    )
    if (ownerOwnsTarget && isConveyorGalleryShortcut(event)) handleGalleryKeyDown(owner, event)
  },

  handleComfyFallbackKeyDown(event) {
    if (event.defaultPrevented || event.isComposing || !keyboardNodes.size) return
    dispatchKeyboundCommandFallback(event, app.extensionManager?.command, {
      modalOpen: hasVisibleModal(),
      onError: (error) => console.error('Image Conveyor: ComfyUI shortcut command failed.', error)
    })
  }
}

function hasVisibleModal() {
  return hasVisibleModalCandidate(
    document.querySelectorAll('dialog[open], [aria-modal="true"], .p-dialog-mask, .comfy-modal')
  )
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
    catch_canvas_drops: false,
    images_per_execution: 1,
    output_mode: OUTPUT_MODE_PERSISTENT,
    reference_slots: Array(REFERENCE_SLOT_COUNT).fill(null),
    active_reference_preset_id: ''
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
  const imagesPerExecution = normalizeImagesPerExecution(state.images_per_execution ?? 1)
  const outputMode = normalizeOutputMode(
    state.output_mode,
    imagesPerExecution,
    Object.hasOwn(state, 'output_mode')
  )
  return {
    version: STATE_VERSION,
    items,
    auto_queue: Boolean(state.auto_queue),
    dont_consume: Boolean(state.dont_consume),
    catch_canvas_drops: Boolean(state.catch_canvas_drops),
    images_per_execution: imagesPerExecution,
    output_mode: outputMode,
    reference_slots: normalizeReferenceSlots(state.reference_slots),
    active_reference_preset_id: String(state.active_reference_preset_id ?? '').trim()
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
      catch_canvas_drops: Boolean(state.catch_canvas_drops),
      images_per_execution: normalizeImagesPerExecution(state.images_per_execution),
      output_mode: normalizeOutputMode(state.output_mode, state.images_per_execution, true),
      reference_slots: normalizeReferenceSlots(state.reference_slots),
      active_reference_preset_id: String(state.active_reference_preset_id ?? '').trim()
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

function findNextLoadGroup(state) {
  return selectExecutionGroup(
    state.items,
    effectiveQueueGroupSize(state.output_mode, state.images_per_execution),
    state.dont_consume
  )
}

function findNextLoadItem(state) {
  return findNextLoadGroup(state)[0] ?? null
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
      const imagesPerExecution = effectiveQueueGroupSize(state.output_mode, state.images_per_execution)
      const completeGroups = completeExecutionGroupCount(pendingCount, imagesPerExecution)
      if (completeGroups <= 0) continue
      eligible.push({ node, pendingCount, imagesPerExecution, completeGroups })
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
          'Image Conveyor: auto-queue is only applied when exactly one conveyor node with complete pending groups has auto-queue enabled.'
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
    const { pendingCount, imagesPerExecution } = eligibleNodes[0]
    const extraCount = calculateAutoQueueExtraExecutions(
      pendingCount,
      imagesPerExecution,
      requestedBatchCount
    )
    if (extraCount <= 0) return

    this.pendingInternalQueueRequests += 1
    queueMicrotask(() => {
      void app.queuePrompt(0, extraCount).catch((error) => {
        console.error(
          'Image Conveyor: failed to auto-queue remaining complete image groups.',
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
  if (!active) ctx.tabs?.classList.remove('bil-folder-drop-ready', 'bil-folder-drop-hover')
  if (!active && ctx.cardPool) clearCardDragTargets(ctx)
}

const canvasDropCoordinator = {
  nodes: new Set(),
  listenerAttached: false,
  dragOverHandler: null,
  dropHandler: null,
  dragLeaveHandler: null,
  dragEndHandler: null,
  windowBlurHandler: null,
  dragExitTimer: null,
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
    this.dragEndHandler = () => {
      this.cancelPendingDragExit()
      this.clearAllDragTargets()
    }
    this.windowBlurHandler = this.dragEndHandler
    document.addEventListener('dragover', this.dragOverHandler, true)
    document.addEventListener('drop', this.dropHandler, true)
    document.addEventListener('dragleave', this.dragLeaveHandler, true)
    document.addEventListener('dragend', this.dragEndHandler, true)
    window.addEventListener('blur', this.windowBlurHandler)
  },

  detach() {
    if (!this.listenerAttached) return
    document.removeEventListener('dragover', this.dragOverHandler, true)
    document.removeEventListener('drop', this.dropHandler, true)
    document.removeEventListener('dragleave', this.dragLeaveHandler, true)
    document.removeEventListener('dragend', this.dragEndHandler, true)
    window.removeEventListener('blur', this.windowBlurHandler)
    this.listenerAttached = false
    this.dragOverHandler = null
    this.dropHandler = null
    this.dragLeaveHandler = null
    this.dragEndHandler = null
    this.windowBlurHandler = null
    this.cancelPendingDragExit()
    this.clearAllDragTargets()
  },

  cancelPendingDragExit() {
    if (this.dragExitTimer == null) return
    clearTimeout(this.dragExitTimer)
    this.dragExitTimer = null
  },

  clearAllDragTargets() {
    this.setActiveNode(null)
    for (const node of this.nodes) {
      node?.__bil?.clearExternalDragState?.()
    }
  },

  scheduleDragExitClear() {
    this.cancelPendingDragExit()
    this.dragExitTimer = setTimeout(() => {
      this.dragExitTimer = null
      this.clearAllDragTargets()
    }, 0)
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
    this.cancelPendingDragExit()
    if (event.defaultPrevented && !isGraphCanvasDropTarget(event.target)) {
      this.setActiveNode(null)
      return
    }
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
    this.cancelPendingDragExit()
    if (event.defaultPrevented && !isGraphCanvasDropTarget(event.target)) {
      this.clearAllDragTargets()
      return
    }
    const node = this.resolveDropNode(event)
    if (!node) {
      this.clearAllDragTargets()
      return
    }
    if (!hasExternalFileDrag(event)) {
      this.clearAllDragTargets()
      return
    }

    finalizeExternalFileDrag(event)
    this.clearAllDragTargets()
    node.__bil?.restoreCanvasShortcutFocus?.()

    const files = await getDroppedImageFiles(event)
    if (!files.length) return
    try {
      await uploadViaNode(node, files)
    } catch (error) {
      console.error('Image Conveyor: drop import failed.', error)
      const ctx = node.__bil
      if (ctx && !ctx.removed) {
        ctx.browser.input.error = error?.message || 'Import failed'
        scheduleRenderNode(node)
      }
    }
  },

  handleDragLeave(event) {
    if (isDragLeavingDocument(event, document.documentElement)) this.scheduleDragExitClear()
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

function moveItemToInsertionIndex(state, draggedId, insertionIndex) {
  if (!draggedId || !Array.isArray(state?.items)) return false
  const fromIndex = state.items.findIndex((item) => item.id === draggedId)
  if (fromIndex < 0) return false
  const destination = calculateReorderDestinationIndex(state.items.length, fromIndex, insertionIndex)
  if (destination < 0) return false
  const [moved] = state.items.splice(fromIndex, 1)
  state.items.splice(destination, 0, moved)
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
 * Build the input-relative upload folder while preserving a dropped directory's structure.
 * @param {string} relativeSubfolder - A relative subfolder path (may be empty or contain redundant segments).
 * @returns {string} The normalized input-relative subfolder, or an empty string for the input root.
 */
function buildUploadSubfolder(relativeSubfolder = '') {
  return normalizeRelativeSubfolder(relativeSubfolder)
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

function hasExternalDirectoryDrag(event) {
  return Array.from(event?.dataTransfer?.items ?? [])
    .filter((item) => item?.kind === 'file')
    .some((item) => getTransferItemEntry(item)?.isDirectory)
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

async function collectFolderSourceFromEntry(entry) {
  if (!entry?.isDirectory || typeof entry.createReader !== 'function') return null
  const source = {
    id: makeId(),
    name: String(entry.name || 'Folder').trim() || 'Folder',
    files: [],
    directories: new Set([''])
  }

  const walk = async (directory, parentPath) => {
    const reader = directory.createReader()
    const children = await readDirectoryEntries(reader)
    children.sort(compareFileSystemEntryNames)
    for (const child of children) {
      const childPath = normalizeRelativeSubfolder(
        parentPath ? `${parentPath}/${child.name}` : child.name
      )
      if (child.isDirectory) {
        source.directories.add(childPath)
        await walk(child, childPath)
        continue
      }
      if (!child.isFile) continue
      const file = await new Promise((resolve, reject) => child.file(resolve, reject))
      if (isProbablyImageFile(file)) source.files.push({ file, relativePath: childPath })
    }
  }

  await walk(entry, '')
  return source
}

async function getDroppedFolderSources(event) {
  const items = Array.from(event?.dataTransfer?.items ?? []).filter((item) => item?.kind === 'file')
  const directoryEntries = items
    .map((item) => getTransferItemEntry(item))
    .filter((entry) => entry?.isDirectory)
  const sources = []
  for (const entry of directoryEntries) {
    try {
      const source = await collectFolderSourceFromEntry(entry)
      if (source) sources.push(source)
    } catch (error) {
      console.error(`Image Conveyor: failed to read folder '${entry?.name || 'unknown'}'.`, error)
    }
  }
  return sources
}

function makePickerFolderSources(files) {
  return groupDirectoryPickerFiles(files, isProbablyImageFile).map((group) => ({
    id: makeId(),
    name: group.name,
    files: group.files,
    directories: new Set(group.directories)
  }))
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

function pruneLocalObjectUrls(ctx) {
  if (ctx.localObjectUrls.size <= LOCAL_OBJECT_URL_LIMIT) return
  const inUse = new Set(ctx.cardPool.map((slot) => slot.previewUrl).filter(Boolean))
  const lightboxUrl = ctx.lightbox?.image?.getAttribute?.('src')
  if (lightboxUrl) inUse.add(lightboxUrl)
  for (const [file, entry] of ctx.localObjectUrls) {
    if (ctx.localObjectUrls.size <= LOCAL_OBJECT_URL_LIMIT) break
    if (inUse.has(entry.url)) continue
    URL.revokeObjectURL(entry.url)
    ctx.localObjectUrls.delete(file)
  }
}

function localObjectUrl(ctx, item) {
  const file = item?.localFile
  if (!(file instanceof File)) return ''
  const existing = ctx.localObjectUrls.get(file)
  if (existing) {
    ctx.localObjectUrls.delete(file)
    ctx.localObjectUrls.set(file, existing)
    return existing.url
  }
  const url = URL.createObjectURL(file)
  ctx.localObjectUrls.set(file, { url, sourceId: item.sourceId })
  pruneLocalObjectUrls(ctx)
  return url
}

function releaseLocalSourceUrls(ctx, sourceId) {
  for (const [file, entry] of ctx.localObjectUrls) {
    if (entry.sourceId !== sourceId) continue
    URL.revokeObjectURL(entry.url)
    ctx.localObjectUrls.delete(file)
  }
}

function filePreviewUrl(item, ctx = null) {
  if (item?.localFile && ctx) return localObjectUrl(ctx, item)
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

function cachedThumbnailUrl(ctx, item, density) {
  if (item?.localFile) return localObjectUrl(ctx, item)
  if (!item?.source_version) return thumbnailUrl(item, density)
  let urls = ctx.thumbnailUrlCache.get(item)
  if (!urls) {
    urls = new Map()
    ctx.thumbnailUrlCache.set(item, urls)
  }
  const cached = urls.get(density)
  if (cached?.sourceVersion === item.source_version) return cached.url
  const url = thumbnailUrl(item, density)
  urls.set(density, { sourceVersion: item.source_version, url })
  return url
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

function makeReferenceFromInputEntry(entry) {
  if (entry?.type && String(entry.type).toLowerCase() !== 'input') return null
  const relativePath = normalizeSourcePath(
    entry?.relative_path || stripAnnotatedStorageTypeSuffix(entry?.annotated)
  ).replace(/^\/+/, '')
  if (!relativePath) return null
  const separator = relativePath.lastIndexOf('/')
  return normalizeReferenceSlot({
    annotated: `${relativePath} [input]`,
    filename: separator >= 0 ? relativePath.slice(separator + 1) : relativePath,
    subfolder: separator >= 0 ? relativePath.slice(0, separator) : '',
    type: 'input'
  })
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
  const entries = normalizeUploadFiles(files)
  let snapshotRefreshed = false
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const { file, relativeSubfolder } = entry
    try {
      const body = new FormData()
      body.append('image', file)
      body.append('type', 'input')
      body.append('subfolder', buildUploadSubfolder(relativeSubfolder))
      if (!snapshotRefreshed) body.append('refresh_snapshot', 'true')
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
      snapshotRefreshed = true
    } catch (error) {
      errors.push({ file, error: error instanceof Error ? error : new Error(String(error)) })
    }
  }
  return { uploaded, errors }
}

function mergeUploadedInputMetadata(ctx, uploaded) {
  if (!ctx.browser?.input?.loaded || !uploaded.length) return
  const inputPosition = new Map(
    ctx.browser.input.files.map((entry, index) => [entry.relative_path, index])
  )
  for (const entry of uploaded) {
    if (!entry?.relative_path) continue
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
  ctx.inputVersion += 1
  updateFolderOptions(ctx)
}

function setReferenceSlots(node, startIndex, references) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return 0
  const { state, uiState } = getRenderableState(node)
  if (state.output_mode !== OUTPUT_MODE_PERSISTENT) return 0
  const next = applyReferenceAssignments(state, startIndex, references)
  const changed = next.reference_slots.reduce((count, slot, index) => (
    slot?.annotated !== state.reference_slots[index]?.annotated ? count + 1 : count
  ), 0)
  if (!changed) return 0
  state.reference_slots = next.reference_slots
  updateState(node, state, uiState)
  node.setDirtyCanvas?.(true, true)
  return changed
}

function clearReferenceSlot(node, index) {
  const { state, uiState } = getRenderableState(node)
  const slots = normalizeReferenceSlots(state.reference_slots)
  if (!slots[index]) return false
  slots[index] = null
  state.reference_slots = slots
  updateState(node, state, uiState)
  node.setDirtyCanvas?.(true, true)
  return true
}

async function importReferenceOnly(node, files, startIndex) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return false
  const entries = normalizeUploadFiles(files)
  if (!entries.length) return false
  const { uploaded, errors } = await uploadFiles(entries)
  if (node.__bil !== ctx || ctx.removed) return false
  mergeUploadedInputMetadata(ctx, uploaded)
  const references = uploaded.map((entry) => makeReferenceFromInputEntry({
    relative_path: entry.relative_path,
    filename: entry.name,
    subfolder: entry.subfolder,
    annotated: `${entry.relative_path} [input]`
  })).filter(Boolean)
  const assigned = setReferenceSlots(node, startIndex, references)
  if (errors.length) {
    const message = errors.length === 1
      ? errors[0].error.message
      : `${errors.length} reference images failed to import.`
    ctx.browser.input.error = message
    console.error('Image Conveyor: reference-only import failed for some images.', ...errors.map(({ error }) => error))
    scheduleRenderNode(node)
  }
  return assigned > 0
}

async function assignReferenceDrag(node, drag, slotIndex) {
  if (!drag?.classification) return false
  if (drag.classification.requiresImport) {
    const file = drag.item?.localFile
    if (!(file instanceof File)) return false
    return importReferenceOnly(node, [{
      file,
      relativeSubfolder: drag.item.relativeSubfolder || drag.item.subfolder || ''
    }], slotIndex)
  }
  const reference = makeReferenceFromInputEntry(drag.item)
  return reference ? setReferenceSlots(node, slotIndex, [reference]) > 0 : false
}

function formatByteCount(value) {
  const bytes = Math.max(0, Number(value) || 0)
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let amount = bytes
  let unit = -1
  do {
    amount /= 1024
    unit += 1
  } while (amount >= 1024 && unit < units.length - 1)
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`
}

async function readJsonResponse(response, fallbackMessage) {
  let payload = null
  try {
    payload = await response.json()
  } catch {
    // The fallback below includes the HTTP status when the response is not JSON.
  }
  if (!response.ok) {
    throw new Error(payload?.error || `${fallbackMessage} (${response.status} ${response.statusText})`)
  }
  return payload
}

function rewriteLiveInputReferences(replacements) {
  const byDeletedPath = new Map(
    replacements
      .filter((entry) => entry?.relative_path && entry?.keep_path)
      .map((entry) => [normalizeSourcePath(entry.relative_path), normalizeSourcePath(entry.keep_path)])
  )
  if (!byDeletedPath.size) return 0

  let rewritten = 0
  for (const node of autoQueueCoordinator.nodes) {
    const ctx = node?.__bil
    if (!ctx || ctx.removed) continue
    const { state, uiState } = getRenderableState(node)
    let changed = false
    for (const item of state.items) {
      if (item.type !== 'input') continue
      const oldPath = normalizeSourcePath(stripAnnotatedStorageTypeSuffix(item.annotated))
      const keepPath = byDeletedPath.get(oldPath)
      if (!keepPath) continue
      const separator = keepPath.lastIndexOf('/')
      item.annotated = `${keepPath} [input]`
      item.filename = separator >= 0 ? keepPath.slice(separator + 1) : keepPath
      item.subfolder = separator >= 0 ? keepPath.slice(0, separator) : ''
      if (normalizeSourcePath(item.source_path) === oldPath) item.source_path = keepPath
      if (normalizeSourcePath(uiState.source_paths[item.id]) === oldPath) uiState.source_paths[item.id] = keepPath
      rewritten += 1
      changed = true
    }
    const relinkedReferences = relinkReferenceSlots(state.reference_slots, replacements)
    if (relinkedReferences.changed) {
      state.reference_slots = relinkedReferences.slots
      rewritten += relinkedReferences.changed
      changed = true
    }
    if (changed) updateState(node, state, uiState)
  }
  return rewritten
}

function getQueuedLegacyInputPaths() {
  const paths = new Set()
  for (const node of autoQueueCoordinator.nodes) {
    const ctx = node?.__bil
    if (!ctx || ctx.removed) continue
    const { state } = getRenderableState(node)
    for (const item of state.items) {
      if (item.type !== 'input' || item.status !== 'queued') continue
      const path = normalizeSourcePath(stripAnnotatedStorageTypeSuffix(item.annotated))
      if (path === 'image_conveyor' || path.startsWith('image_conveyor/')) paths.add(path)
    }
  }
  return paths
}

async function cleanManagedDuplicates(node) {
  const ctx = node.__bil
  if (!ctx || ctx.duplicateCleanupBusy) return
  ctx.duplicateCleanupBusy = true
  const button = ctx.cleanDuplicatesBtn
  const previousLabel = button.textContent
  button.disabled = true
  button.textContent = 'Scanning duplicates…'
  try {
    const scanResponse = await api.fetchApi('/image-conveyor/managed-duplicates/scan', { method: 'POST' })
    const report = await readJsonResponse(scanResponse, 'Duplicate scan failed')
    if (node.__bil !== ctx || ctx.removed) return
    const cleanup = prepareManagedDuplicateCleanup(report?.groups, getQueuedLegacyInputPaths())
    const { groups, duplicateCount, reclaimableBytes, protectedCount: queuedCount } = cleanup
    if (!duplicateCount || !groups.length) {
      window.alert(queuedCount
        ? 'The managed duplicates are currently reserved by queued Conveyor items. Run cleanup after those prompts finish or are released.'
        : 'No byte-identical redundant files were found under input/image_conveyor.')
      return
    }

    const mappings = groups.flatMap((group) => (
      (Array.isArray(group.duplicates) ? group.duplicates : []).map((duplicate) => (
        `${duplicate.relative_path}  →  ${group.keep_path}`
      ))
    ))
    const previewLimit = 8
    const preview = mappings.slice(0, previewLimit).join('\n')
    const omitted = mappings.length > previewLimit ? `\n…and ${mappings.length - previewLimit} more` : ''
    const confirmed = window.confirm(
      `Found ${duplicateCount} byte-identical managed duplicate${duplicateCount === 1 ? '' : 's'} ` +
      `(${formatByteCount(reclaimableBytes)}).` +
      (queuedCount ? ` ${queuedCount} queued file${queuedCount === 1 ? ' is' : 's are'} protected and will be left in place.` : '') +
      `\n\n${preview}${omitted}\n\n` +
      'Delete the image_conveyor copies and keep the listed input files? ' +
      'Open Conveyor nodes will be relinked before deletion. Start cleanup when no generation is running. ' +
      'Saved workflows that are not currently open can still reference a deleted legacy path.'
    )
    if (!confirmed) return

    const protectedPaths = getQueuedLegacyInputPaths()
    const plannedReplacements = groups.flatMap((group) => group.duplicates
      .filter((duplicate) => !protectedPaths.has(normalizeSourcePath(duplicate.relative_path)))
      .map((duplicate) => ({
        relative_path: duplicate.relative_path,
        keep_path: group.keep_path
      })))
    const preRewritten = rewriteLiveInputReferences(plannedReplacements)
    button.textContent = 'Deleting duplicates…'
    const deleteResponse = await api.fetchApi('/image-conveyor/managed-duplicates/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groups,
        protected_paths: Array.from(protectedPaths)
      })
    })
    const result = await readJsonResponse(deleteResponse, 'Duplicate cleanup failed')
    const deleted = Array.isArray(result?.deleted) ? result.deleted : []
    const skipped = Array.isArray(result?.skipped) ? result.skipped : []
    const reservationSkipReason = 'The duplicate is reserved by a queued Conveyor item.'
    const reservationSkips = skipped.filter((entry) => entry?.reason === reservationSkipReason).length
    const changedSkips = skipped.length - reservationSkips
    const rewrittenAfterDelete = rewriteLiveInputReferences(deleted)
    const rewritten = preRewritten + rewrittenAfterDelete
    await Promise.all(
      Array.from(autoQueueCoordinator.nodes)
        .filter((candidate) => candidate?.__bil && !candidate.__bil.removed)
        .map((candidate) => refreshInputFiles(candidate, { force: true }))
    )
    const summary = [
      `Deleted ${deleted.length} exact duplicate${deleted.length === 1 ? '' : 's'} ` +
      `and reclaimed ${formatByteCount(result?.reclaimed_bytes)}.`,
      rewritten ? `Updated ${rewritten} open Conveyor reference${rewritten === 1 ? '' : 's'}.` : '',
      result?.presets_relinked
        ? `Updated ${result.presets_relinked} saved preset reference${result.presets_relinked === 1 ? '' : 's'}.`
        : '',
      reservationSkips ? `${reservationSkips} newly queued file${reservationSkips === 1 ? ' was' : 's were'} protected.` : '',
      changedSkips ? `${changedSkips} file${changedSkips === 1 ? ' was' : 's were'} skipped because the filesystem changed after the preview.` : ''
    ].filter(Boolean).join('\n')
    if (node.__bil === ctx && !ctx.removed) window.alert(summary)
  } catch (error) {
    if (node.__bil === ctx && !ctx.removed) {
      ctx.browser.input.error = error?.message || 'Duplicate cleanup failed'
      scheduleRenderNode(node)
      window.alert(ctx.browser.input.error)
    }
  } finally {
    if (node.__bil === ctx && !ctx.removed) {
      ctx.duplicateCleanupBusy = false
      button.disabled = false
      button.textContent = previousLabel
    }
  }
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
    .bil-tabs { display: flex; flex: 1 1 0; gap: 3px; min-width: 0; overflow-x: auto; overflow-y: hidden; padding: 2px; border-radius: 8px; scrollbar-width: none; }
    .bil-tabs::-webkit-scrollbar { display: none; }
    .bil-tabs.bil-folder-drop-ready { outline: 1px dashed rgba(115,175,250,.75); outline-offset: -2px; }
    .bil-tabs.bil-folder-drop-hover { outline: 2px solid #73aef5; background: rgba(90,155,235,.16); }
    .bil-tabs > .bil-tab, .bil-tab-shell { flex: 1 1 150px; min-width: 24px; max-width: 210px; }
    .bil-tab-shell { position: relative; display: flex; overflow: hidden; container: bil-tab / inline-size; }
    .bil-tab-shell.bil-tab-active { min-width: 54px; }
    .bil-tab-shell > .bil-tab { width: 100%; min-width: 0; padding-right: 25px; }
    .bil-tab-label { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bil-tab-close { position: absolute; top: 50%; right: 5px; width: 18px; height: 18px; transform: translateY(-50%); padding: 0; border: 0; border-radius: 50%; background: transparent; color: inherit; font: 16px/17px system-ui, sans-serif; cursor: pointer; }
    .bil-tab-close:hover { background: rgba(255,255,255,.16); }
    .bil-tab-close[hidden] { display: none; }
    @container bil-tab (max-width: 74px) {
      .bil-tab-shell:not(.bil-tab-active) > .bil-tab { padding-right: 8px; }
      .bil-tab-shell:not(.bil-tab-active) > .bil-tab-close { display: none; }
    }
    .bil-tab, .bil-btn, .bil-select, .bil-input, .bil-icon-btn {
      border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.055);
      color: inherit; border-radius: 7px; padding: 5px 8px; font: inherit; box-sizing: border-box;
    }
    .bil-tab { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bil-tab, .bil-btn, .bil-icon-btn { cursor: pointer; }
    .bil-tabs > .bil-tab[aria-selected="true"] { min-width: 54px; }
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
    .bil-images-per-execution { max-width: 52px; padding-left: 5px; padding-right: 5px; }
    .bil-list { position: relative; min-height: 0; overflow: auto; flex: 1 1 0; overscroll-behavior: contain; outline: none; }
    .bil-list-inner, .bil-list-window { position: relative; min-height: 100%; }
    .bil-selection-marquee { position: absolute; z-index: 4; pointer-events: none; box-sizing: border-box; border: 1px solid rgba(125,185,255,.95); background: rgba(80,145,225,.18); box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); }
    .bil-selection-marquee[hidden] { display: none; }
    .bil-drop-indicator { position: absolute; z-index: 5; pointer-events: none; border-radius: 999px; background: #7db9ff; box-shadow: 0 0 0 1px rgba(15,35,58,.75), 0 0 10px rgba(100,175,255,.85); }
    .bil-drop-indicator[hidden] { display: none; }
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
    .bil-thumb { width: 100%; height: 100%; display: block; object-fit: contain; background: transparent; opacity: 0; }
    .bil-thumb.bil-thumb-ready { opacity: 1; }
    .bil-thumb-error { opacity: .32; filter: grayscale(1); outline: 1px dashed rgba(255,110,110,.78); outline-offset: -2px; }
    .bil-card-overlay { position: absolute; inset: 6px 6px auto 6px; display: flex; align-items: flex-start; justify-content: flex-end; gap: 4px; pointer-events: none; }
    .bil-badge { padding: 2px 6px; border-radius: 999px; font-size: 10px; text-transform: uppercase; letter-spacing: .025em; background: rgba(20,20,20,.82); }
    .bil-badge-pending { color: #e2e2e2; } .bil-badge-queued { color: #ffd276; } .bil-badge-processed { color: #8bea9e; }
    .bil-count-badge { color: #cce4ff; text-transform: none; }
    .bil-folder-card .bil-media { display: flex; align-items: center; justify-content: center; }
    .bil-folder-icon { position: relative; width: 48%; height: 34%; border-radius: 7px; background: linear-gradient(145deg, #78b8f8, #4d86c7); box-shadow: 0 10px 24px rgba(0,0,0,.22); }
    .bil-folder-icon::before { content: ''; position: absolute; left: 8%; top: -28%; width: 42%; height: 36%; border-radius: 6px 6px 0 0; background: #78b8f8; }
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
    .bil-image-menu { position: fixed; z-index: 100002; width: min(300px, calc(100vw - 16px)); padding: 7px; box-sizing: border-box; border: 1px solid rgba(255,255,255,.22); border-radius: 9px; background: #202124; color: #f0f0f0; box-shadow: 0 14px 40px rgba(0,0,0,.48); font: 12px/1.35 system-ui, sans-serif; }
    .bil-image-menu-title { padding: 4px 7px 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 680; }
    .bil-image-menu-properties { padding: 2px 7px 7px; color: rgba(255,255,255,.68); overflow-wrap: anywhere; }
    .bil-image-menu-properties > div + div { margin-top: 2px; }
    .bil-image-menu-separator { height: 1px; margin: 5px 3px; background: rgba(255,255,255,.12); }
    .bil-image-menu button { display: block; width: 100%; border: 0; border-radius: 6px; padding: 6px 7px; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
    .bil-image-menu button:hover, .bil-image-menu button:focus-visible { background: rgba(120,175,240,.18); outline: none; }
    .bil-image-menu button.bil-danger { color: #ffaaaa; }
    @media (max-width: 600px) { .bil-browserbar { grid-template-columns: minmax(100px,1fr) auto auto; } .bil-browserbar .bil-size-select { display: none; } }
  `
  document.head.appendChild(style)
}

function applyBackendDelta(node, delta) {
  if (!delta || typeof delta !== 'object') return
  const processedIds = processedItemIdsFromDelta(delta)
  if (!processedIds.length) return
  const { state, uiState } = getCurrentState(node)
  const processedSet = new Set(processedIds)
  const now = Date.now()
  let changed = false
  for (const item of state.items) {
    if (!processedSet.has(item.id)) continue
    item.status = delta.new_status === 'processed' ? 'processed' : item.status
    item.last_processed_at = now
    changed = true
  }
  if (changed) updateState(node, state, uiState, { rerender: true })
}

function attachQueueLifecycle(node) {
  if (node.__bilQueueLifecycleAttached) return
  node.__bilQueueLifecycleAttached = true

  const { queueWidget } = getWidgets(node)
  if (!queueWidget) return

  queueWidget.beforeQueued = () => {
    const { state } = getCurrentState(node)
    const count = effectiveQueueGroupSize(state.output_mode, state.images_per_execution)
    const group = findNextLoadGroup(state)
    const payload = snapshotReferenceOutputConnections(
      group.length === count ? makeQueueReservationPayload(group) : null,
      state.output_mode,
      node.outputs
    )
    updateQueueWidget(node, payload)
  }

  queueWidget.afterQueued = () => {
    const queuePayload = safeJsonParse(queueWidget.value, {})
    const members = queueReservationMembers(queuePayload)
    if (!members.length) return
    const { state, uiState } = getCurrentState(node)
    if (state.dont_consume) return
    if (Array.isArray(queuePayload.items)) {
      const byId = new Map(state.items.map((item) => [item.id, item]))
      if (!members.every((member) => byId.get(member.id)?.annotated === member.annotated)) return
    }
    const changed = markReservedGroupQueued(
      state.items,
      queuePayload,
      false,
      Date.now()
    )
    if (changed) updateState(node, state, uiState, { rerender: true })
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
    tabOrder: ['conveyor', 'input'],
    folderSources: new Map(),
    folderViews: new Map(),
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

function browserForView(ctx, view) {
  return ctx.browser[view] ?? ctx.browser.folderViews.get(view)
}

function activeBrowser(ctx) {
  return browserForView(ctx, ctx.browser.activeView)
}

function suspendGalleryViewport(ctx) {
  if (!ctx) return
  if (
    !ctx.galleryViewportSuspended &&
    ctx.pendingScrollRestore?.view !== ctx.browser.activeView &&
    isGalleryViewportMeasurable(ctx.list.clientWidth, ctx.list.clientHeight)
  ) {
    activeBrowser(ctx).scrollTop = ctx.list.scrollTop
  }
  if (!ctx.galleryViewportSuspended) ctx.galleryViewportEpoch += 1
  ctx.galleryViewportSuspended = true
  ctx.renderedRangeKey = ''
}

function isFolderView(ctx, view = ctx.browser.activeView) {
  return ctx.browser.folderViews.has(view)
}

function isLibraryView(ctx, view = ctx.browser.activeView) {
  return view === 'input' || isFolderView(ctx, view)
}

function getViewItemId(ctx, item, view = ctx.browser.activeView) {
  return isLibraryView(ctx, view) ? item.key ?? item.relative_path : item.id
}

function relativeParent(path) {
  const normalized = normalizeRelativeSubfolder(path)
  const separator = normalized.lastIndexOf('/')
  return separator < 0 ? '' : normalized.slice(0, separator)
}

function relativeName(path) {
  const normalized = normalizeRelativeSubfolder(path)
  const separator = normalized.lastIndexOf('/')
  return separator < 0 ? normalized : normalized.slice(separator + 1)
}

function createFolderBrowserState(source, folderPath = '') {
  const currentPath = normalizeRelativeSubfolder(folderPath)
  const entries = []
  for (const directory of source.directories) {
    if (!directory || relativeParent(directory) !== currentPath) continue
    const fullPath = `${source.name}/${directory}`
    entries.push({
      kind: 'folder',
      key: `folder:${source.id}:${directory}`,
      sourceId: source.id,
      folderPath: directory,
      filename: relativeName(directory),
      relative_path: fullPath,
      subfolder: source.name
    })
  }
  for (const entry of source.files) {
    const relativePath = normalizeRelativeSubfolder(entry.relativePath)
    if (!relativePath || relativeParent(relativePath) !== currentPath) continue
    const fullPath = `${source.name}/${relativePath}`
    entries.push({
      kind: 'local-image',
      key: `local:${source.id}:${relativePath}`,
      sourceId: source.id,
      filename: relativeName(relativePath),
      relative_path: fullPath,
      subfolder: relativeParent(fullPath),
      relativeSubfolder: relativeParent(fullPath),
      type: 'local',
      size: Number(entry.file?.size || 0),
      mtime_ns: Number(entry.file?.lastModified || 0),
      source_version: `${Number(entry.file?.size || 0)}-${Number(entry.file?.lastModified || 0)}`,
      localFile: entry.file
    })
  }
  return {
    sourceId: source.id,
    folderPath: currentPath,
    query: '', sort: 'name_asc', size: 'medium', scrollTop: 0,
    focusedId: null, lastSelectedId: null, entries, selected: new Set(),
    loading: false, error: ''
  }
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
  if (isLibraryView(ctx)) {
    const query = browser.query.trim().toLocaleLowerCase()
    const sourceItems = ctx.browser.activeView === 'input' ? browser.files : browser.entries
    const items = sourceItems.filter((entry) => {
      if (ctx.browser.activeView === 'input' && browser.folder !== 'all') {
        const folder = String(entry.subfolder || '')
        if (folder !== browser.folder && !folder.startsWith(`${browser.folder}/`)) return false
      }
      return !query || `${entry.filename} ${entry.relative_path}`.toLocaleLowerCase().includes(query)
    })
    const folderFirst = (left, right) => Number(right.kind === 'folder') - Number(left.kind === 'folder')
    switch (browser.sort) {
      case 'name_desc': items.sort((a, b) => folderFirst(a, b) || compareNatural(b.relative_path, a.relative_path)); break
      case 'newest': items.sort((a, b) => folderFirst(a, b) || (b.mtime_ns || 0) - (a.mtime_ns || 0) || compareNatural(a.relative_path, b.relative_path)); break
      case 'oldest': items.sort((a, b) => folderFirst(a, b) || (a.mtime_ns || 0) - (b.mtime_ns || 0) || compareNatural(a.relative_path, b.relative_path)); break
      default: items.sort((a, b) => folderFirst(a, b) || compareNatural(a.relative_path, b.relative_path)); break
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

function getVisibleCardRange(ctx, totalItems, metrics, scrollTop = ctx.list.scrollTop) {
  return calculateVisibleCardRange(
    totalItems,
    metrics.columns,
    metrics.rowStride,
    CARD_GAP,
    scrollTop,
    ctx.list.clientHeight,
    GALLERY_OVERSCAN_ROWS
  )
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
  const inputView = isLibraryView(ctx)
  const selected = getViewSelectedIds(node)
  ctx.contextBar.hidden = selected.size === 0
  ctx.contextLabel.textContent = `${selected.size} selected`
  ctx.setPendingBtn.hidden = inputView
  ctx.setProcessedBtn.hidden = inputView
  ctx.deleteSelectedBtn.hidden = inputView
  ctx.contextAddBtn.hidden = !inputView
}

function deleteSelectedConveyorItems(node) {
  const ctx = node.__bil
  if (!ctx || ctx.browser.activeView !== 'conveyor') return false
  const selected = ctx.browser.conveyor.selected
  if (!selected.size) return false
  const { state, uiState } = getRenderableState(node)
  const kept = state.items.filter((item) => !selected.has(item.id))
  if (kept.length === state.items.length) return false
  state.items = kept
  uiState.selected_ids = []
  uiState.source_paths = Object.fromEntries(
    Object.entries(uiState.source_paths).filter(([id]) => !selected.has(id))
  )
  selected.clear()
  updateState(node, state, uiState)
  return true
}

function setItemSelected(node, itemId, checked, event = null) {
  const ctx = node.__bil
  const browser = activeBrowser(ctx)
  const items = ctx.visibleItems || []
  const itemIdentifier = (item) => getViewItemId(ctx, item)
  const currentItem = items.find((item) => itemIdentifier(item) === itemId)
  if (currentItem?.kind === 'folder') return
  const selected = browser.selected
  if (event?.shiftKey && browser.lastSelectedId) {
    const anchor = items.findIndex((item) => itemIdentifier(item) === browser.lastSelectedId)
    const current = items.findIndex((item) => itemIdentifier(item) === itemId)
    if (anchor >= 0 && current >= 0) {
      for (let index = Math.min(anchor, current); index <= Math.max(anchor, current); index += 1) {
        if (items[index].kind !== 'folder') selected.add(itemIdentifier(items[index]))
      }
    }
  } else if (checked) selected.add(itemId)
  else selected.delete(itemId)
  browser.lastSelectedId = itemId
  renderSelectionContext(node)
  scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
}

function selectItemFromClick(node, itemId, event) {
  const ctx = node.__bil
  if (!ctx) return
  const browser = activeBrowser(ctx)
  browser.focusedId = itemId
  if (event.shiftKey) {
    setItemSelected(node, itemId, true, event)
    return
  }
  if (event.ctrlKey || event.metaKey) {
    setItemSelected(node, itemId, !browser.selected.has(itemId), event)
    return
  }
  browser.selected = new Set([itemId])
  browser.lastSelectedId = itemId
  renderSelectionContext(node)
  scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
}

function setsEqual(left, right) {
  if (left.size !== right.size) return false
  for (const value of left) if (!right.has(value)) return false
  return true
}

function marqueeContentPoint(ctx, clientX, clientY) {
  const rect = ctx.list.getBoundingClientRect()
  return clientPointToScrollContent(
    clientX,
    clientY,
    rect,
    ctx.list.clientWidth,
    ctx.list.clientHeight,
    ctx.list.scrollLeft,
    ctx.list.scrollTop,
    ctx.list.offsetWidth,
    ctx.list.offsetHeight
  )
}

function marqueeAutoscrollVelocity(list, clientY) {
  const rect = list.getBoundingClientRect()
  const topDistance = clientY - rect.top
  if (topDistance < MARQUEE_AUTOSCROLL_EDGE) {
    return -MARQUEE_AUTOSCROLL_MAX * Math.min(1, (MARQUEE_AUTOSCROLL_EDGE - topDistance) / MARQUEE_AUTOSCROLL_EDGE)
  }
  const bottomDistance = rect.bottom - clientY
  if (bottomDistance < MARQUEE_AUTOSCROLL_EDGE) {
    return MARQUEE_AUTOSCROLL_MAX * Math.min(1, (MARQUEE_AUTOSCROLL_EDGE - bottomDistance) / MARQUEE_AUTOSCROLL_EDGE)
  }
  return 0
}

function renderMarqueeSelection(node, selection) {
  const ctx = node.__bil
  if (!ctx || ctx.marqueeSelection !== selection || ctx.browser.activeView !== selection.view) return
  const current = marqueeContentPoint(ctx, selection.clientX, selection.clientY)
  const distance = Math.hypot(selection.clientX - selection.anchorClientX, selection.clientY - selection.anchorClientY)
  if (!selection.active && distance < MARQUEE_DRAG_THRESHOLD) return
  selection.active = true

  const bounds = {
    left: Math.min(selection.anchor.x, current.x),
    right: Math.max(selection.anchor.x, current.x),
    top: Math.min(selection.anchor.y, current.y),
    bottom: Math.max(selection.anchor.y, current.y)
  }
  const items = ctx.visibleItems || []
  const metrics = getGalleryMetrics(ctx)
  const hitIds = []
  for (const index of calculateMarqueeGridIndexes(items.length, metrics, bounds)) {
    const item = items[index]
    if (!item || item.kind === 'folder') continue
    hitIds.push(getViewItemId(ctx, item))
  }

  const next = selection.toggle || selection.additive
    ? new Set(selection.baseline)
    : new Set()
  for (const id of hitIds) {
    if (selection.toggle && selection.baseline.has(id)) next.delete(id)
    else next.add(id)
  }
  const browser = activeBrowser(ctx)
  if (!setsEqual(browser.selected, next)) {
    browser.selected = next
    renderSelectionContext(node)
    scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
  }
  selection.lastHitId = hitIds.at(-1) ?? null
  Object.assign(ctx.selectionMarquee.style, {
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${Math.max(1, bounds.right - bounds.left)}px`,
    height: `${Math.max(1, bounds.bottom - bounds.top)}px`
  })
  ctx.selectionMarquee.hidden = false
}

function scheduleMarqueeSelectionFrame(node) {
  const ctx = node.__bil
  const selection = ctx?.marqueeSelection
  if (!selection || selection.frame) return
  selection.frame = requestAnimationFrame(() => {
    selection.frame = 0
    if (ctx.removed || ctx.marqueeSelection !== selection) return
    const velocity = marqueeAutoscrollVelocity(ctx.list, selection.clientY)
    const previousTop = ctx.list.scrollTop
    if (velocity) ctx.list.scrollTop += velocity
    renderMarqueeSelection(node, selection)
    if (velocity && ctx.list.scrollTop !== previousTop) scheduleMarqueeSelectionFrame(node)
  })
}

function finishMarqueeSelection(node, event, cancelled = false) {
  const ctx = node.__bil
  const selection = ctx?.marqueeSelection
  if (!selection || (event?.pointerId != null && event.pointerId !== selection.pointerId)) return
  if (selection.frame) cancelAnimationFrame(selection.frame)
  selection.frame = 0
  if (!cancelled && event) {
    selection.clientX = event.clientX
    selection.clientY = event.clientY
    renderMarqueeSelection(node, selection)
  }
  const browser = browserForView(ctx, selection.view)
  if (cancelled && browser) {
    browser.selected = new Set(selection.baseline)
    renderSelectionContext(node)
    scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
  } else if (!selection.active && !selection.toggle && !selection.additive && browser) {
    browser.selected.clear()
    renderSelectionContext(node)
    scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
  } else if (selection.lastHitId && browser) {
    browser.focusedId = selection.lastHitId
    browser.lastSelectedId = selection.lastHitId
  }
  ctx.selectionMarquee.hidden = true
  ctx.marqueeSelection = null
  try {
    ctx.list.releasePointerCapture?.(selection.pointerId)
  } catch {
    // The pointer may already have been released by the browser.
  }
}

function cancelMarqueeSelection(node, restoreBaseline = true) {
  finishMarqueeSelection(node, null, restoreBaseline)
}

function beginMarqueeSelection(node, event) {
  const ctx = node.__bil
  if (!ctx || event.button !== 0 || event.isPrimary === false || ctx.marqueeSelection) return false
  if (event.target instanceof Element && event.target.closest('.bil-card')) return false
  const rect = ctx.list.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientY < rect.top || event.clientX > rect.right || event.clientY > rect.bottom) return false
  const browser = activeBrowser(ctx)
  ctx.marqueeSelection = {
    pointerId: event.pointerId,
    view: ctx.browser.activeView,
    anchor: marqueeContentPoint(ctx, event.clientX, event.clientY),
    anchorClientX: event.clientX,
    anchorClientY: event.clientY,
    clientX: event.clientX,
    clientY: event.clientY,
    baseline: new Set(browser.selected),
    toggle: Boolean(event.ctrlKey || event.metaKey),
    additive: Boolean(event.shiftKey),
    active: false,
    lastHitId: null,
    frame: 0
  }
  ctx.list.setPointerCapture?.(event.pointerId)
  event.preventDefault()
  return true
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
  const navigation = { entries: [], index: -1, collection: '' }
  const renderCurrent = () => {
    const entry = navigation.entries[navigation.index]
    const ctx = node.__bil
    if (!entry?.item || !ctx || ctx.removed) return false
    const item = entry.item
    const itemLabel = item.filename || item.relative_path || getItemDisplayPath(item)
    image.src = filePreviewUrl(item, ctx)
    image.alt = itemLabel
    const position = navigation.entries.length > 1
      ? `${navigation.index + 1} of ${navigation.entries.length}`
      : ''
    const context = [navigation.collection, position].filter(Boolean).join(' · ')
    label.textContent = `${itemLabel}${context ? ` · ${context}` : ''}${navigation.entries.length > 1 ? ' · ←/→ navigate' : ''}`
    label.title = label.textContent
    if (item.sourceId) lightbox.dataset.sourceId = item.sourceId
    else delete lightbox.dataset.sourceId
    return true
  }
  const navigate = (direction) => {
    const next = stepPreviewNavigationIndex(
      navigation.index,
      direction,
      navigation.entries.length
    )
    if (next < 0 || next === navigation.index) return false
    navigation.index = next
    return renderCurrent()
  }
  const hide = () => {
    lightbox.hidden = true
    image.removeAttribute('src')
    label.textContent = ''
    label.removeAttribute('title')
    navigation.entries = []
    navigation.index = -1
    navigation.collection = ''
    delete lightbox.dataset.sourceId
    restoreGraphCanvasFocus(lightbox, app.canvas?.canvas)
  }
  close.addEventListener('click', hide)
  lightbox.addEventListener('click', (event) => { if (event.target === lightbox) hide() })
  lightbox.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      consumeGalleryKeyboardEvent(event)
      navigate(event.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    if (event.key !== 'Escape') return
    consumeGalleryKeyboardEvent(event)
    hide()
  })
  document.body.appendChild(lightbox)
  const show = (nextNavigation) => {
    navigation.entries = Array.isArray(nextNavigation?.entries) ? nextNavigation.entries : []
    navigation.index = Number.isInteger(nextNavigation?.index) ? nextNavigation.index : -1
    navigation.collection = String(nextNavigation?.collection || '')
    if (!renderCurrent()) return false
    lightbox.hidden = false
    close.focus({ preventScroll: true })
    return true
  }
  return { root: lightbox, image, label, close, hide, navigate, show }
}

function previewCollectionLabel(ctx, view) {
  if (view === 'conveyor') return 'Conveyor'
  if (view === 'input') return 'Input Folder'
  const browser = browserForView(ctx, view)
  const source = browser ? ctx.browser.folderSources.get(browser.sourceId) : null
  if (!source) return 'Folder'
  return browser.folderPath ? `${source.name}/${browser.folderPath}` : source.name
}

function previewNavigationFor(node, item, options = {}) {
  const ctx = node.__bil
  const referenceIndex = Number.isInteger(options.referenceIndex) ? options.referenceIndex : null
  if (referenceIndex != null) {
    const slots = getRenderableState(node).state.reference_slots
    const currentId = `reference:${referenceIndex}`
    const result = createPreviewNavigation(
      slots.map((reference, index) => ({ id: `reference:${index}`, item: reference })),
      currentId
    )
    if (result.index >= 0) return { ...result, collection: 'Reference Shelf' }
  }

  const view = String(options.view || '')
  if (view && view === ctx.browser.activeView) {
    const currentId = options.itemId ?? getViewItemId(ctx, item, view)
    const result = createPreviewNavigation(
      (ctx.visibleItems || []).map((entry) => ({
        id: getViewItemId(ctx, entry, view),
        item: entry
      })),
      currentId
    )
    if (result.index >= 0) return { ...result, collection: previewCollectionLabel(ctx, view) }
  }

  return { entries: [{ id: 'current', item }], index: 0, collection: '' }
}

function openPreview(node, item, options = {}) {
  const ctx = node.__bil
  if (!ctx?.lightbox || !item || item.kind === 'folder') return
  ctx.lightbox.show(previewNavigationFor(node, item, options))
}

function closeImageContextMenu(ctx) {
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

function localImageProperties(ctx, item) {
  const file = item?.localFile
  if (!(file instanceof File)) return Promise.reject(new Error('Local image metadata is unavailable.'))
  const extension = String(file.name || '').split('.').at(-1)?.toUpperCase() || ''
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({
      relative_path: item.relative_path || file.name,
      filename: file.name,
      format: String(file.type || '').split('/').at(-1)?.toUpperCase() || extension,
      mode: '',
      width: image.naturalWidth,
      height: image.naturalHeight,
      frames: 1,
      size: file.size,
      mtime_ms: file.lastModified
    })
    image.onerror = () => reject(new Error('Unable to read image properties.'))
    image.src = localObjectUrl(ctx, item)
  })
}

async function requestImageProperties(node, item) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) throw new Error('The node is no longer available.')
  if (item?.localFile) return await localImageProperties(ctx, item)
  const relativePath = getInputRelativePath(item)
  if (!relativePath) throw new Error('Properties are only available for input images.')
  const params = new URLSearchParams({ relative_path: relativePath })
  const response = await api.fetchApi(`/image-conveyor/image-properties?${params.toString()}`)
  return await readJsonResponse(response, 'Unable to read image properties')
}

function imagePropertyLines(properties, item) {
  const summary = []
  const width = Number(properties?.width)
  const height = Number(properties?.height)
  if (width > 0 && height > 0) summary.push(`${width} × ${height}`)
  const format = String(properties?.format || '').trim()
  if (format) summary.push(format)
  const bytes = Number(properties?.size ?? item?.size ?? item?.localFile?.size)
  if (Number.isFinite(bytes) && bytes >= 0) summary.push(formatByteCount(bytes))
  const frames = Math.max(1, Number(properties?.frames) || 1)
  if (frames > 1) summary.push(`${frames} frames`)

  const lines = []
  if (summary.length) lines.push(summary.join(' · '))
  const modified = Number(properties?.mtime_ms ?? item?.localFile?.lastModified)
  if (modified > 0) lines.push(`Modified ${new Date(modified).toLocaleString()}`)
  const path = String(properties?.relative_path || getInputRelativePath(item) || item?.relative_path || '').trim()
  if (path) lines.push(path)
  return lines
}

function mutateConveyorContextItem(node, itemId, action) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return
  const { state, uiState } = getRenderableState(node)
  const item = state.items.find((entry) => entry.id === itemId)
  if (!item) return
  if (action === 'pending' || action === 'processed') {
    item.status = action
    if (action === 'processed') item.last_processed_at = Date.now()
  } else if (action === 'remove') {
    state.items = state.items.filter((entry) => entry.id !== itemId)
    ctx.browser.conveyor.selected.delete(itemId)
    uiState.selected_ids = uiState.selected_ids.filter((id) => id !== itemId)
    delete uiState.source_paths[itemId]
  }
  updateState(node, state, uiState)
}

function showImageContextMenu(node, item, clientX, clientY, options = {}) {
  const ctx = node.__bil
  if (!ctx || ctx.removed || !item || item.kind === 'folder') return false
  closeImageContextMenu(ctx)
  closePresetPopover(ctx)

  const menu = document.createElement('div')
  menu.className = 'bil-image-menu'
  menu.setAttribute('role', 'menu')
  menu.addEventListener('contextmenu', (event) => event.preventDefault())
  const title = document.createElement('div')
  title.className = 'bil-image-menu-title'
  title.textContent = item.filename || item.relative_path || getItemDisplayPath(item)
  const properties = document.createElement('div')
  properties.className = 'bil-image-menu-properties'
  properties.textContent = 'Loading properties…'
  menu.append(title, properties)

  const addSeparator = () => {
    const separator = document.createElement('div')
    separator.className = 'bil-image-menu-separator'
    separator.setAttribute('role', 'separator')
    menu.appendChild(separator)
  }
  const addAction = (label, handler, { danger = false } = {}) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.textContent = label
    if (danger) button.classList.add('bil-danger')
    button.addEventListener('click', async () => {
      try {
        await handler()
      } catch (error) {
        window.alert(error?.message || 'The image action failed.')
      } finally {
        closeImageContextMenu(ctx)
      }
    })
    menu.appendChild(button)
    return button
  }

  addSeparator()
  const openButton = addAction('Open image preview', () => openPreview(node, item, options))
  addAction('Copy image path', async () => {
    const path = getInputRelativePath(item) || item.relative_path || getItemDisplayPath(item)
    if (!path || !navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.')
    await navigator.clipboard.writeText(path)
  })

  const referenceIndex = Number.isInteger(options.referenceIndex) ? options.referenceIndex : null
  if (referenceIndex != null) {
    addSeparator()
    addAction('Clear reference', () => clearReferenceSlot(node, referenceIndex), { danger: true })
  } else if (options.view === 'conveyor') {
    addSeparator()
    addAction('Mark pending', () => mutateConveyorContextItem(node, options.itemId, 'pending'))
    addAction('Mark processed', () => mutateConveyorContextItem(node, options.itemId, 'processed'))
    addAction('Remove from Conveyor', () => mutateConveyorContextItem(node, options.itemId, 'remove'), { danger: true })
  } else {
    addSeparator()
    const selected = activeBrowser(ctx)?.selected
    const addSelection = selected instanceof Set && selected.has(options.itemId)
    addAction('Add to Conveyor', () => (
      addSelection
        ? addSelectedLibraryEntries(node)
        : addLibraryEntries(node, [item])
    ))
  }

  document.body.appendChild(menu)
  const x = Math.max(8, Number(clientX) || 8)
  const y = Math.max(8, Number(clientY) || 8)
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  const rect = menu.getBoundingClientRect()
  if (rect.right > innerWidth - 8) menu.style.left = `${Math.max(8, innerWidth - rect.width - 8)}px`
  if (rect.bottom > innerHeight - 8) menu.style.top = `${Math.max(8, innerHeight - rect.height - 8)}px`
  ctx.imageContextMenu = menu
  ctx.imageContextMenuSource = {
    item,
    itemId: options.itemId ?? null,
    referenceIndex: Number.isInteger(options.referenceIndex) ? options.referenceIndex : null
  }

  const pointerdown = (event) => {
    if (!menu.contains(event.target)) closeImageContextMenu(ctx)
  }
  const keydown = (event) => {
    if (event.key === 'Escape') closeImageContextMenu(ctx)
  }
  const blur = () => closeImageContextMenu(ctx)
  ctx.imageContextMenuDismiss = { pointerdown, keydown, blur }
  document.addEventListener('pointerdown', pointerdown, true)
  document.addEventListener('keydown', keydown, true)
  window.addEventListener('blur', blur)
  openButton.focus({ preventScroll: true })

  void requestImageProperties(node, item).then((result) => {
    if (ctx.imageContextMenu !== menu || ctx.removed) return
    const lines = imagePropertyLines(result, item)
    properties.replaceChildren(...(lines.length ? lines : ['Properties unavailable']).map((line) => {
      const row = document.createElement('div')
      row.textContent = line
      return row
    }))
    const nextRect = menu.getBoundingClientRect()
    if (nextRect.bottom > innerHeight - 8) menu.style.top = `${Math.max(8, innerHeight - nextRect.height - 8)}px`
  }).catch((error) => {
    if (ctx.imageContextMenu !== menu || ctx.removed) return
    properties.textContent = error?.message || 'Properties unavailable.'
  })
  return true
}

function consumeImageContextPointer(event) {
  event?.preventDefault?.()
  event?.stopPropagation?.()
  event?.stopImmediatePropagation?.()
}

const imageContextMenuCoordinator = {
  nodes: new Set(),
  windowPointerDownHandler: null,
  hookedCanvas: null,
  previousCanvasOnMouse: null,
  canvasOnMouseHandler: null,

  registerNode(node) {
    this.nodes.add(node)
    this.attachWindowCapture()
    this.ensureCanvasHook()
  },

  unregisterNode(node) {
    this.nodes.delete(node)
    if (this.nodes.size) return
    if (this.windowPointerDownHandler) {
      window.removeEventListener('pointerdown', this.windowPointerDownHandler, true)
      this.windowPointerDownHandler = null
    }
    if (this.hookedCanvas?.onMouse === this.canvasOnMouseHandler) {
      this.hookedCanvas.onMouse = this.previousCanvasOnMouse
    }
    this.hookedCanvas = null
    this.previousCanvasOnMouse = null
    this.canvasOnMouseHandler = null
  },

  attachWindowCapture() {
    if (this.windowPointerDownHandler) return
    this.windowPointerDownHandler = (event) => this.handleDomPointerDown(event)
    window.addEventListener('pointerdown', this.windowPointerDownHandler, true)
  },

  ensureCanvasHook() {
    const graphCanvas = app.canvas
    if (!graphCanvas || graphCanvas === this.hookedCanvas) return
    if (this.hookedCanvas?.onMouse === this.canvasOnMouseHandler) {
      this.hookedCanvas.onMouse = this.previousCanvasOnMouse
    }
    this.hookedCanvas = graphCanvas
    const previousCanvasOnMouse = graphCanvas.onMouse
    this.previousCanvasOnMouse = previousCanvasOnMouse
    const coordinator = this
    this.canvasOnMouseHandler = function (event) {
      if (coordinator.handleCanvasPointerDown(event)) return true
      return previousCanvasOnMouse?.call(this, event)
    }
    graphCanvas.onMouse = this.canvasOnMouseHandler
  },

  handleDomPointerDown(event) {
    if (event?.button !== 2) return false
    const target = eventOrigin(event)
    if (!(target instanceof Element)) return false
    for (const node of this.nodes) {
      const ctx = node?.__bil
      if (!ctx || ctx.removed || !ctx.root?.contains(target)) continue
      const slot = ctx.cardPool.find((entry) => (
        entry.itemId &&
        entry.item?.kind !== 'folder' &&
        entry.media?.contains(target)
      ))
      if (!slot) return false
      const item = slot.item
      const itemId = slot.itemId
      const view = ctx.browser.activeView
      const clientX = event.clientX
      const clientY = event.clientY
      consumeImageContextPointer(event)
      queueMicrotask(() => {
        if (
          node.__bil !== ctx || ctx.removed ||
          slot.item !== item || slot.itemId !== itemId
        ) return
        showImageContextMenu(node, item, clientX, clientY, { view, itemId })
      })
      return true
    }
    return false
  },

  handleCanvasPointerDown(event) {
    if (event?.button !== 2) return false
    const node = getCanvasNodeAtEvent(event)
    if (!node || !this.nodes.has(node)) return false
    const hit = referenceShelfEventHit(node, event)
    if (hit?.type !== 'slot' && hit?.type !== 'clear') return false
    const reference = getRenderableState(node).state.reference_slots[hit.index]
    if (!reference) return false
    if (!showImageContextMenu(node, reference, event.clientX, event.clientY, {
      referenceIndex: hit.index
    })) return false
    consumeImageContextPointer(event)
    return true
  }
}

function clearCardDragTargets(ctx, except = null) {
  for (const slot of ctx.cardPool) {
    if (slot.card !== except) slot.card.classList.remove('bil-drag-target')
  }
}

function clearInternalDragTarget(ctx) {
  if (!ctx) return
  clearCardDragTargets(ctx)
  ctx.dragIntent = null
  if (ctx.dropIndicator) ctx.dropIndicator.hidden = true
}

function renderInternalDragTarget(ctx, intent) {
  clearCardDragTargets(ctx)
  ctx.dropIndicator.hidden = true
  if (!intent) return
  if (intent.type === 'card') {
    const target = ctx.cardPool.find((slot) => slot.itemIndex === intent.targetIndex)
    target?.card.classList.add('bil-drag-target')
    return
  }
  const indicator = ctx.dropIndicator
  indicator.hidden = false
  if (intent.orientation === 'horizontal') {
    Object.assign(indicator.style, {
      left: `${intent.left}px`,
      top: `${intent.top - 2}px`,
      width: `${ctx.lastMetrics?.width || ctx.list.clientWidth}px`,
      height: '4px'
    })
    return
  }
  Object.assign(indicator.style, {
    left: `${intent.left - 2}px`,
    top: `${intent.top}px`,
    width: '4px',
    height: `${intent.height}px`
  })
}

function internalDragIntentAt(ctx, clientX, clientY) {
  if (!ctx.draggedId || !canReorderConveyor(ctx)) return null
  const point = marqueeContentPoint(ctx, clientX, clientY)
  return calculateGalleryDropIntent(
    ctx.visibleItems?.length || 0,
    getGalleryMetrics(ctx),
    point.x,
    point.y
  )
}

function folderViewId(sourceId, folderPath = '') {
  return `folder:${sourceId}:${normalizeRelativeSubfolder(folderPath)}`
}

function folderTabLabel(source, folderPath) {
  return folderPath ? relativeName(folderPath) : source.name
}

function createFolderTabElement(node, viewId, source, folderPath) {
  const ctx = node.__bil
  const shell = document.createElement('div')
  shell.className = 'bil-tab-shell'
  const tab = document.createElement('button')
  tab.className = 'bil-tab'
  tab.type = 'button'
  tab.id = `${ctx.tabSetId}-${viewId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  tab.setAttribute('role', 'tab')
  tab.setAttribute('aria-controls', ctx.list.id)
  const label = document.createElement('span')
  label.className = 'bil-tab-label'
  label.textContent = folderTabLabel(source, folderPath)
  const fullPath = folderPath ? `${source.name}/${folderPath}` : source.name
  tab.title = fullPath
  tab.appendChild(label)
  const close = document.createElement('button')
  close.className = 'bil-tab-close'
  close.type = 'button'
  close.textContent = '×'
  close.hidden = false
  close.setAttribute('aria-label', `Close ${fullPath} tab`)
  tab.addEventListener('click', () => switchBrowserView(node, viewId))
  close.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    closeFolderView(node, viewId)
    restoreGraphCanvasFocus(close, app.canvas?.canvas)
  })
  shell.append(tab, close)
  ctx.tabs.appendChild(shell)
  ctx.folderTabElements.set(viewId, { shell, tab, close, label })
}

function openFolderView(node, sourceId, folderPath = '') {
  const ctx = node.__bil
  const source = ctx?.browser.folderSources.get(sourceId)
  if (!ctx || !source) return
  const normalizedPath = normalizeRelativeSubfolder(folderPath)
  if (normalizedPath && !source.directories.has(normalizedPath)) return
  const viewId = folderViewId(sourceId, normalizedPath)
  if (!ctx.browser.folderViews.has(viewId)) {
    ctx.browser.folderViews.set(viewId, createFolderBrowserState(source, normalizedPath))
    ctx.browser.tabOrder.push(viewId)
    createFolderTabElement(node, viewId, source, normalizedPath)
  }
  switchBrowserView(node, viewId)
}

function addFolderSources(node, sources) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return 0
  let added = 0
  for (const source of Array.from(sources ?? [])) {
    if (!source?.id || !source?.name || !(source.directories instanceof Set) || !Array.isArray(source.files)) continue
    source.files.sort((left, right) => compareNatural(left.relativePath, right.relativePath))
    ctx.browser.folderSources.set(source.id, source)
    openFolderView(node, source.id, '')
    added += 1
  }
  return added
}

function closeFolderView(node, viewId) {
  const ctx = node.__bil
  const view = ctx?.browser.folderViews.get(viewId)
  if (!ctx || !view) return
  const nextView = chooseViewAfterClose(
    ctx.browser.tabOrder,
    ctx.browser.activeView,
    viewId,
    'input'
  )
  const wasActive = ctx.browser.activeView === viewId
  if (wasActive) {
    switchBrowserView(node, nextView)
    hideUnusedCards(ctx)
  }
  ctx.browser.folderViews.delete(viewId)
  ctx.browser.tabOrder = ctx.browser.tabOrder.filter((entry) => entry !== viewId)
  ctx.folderTabElements.get(viewId)?.shell.remove()
  ctx.folderTabElements.delete(viewId)
  const sourceStillOpen = Array.from(ctx.browser.folderViews.values())
    .some((candidate) => candidate.sourceId === view.sourceId)
  if (!sourceStillOpen) {
    if (ctx.lightbox?.root?.dataset?.sourceId === view.sourceId) ctx.lightbox.hide()
    releaseLocalSourceUrls(ctx, view.sourceId)
    ctx.browser.folderSources.delete(view.sourceId)
  }
  scheduleRenderNode(node, { forceVisibleRows: true })
}

function renderTabs(ctx) {
  const activeView = ctx.browser.activeView
  const inputSelected = activeView === 'input'
  const conveyorSelected = activeView === 'conveyor'
  ctx.conveyorTab.setAttribute('aria-selected', String(conveyorSelected))
  ctx.inputTab.setAttribute('aria-selected', String(inputSelected))
  for (const [viewId, elements] of ctx.folderTabElements) {
    const selected = viewId === activeView
    elements.tab.setAttribute('aria-selected', String(selected))
    elements.shell.classList.toggle('bil-tab-active', selected)
    elements.close.hidden = false
  }
  const activeTab = activeView === 'conveyor'
    ? ctx.conveyorTab
    : activeView === 'input'
      ? ctx.inputTab
      : ctx.folderTabElements.get(activeView)?.tab
  if (activeTab) {
    ctx.list.setAttribute('aria-labelledby', activeTab.id)
    const activeElement = activeTab.parentElement?.classList.contains('bil-tab-shell')
      ? activeTab.parentElement
      : activeTab
    const tabsRect = ctx.tabs.getBoundingClientRect()
    const activeRect = activeElement.getBoundingClientRect()
    if (activeRect.left < tabsRect.left) ctx.tabs.scrollLeft -= tabsRect.left - activeRect.left
    else if (activeRect.right > tabsRect.right) ctx.tabs.scrollLeft += activeRect.right - tabsRect.right
  }
}

function createCardSlot(node, ctx) {
  const card = document.createElement('div')
  card.className = 'bil-card'
  card.setAttribute('role', 'option')
  card.style.display = 'none'
  const slot = {
    card,
    itemId: null,
    item: null,
    itemIndex: -1,
    inputView: null,
    itemKind: '',
    label: '',
    displayPath: '',
    subfolder: '',
    previewUrl: '',
    bindToken: 0,
    layoutKey: '',
    badgeKey: '',
    selected: null,
    focused: null,
    draggable: false
  }

  card.addEventListener('dragstart', (event) => {
    if (!slot.draggable || !slot.itemId) { event.preventDefault(); return }
    const classification = classifyReferenceDrag(
      slot.item,
      ctx.browser.activeView,
      canReorderConveyor(ctx)
    )
    if (!classification) { event.preventDefault(); return }
    activeReferenceDrag = {
      node,
      item: slot.item,
      view: ctx.browser.activeView,
      classification
    }
    ctx.draggedId = classification.canReorder
      ? slot.itemId
      : null
    event.dataTransfer?.setData('application/x-image-conveyor-reference', JSON.stringify({
      kind: classification.kind,
      itemId: slot.itemId
    }))
    event.dataTransfer?.setData('text/plain', slot.itemId)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = ctx.draggedId ? 'copyMove' : 'copy'
    clearInternalDragTarget(ctx)
  })
  card.addEventListener('dragend', () => {
    ctx.draggedId = null
    activeReferenceDrag = null
    if (ctx.referenceDragHoverIndex != null) {
      ctx.referenceDragHoverIndex = null
      node.setDirtyCanvas?.(true, false)
    }
    clearInternalDragTarget(ctx)
  })

  const media = document.createElement('div')
  media.className = 'bil-media'
  media.addEventListener('click', (event) => {
    if (!slot.itemId) return
    if (slot.item?.kind === 'folder') {
      openFolderView(node, slot.item.sourceId, slot.item.folderPath)
      return
    }
    selectItemFromClick(node, slot.itemId, event)
  })
  media.addEventListener('contextmenu', (event) => {
    if (!slot.itemId || slot.item?.kind === 'folder') return
    consumeImageContextPointer(event)
    if (
      ctx.imageContextMenuSource?.item !== slot.item ||
      ctx.imageContextMenuSource?.itemId !== slot.itemId
    ) {
      showImageContextMenu(node, slot.item, event.clientX, event.clientY, {
        view: ctx.browser.activeView,
        itemId: slot.itemId
      })
    }
  })
  const thumb = document.createElement('img')
  thumb.className = 'bil-thumb'
  thumb.loading = 'lazy'
  thumb.decoding = 'async'
  thumb.draggable = false
  const folderIcon = document.createElement('div')
  folderIcon.className = 'bil-folder-icon'
  folderIcon.hidden = true
  const overlay = document.createElement('div')
  overlay.className = 'bil-card-overlay'
  const badge = document.createElement('span')
  badge.className = 'bil-badge'
  overlay.append(badge)
  media.append(thumb, folderIcon, overlay)

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
  addBtn.addEventListener('click', () => {
    if (!slot.item) return
    if (slot.item.kind === 'folder') openFolderView(node, slot.item.sourceId, slot.item.folderPath)
    else void addLibraryEntries(node, [slot.item])
  })
  actions.append(path, pendingBtn, processedBtn, deleteBtn, addBtn)
  footer.append(titleRow, actions)
  card.append(media, footer)
  Object.assign(slot, { media, thumb, folderIcon, badge, name, indexText, path, pendingBtn, processedBtn, deleteBtn, addBtn })
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

function resetCardThumbnail(slot) {
  slot.bindToken += 1
  slot.previewUrl = ''
  slot.thumbnailIdentity = ''
  slot.thumb.onload = null
  slot.thumb.onerror = null
  slot.thumb.classList.remove('bil-thumb-ready', 'bil-thumb-error')
  slot.thumb.removeAttribute('src')
}

function bindCardThumbnail(slot, url) {
  const token = ++slot.bindToken
  slot.previewUrl = url
  slot.thumb.onload = () => {
    if (token !== slot.bindToken || slot.previewUrl !== url) return
    slot.thumb.classList.remove('bil-thumb-error')
    slot.thumb.classList.add('bil-thumb-ready')
  }
  slot.thumb.onerror = () => {
    if (token !== slot.bindToken || slot.previewUrl !== url) return
    slot.thumb.classList.remove('bil-thumb-ready')
    slot.thumb.classList.add('bil-thumb-error')
  }
  slot.thumb.src = url
}

function hideUnusedCards(ctx, start = 0) {
  for (let index = start; index < ctx.cardPool.length; index += 1) {
    const slot = ctx.cardPool[index]
    slot.itemId = null; slot.item = null; slot.itemIndex = -1; slot.inputView = null; slot.itemKind = ''
    slot.layoutKey = ''; slot.badgeKey = ''; slot.selected = null; slot.focused = null
    slot.card.style.display = 'none'
    slot.card.classList.remove('bil-selected', 'bil-focused', 'bil-drag-target', 'bil-folder-card')
    slot.folderIcon.hidden = true
    resetCardThumbnail(slot)
  }
}

function updateCardSlot(node, slot, item, itemIndex, metrics, selected, annotatedCounts, uiState, allowThumbnailLoad) {
  const ctx = node.__bil
  const inputView = isLibraryView(ctx)
  const folderItem = item.kind === 'folder'
  const localItem = item.kind === 'local-image'
  const itemId = getViewItemId(ctx, item)
  const displayPath = inputView ? item.relative_path : getItemDisplayPath(item, uiState)
  const label = item.filename || item.relative_path || displayPath
  const browser = activeBrowser(ctx)
  const thumbnailIdentity = folderItem
    ? `folder:${itemId}`
    : `${itemId}:${item.source_version || item.mtime_ns || ''}:${browser.size}`
  if (slot.thumbnailIdentity !== thumbnailIdentity && (slot.previewUrl || slot.thumbnailIdentity)) resetCardThumbnail(slot)
  slot.thumbnailIdentity = thumbnailIdentity

  const subfolder = inputView ? (item.subfolder || (localItem ? 'Selected folder' : 'input root')) : ''
  const staticContentChanged = slot.itemIndex !== itemIndex ||
    slot.inputView !== inputView ||
    slot.itemKind !== item.kind ||
    slot.label !== label ||
    slot.displayPath !== displayPath ||
    slot.subfolder !== subfolder
  slot.itemId = itemId; slot.item = item
  slot.itemIndex = itemIndex; slot.inputView = inputView; slot.itemKind = item.kind || ''
  slot.label = label; slot.displayPath = displayPath; slot.subfolder = subfolder
  if (slot.card.style.display !== 'flex') slot.card.style.display = 'flex'
  const layoutKey = `${itemIndex}:${metrics.columns}:${metrics.cardWidth}:${metrics.cardHeight}`
  if (slot.layoutKey !== layoutKey) {
    const row = Math.floor(itemIndex / metrics.columns)
    const column = itemIndex % metrics.columns
    const left = column * (metrics.cardWidth + CARD_GAP)
    const top = row * metrics.rowStride
    slot.card.style.width = `${metrics.cardWidth}px`
    slot.card.style.height = `${metrics.cardHeight}px`
    slot.card.style.transform = `translate3d(${left}px, ${top}px, 0)`
    slot.layoutKey = layoutKey
  }
  const isSelected = selected.has(itemId)
  if (slot.selected !== isSelected) {
    slot.selected = isSelected
    slot.card.classList.toggle('bil-selected', isSelected)
    slot.card.setAttribute('aria-selected', String(isSelected))
  }
  const isFocused = browser.focusedId === itemId
  if (slot.focused !== isFocused) {
    slot.focused = isFocused
    slot.card.classList.toggle('bil-focused', isFocused)
  }
  if (staticContentChanged) {
    slot.card.title = displayPath
    slot.name.textContent = label
    slot.indexText.textContent = `#${itemIndex + 1}`
    slot.path.textContent = inputView ? subfolder : displayPath
    slot.path.title = slot.path.textContent
    slot.thumb.alt = label
  }
  slot.card.classList.toggle('bil-folder-card', folderItem)
  slot.folderIcon.hidden = !folderItem
  slot.thumb.hidden = folderItem
  const draggable = !folderItem
  if (slot.draggable !== draggable) {
    slot.draggable = draggable
    slot.card.draggable = draggable
  }
  if (slot.pendingBtn.hidden !== inputView) slot.pendingBtn.hidden = inputView
  if (slot.processedBtn.hidden !== inputView) slot.processedBtn.hidden = inputView
  if (slot.deleteBtn.hidden !== inputView) slot.deleteBtn.hidden = inputView
  if (slot.addBtn.hidden === inputView) slot.addBtn.hidden = !inputView
  if (inputView) slot.addBtn.textContent = folderItem ? 'Open' : '+ Add'
  if (inputView) {
    const count = localItem || folderItem ? 0 : annotatedCounts.get(item.relative_path) || 0
    const badgeKey = folderItem ? 'folder' : localItem ? 'local' : `input:${count}`
    if (slot.badgeKey !== badgeKey) {
      slot.badge.className = 'bil-badge bil-count-badge'
      slot.badge.textContent = folderItem ? 'Folder' : localItem ? 'Local' : count ? `In conveyor ×${count}` : 'Input'
      slot.badgeKey = badgeKey
    }
  } else {
    const badgeKey = `conveyor:${item.status}`
    if (slot.badgeKey !== badgeKey) {
      slot.badge.className = `bil-badge bil-badge-${item.status}`
      slot.badge.textContent = item.status
      slot.badgeKey = badgeKey
    }
  }
  if (!folderItem && allowThumbnailLoad && !slot.previewUrl) {
    const url = cachedThumbnailUrl(ctx, item, browser.size)
    if (url) bindCardThumbnail(slot, url)
  }
}

function renderVisibleCards(node) {
  const ctx = node.__bil
  if (!ctx) return
  const items = ctx.visibleItems || []
  if (!items.length) {
    if (ctx.listInner.style.height !== 'auto') ctx.listInner.style.height = 'auto'
    if (ctx.listWindow.style.height !== 'auto') ctx.listWindow.style.height = 'auto'
    activeBrowser(ctx).scrollTop = 0
    if (ctx.pendingScrollRestore?.view === ctx.browser.activeView) ctx.pendingScrollRestore = null
    if (ctx.list.scrollTop) ctx.list.scrollTop = 0
    hideUnusedCards(ctx); ctx.renderedRangeKey = ''; return
  }
  if (!isGalleryViewportMeasurable(ctx.list.clientWidth, ctx.list.clientHeight)) {
    suspendGalleryViewport(ctx)
    return
  }
  const view = ctx.browser.activeView
  if (ctx.galleryViewportSuspended) {
    ctx.galleryViewportSuspended = false
    if (ctx.pendingScrollRestore?.view !== view) {
      ctx.pendingScrollRestore = { view, scrollTop: activeBrowser(ctx).scrollTop }
    }
  }
  const metrics = getGalleryMetrics(ctx)
  ctx.lastMetrics = metrics
  const pendingRestore = ctx.pendingScrollRestore?.view === view
    ? ctx.pendingScrollRestore
    : null
  const range = getVisibleCardRange(
    ctx,
    items.length,
    metrics,
    pendingRestore?.scrollTop ?? ctx.list.scrollTop
  )
  const selected = getViewSelectedIds(node)
  const { state, uiState } = getRenderableState(node)
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
  const totalHeight = `${range.totalHeight}px`
  if (ctx.listInner.style.height !== totalHeight) ctx.listInner.style.height = totalHeight
  if (ctx.listWindow.style.height !== totalHeight) ctx.listWindow.style.height = totalHeight
  if (pendingRestore) {
    activeBrowser(ctx).scrollTop = range.scrollTop
    ctx.list.scrollTop = range.scrollTop
    ctx.scrollSampleTop = range.scrollTop
    ctx.scrollSampleAt = globalThis.performance?.now?.() ?? Date.now()
    ctx.pendingScrollRestore = null
  } else if (range.scrollTop !== ctx.list.scrollTop) {
    ctx.list.scrollTop = range.scrollTop
    activeBrowser(ctx).scrollTop = range.scrollTop
  }
  const key = `${ctx.renderVersion}:${ctx.inputVersion}:${view}:${items.length}:${metrics.width}:${metrics.columns}:${metrics.cardHeight}:${range.start}:${range.end}`
  if (ctx.renderedRangeKey === key) return
  const needed = range.end - range.start
  ensureCardPool(node, needed)
  const nextItemIds = items.slice(range.start, range.end).map((item) => getViewItemId(ctx, item, view))
  const assignments = planCardSlotReuse(ctx.cardPool.map((slot) => slot.itemId), nextItemIds)
  const assigned = new Set(assignments)
  ctx.cardPool = [
    ...assignments.map((index) => ctx.cardPool[index]),
    ...ctx.cardPool.filter((_, index) => !assigned.has(index))
  ]
  for (let offset = 0; offset < needed; offset += 1) {
    updateCardSlot(
      node,
      ctx.cardPool[offset],
      items[range.start + offset],
      range.start + offset,
      metrics,
      selected,
      annotatedCounts,
      uiState,
      !ctx.deferThumbnailLoads
    )
  }
  hideUnusedCards(ctx, needed)
  if (ctx.dragIntent) renderInternalDragTarget(ctx, ctx.dragIntent)
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
  const inputRootView = ctx.browser.activeView === 'input'
  const inputView = isLibraryView(ctx)
  const folderView = isFolderView(ctx)
  const browser = activeBrowser(ctx)
  const pending = countItemsByStatus(state, 'pending')
  const queued = countItemsByStatus(state, 'queued')
  const processed = countItemsByStatus(state, 'processed')
  const next = state.dont_consume ? findNextLoadItem(state) : findFirstByStatus(state, ['pending', 'queued'])

  ctx.conveyorTab.textContent = `Conveyor ${state.items.length}`
  ctx.inputTab.textContent = `Input Folder ${ctx.browser.input.files.length}`
  renderTabs(ctx)
  if (document.activeElement !== ctx.searchInput) ctx.searchInput.value = browser.query
  ctx.sizeSelect.value = browser.size
  ctx.conveyorFilter.hidden = inputView
  ctx.folderSelect.hidden = !inputRootView
  ctx.conveyorSort.hidden = inputView
  ctx.inputSort.hidden = !inputView
  ctx.applySortBtn.hidden = inputView
  ctx.refreshBtn.hidden = !inputRootView
  ctx.addSelectedInputBtn.hidden = !inputView
  ctx.conveyorFilter.value = ctx.browser.conveyor.filter
  if (inputRootView) ctx.folderSelect.value = ctx.browser.input.folder
  ctx.conveyorSort.value = ctx.browser.conveyor.sort
  if (inputView) ctx.inputSort.value = browser.sort
  const source = folderView ? ctx.browser.folderSources.get(browser.sourceId) : null
  const folderLabel = folderView
    ? (browser.folderPath ? `${source?.name || 'Folder'}/${browser.folderPath}` : source?.name || 'Folder')
    : ''
  ctx.summary.textContent = inputRootView
    ? `${ctx.visibleItems.length} shown · ${ctx.browser.input.files.length} images${ctx.browser.input.loading ? ' · refreshing…' : ''}${ctx.browser.input.error ? ` · ${ctx.browser.input.error}` : ''}`
    : folderView
      ? `${folderLabel} · ${ctx.visibleItems.length} item${ctx.visibleItems.length === 1 ? '' : 's'}${browser.error ? ` · ${browser.error}` : ''}`
      : `${state.items.length} total · ${pending} pending · ${queued} queued · ${processed} processed`
  const focusedIndex = browser.focusedId
    ? ctx.visibleItems.findIndex((item) => getViewItemId(ctx, item) === browser.focusedId)
    : -1
  const position = focusedIndex >= 0 ? `${focusedIndex + 1} of ${ctx.visibleItems.length}` : ''
  ctx.nextText.textContent = inputView
    ? position
    : `${next ? `Next: ${next.filename || getItemDisplayPath(next, uiState)}${state.dont_consume ? ' · not consuming' : ''}` : 'Next: none'}${position ? ` · ${position}` : ''}`
  renderSelectionContext(node)
  ctx.autoQueueCheckbox.checked = Boolean(state.auto_queue)
  ctx.dontConsumeCheckbox.checked = Boolean(state.dont_consume)
  ctx.canvasDropCheckbox.checked = Boolean(state.catch_canvas_drops)
  ctx.imagesPerExecutionSelect.value = String(normalizeImagesPerExecution(state.images_per_execution))
  ctx.outputModeSelect.value = normalizeOutputMode(state.output_mode, state.images_per_execution, true)
  ctx.imagesPerExecutionLabel.hidden = state.output_mode !== OUTPUT_MODE_QUEUE_GROUP

  if (!ctx.visibleItems.length) {
    hideUnusedCards(ctx); ctx.renderedRangeKey = ''
    ctx.listInner.style.height = 'auto'; ctx.listWindow.style.height = 'auto'
    browser.scrollTop = 0
    if (ctx.pendingScrollRestore?.view === ctx.browser.activeView) ctx.pendingScrollRestore = null
    if (ctx.list.scrollTop) ctx.list.scrollTop = 0
    if (!ctx.empty) { ctx.empty = document.createElement('div'); ctx.empty.className = 'bil-empty' }
    ctx.empty.textContent = inputRootView
      ? (ctx.browser.input.loading ? 'Loading the ComfyUI input folder…' : 'No images match this input-folder view.')
      : folderView
        ? 'No images or subfolders match this folder view.'
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

async function addLibraryEntries(node, entries) {
  const localEntries = entries.filter((entry) => entry?.kind === 'local-image' && entry.localFile)
  const inputEntries = entries.filter((entry) => entry?.kind !== 'folder' && entry?.kind !== 'local-image')
  if (inputEntries.length) addInputEntries(node, inputEntries)
  if (localEntries.length) {
    const uploadEntries = localEntries.map((entry) => ({
      file: entry.localFile,
      relativeSubfolder: entry.relativeSubfolder
    }))
    const feedbackView = node.__bil?.browser.activeView
    try {
      await uploadViaNode(node, uploadEntries, { feedbackView })
    } catch (error) {
      const ctx = node.__bil
      const browser = ctx ? browserForView(ctx, feedbackView) : null
      if (browser) {
        browser.error = error?.message || 'Import failed'
        scheduleRenderNode(node)
      }
      console.error('Image Conveyor: folder-tab import failed.', error)
    }
  }
}

async function addSelectedLibraryEntries(node) {
  const ctx = node.__bil
  if (!ctx || !isLibraryView(ctx)) return
  const browser = activeBrowser(ctx)
  const selected = browser.selected
  const entries = (ctx.browser.activeView === 'input' ? browser.files : browser.entries)
    .filter((entry) => entry.kind !== 'folder' && selected.has(getViewItemId(ctx, entry)))
  await addLibraryEntries(node, entries)
}

function switchBrowserView(node, view) {
  const ctx = node.__bil
  if (!ctx || ctx.browser.activeView === view) return
  const destination = ctx.browser[view] ?? ctx.browser.folderViews.get(view)
  if (!destination) return
  cancelMarqueeSelection(node)
  const savedScrollTops = Object.fromEntries(ctx.browser.tabOrder.map((viewId) => {
    const browser = ctx.browser[viewId] ?? ctx.browser.folderViews.get(viewId)
    return [viewId, browser?.scrollTop || 0]
  }))
  const plan = planViewScrollSwitch(
    ctx.browser.activeView,
    view,
    isGalleryViewportMeasurable(ctx.list.clientWidth, ctx.list.clientHeight)
      ? ctx.list.scrollTop
      : activeBrowser(ctx).scrollTop,
    savedScrollTops,
    ctx.pendingScrollRestore?.view ?? null
  )
  for (const [viewId, scrollTop] of Object.entries(plan.positions)) {
    const browser = ctx.browser[viewId] ?? ctx.browser.folderViews.get(viewId)
    if (browser) browser.scrollTop = scrollTop
  }
  ctx.browser.activeView = view
  ctx.pendingScrollRestore = plan.restore
  ctx.renderedRangeKey = ''
  scheduleRenderNode(node, { forceVisibleRows: true })
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

function isInteractiveWidgetControl(target) {
  return target instanceof Element && Boolean(
    target.closest('button, input, textarea, select, a[href], [contenteditable="true"]')
  )
}

function shouldRetainWidgetFocus(target) {
  const control = target instanceof Element
    ? target.closest('input, textarea, select, [contenteditable="true"]')
    : null
  if (!control) return false
  if (control instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'color', 'file', 'radio', 'range', 'reset', 'submit'].includes(control.type)
  }
  return control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement || control.isContentEditable
}

function consumeGalleryKeyboardEvent(event) {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation?.()
}

function handleGalleryKeyDown(node, event) {
  const ctx = node.__bil
  if (!ctx || isInteractiveWidgetControl(event.target)) return false
  if (isConveyorDeleteShortcut(event) && deleteSelectedConveyorItems(node)) {
    consumeGalleryKeyboardEvent(event)
    return true
  }
  if (event.key === 'Escape' && !ctx.lightbox.root.hidden) {
    consumeGalleryKeyboardEvent(event)
    ctx.lightbox.hide()
    return true
  }
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  const items = ctx.visibleItems || []
  if (!items.length) return false
  const browser = activeBrowser(ctx)
  const itemId = (item) => getViewItemId(ctx, item)
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
    case 'Enter':
      consumeGalleryKeyboardEvent(event)
      if (items[index].kind === 'folder') openFolderView(node, items[index].sourceId, items[index].folderPath)
      else openPreview(node, items[index], {
        view: ctx.browser.activeView,
        itemId: itemId(items[index])
      })
      return true
    case ' ': {
      consumeGalleryKeyboardEvent(event)
      if (items[index].kind === 'folder') return true
      const id = itemId(items[index]); const selected = getViewSelectedIds(node)
      setItemSelected(node, id, !selected.has(id), event); return true
    }
    default: return false
  }
  consumeGalleryKeyboardEvent(event)
  next = Math.max(0, Math.min(items.length - 1, next))
  browser.focusedId = itemId(items[next])
  scrollItemIntoView(node, next)
  scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
  return true
}

function buildGalleryDom(node) {
  ensureStyles()
  const root = document.createElement('div')
  root.className = 'bil-root'
  root.setAttribute('aria-label', 'Image Conveyor browser')

  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'image/*,.png,.jpg,.jpeg,.webp,.bmp,.gif,.tif,.tiff,.avif'
  fileInput.multiple = true
  fileInput.hidden = true
  const folderInput = document.createElement('input')
  folderInput.type = 'file'
  folderInput.multiple = true
  folderInput.hidden = true
  folderInput.setAttribute('webkitdirectory', '')
  folderInput.setAttribute('directory', '')

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
  conveyorTab.title = 'Conveyor'
  inputTab.title = 'ComfyUI Input Folder'
  tabs.append(conveyorTab, inputTab)
  const addImagesBtn = document.createElement('button')
  addImagesBtn.className = 'bil-btn bil-add-btn'; addImagesBtn.type = 'button'; addImagesBtn.textContent = '+ Add images'
  const addFoldersBtn = document.createElement('button')
  addFoldersBtn.className = 'bil-btn bil-add-btn'; addFoldersBtn.type = 'button'; addFoldersBtn.textContent = '+ Add folders'
  addFoldersBtn.title = 'Browse folders as tabs without importing their images'
  header.append(tabs)

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
  secondary.append(applySortBtn, addImagesBtn, addFoldersBtn, refreshBtn, addSelectedInputBtn)

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
  const outputModeLabel = document.createElement('label')
  outputModeLabel.className = 'bil-toggle'
  const outputModeText = document.createElement('span')
  outputModeText.textContent = 'Additional outputs'
  const outputModeSelect = document.createElement('select')
  outputModeSelect.className = 'bil-select'
  outputModeSelect.setAttribute('aria-label', 'Additional image output mode')
  outputModeSelect.title = 'Persistent references always advances one Conveyor image and uses only populated shelf slots whose reference outputs are connected.'
  ;[
    [OUTPUT_MODE_PERSISTENT, 'Persistent references'],
    [OUTPUT_MODE_QUEUE_GROUP, 'Queue execution group']
  ].forEach(([value, label]) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    outputModeSelect.appendChild(option)
  })
  outputModeLabel.append(outputModeText, outputModeSelect)
  const imagesPerExecutionLabel = document.createElement('label')
  imagesPerExecutionLabel.className = 'bil-toggle'
  const imagesPerExecutionText = document.createElement('span')
  imagesPerExecutionText.textContent = 'Images per execution'
  const imagesPerExecutionSelect = document.createElement('select')
  imagesPerExecutionSelect.className = 'bil-select bil-images-per-execution'
  imagesPerExecutionSelect.setAttribute('aria-label', 'Images per execution')
  imagesPerExecutionSelect.title = 'Number of consecutive Conveyor images returned by each execution. 1 keeps the normal single-image behavior; 2-9 expose additional images through ref_image_1 ... ref_image_8.'
  for (let count = 1; count <= 9; count += 1) {
    const option = document.createElement('option')
    option.value = String(count)
    option.textContent = String(count)
    imagesPerExecutionSelect.appendChild(option)
  }
  imagesPerExecutionLabel.append(imagesPerExecutionText, imagesPerExecutionSelect)
  const selectVisibleBtn = document.createElement('button'); selectVisibleBtn.className = 'bil-btn'; selectVisibleBtn.type = 'button'; selectVisibleBtn.textContent = 'Select all'
  const clearQueuedBtn = document.createElement('button'); clearQueuedBtn.className = 'bil-btn'; clearQueuedBtn.type = 'button'; clearQueuedBtn.textContent = 'Clear queued'
  const clearProcessedBtn = document.createElement('button'); clearProcessedBtn.className = 'bil-btn'; clearProcessedBtn.type = 'button'; clearProcessedBtn.textContent = 'Remove processed'
  const jumpPendingBtn = document.createElement('button'); jumpPendingBtn.className = 'bil-btn'; jumpPendingBtn.type = 'button'; jumpPendingBtn.textContent = 'Jump to next pending'
  const cleanDuplicatesBtn = document.createElement('button'); cleanDuplicatesBtn.className = 'bil-btn'; cleanDuplicatesBtn.type = 'button'; cleanDuplicatesBtn.textContent = 'Clean exact duplicates'
  cleanDuplicatesBtn.title = 'Preview and remove byte-identical redundant files from the legacy input/image_conveyor folder'
  settingsRow.append(autoQueue.label, dontConsume.label, outputModeLabel, imagesPerExecutionLabel, canvasDrop.label, selectVisibleBtn, clearQueuedBtn, clearProcessedBtn, jumpPendingBtn, cleanDuplicatesBtn)
  settings.append(settingsSummary, settingsRow)

  const list = document.createElement('div')
  list.className = 'bil-list'
  list.id = `${tabSetId}-panel`
  list.setAttribute('role', 'tabpanel')
  list.setAttribute('aria-labelledby', conveyorTab.id)
  conveyorTab.setAttribute('aria-controls', list.id)
  inputTab.setAttribute('aria-controls', list.id)
  const listInner = document.createElement('div'); listInner.className = 'bil-list-inner'
  const listWindow = document.createElement('div'); listWindow.className = 'bil-list-window'
  listWindow.setAttribute('role', 'listbox')
  listWindow.setAttribute('aria-multiselectable', 'true')
  const selectionMarquee = document.createElement('div')
  selectionMarquee.className = 'bil-selection-marquee'; selectionMarquee.hidden = true
  const dropIndicator = document.createElement('div')
  dropIndicator.className = 'bil-drop-indicator'; dropIndicator.hidden = true
  listInner.append(listWindow, selectionMarquee, dropIndicator); list.appendChild(listInner)
  root.append(fileInput, folderInput, header, browserbar, secondary, summaryRow, contextBar, settings, list)

  node.__bil = {
    root, tabs, tabSetId, dropzone: addImagesBtn, addImagesBtn, addFoldersBtn, fileInput, folderInput,
    conveyorTab, inputTab, folderTabElements: new Map(),
    searchInput, conveyorFilter, folderSelect, conveyorSort, inputSort, sizeSelect,
    applySortBtn, refreshBtn, addSelectedInputBtn, summary, nextText, contextBar,
    contextLabel, setPendingBtn, setProcessedBtn, deleteSelectedBtn, contextAddBtn,
    cleanDuplicatesBtn,
    autoQueueCheckbox: autoQueue.checkbox, dontConsumeCheckbox: dontConsume.checkbox,
    canvasDropCheckbox: canvasDrop.checkbox, outputModeSelect,
    imagesPerExecutionLabel, imagesPerExecutionSelect,
    list, listInner, listWindow, selectionMarquee, dropIndicator,
    browser: createBrowserState(), visibleItems: [], cardPool: [],
    draggedId: null, dragIntent: null, empty: null, state: null, uiState: null, renderVersion: 0,
    inputVersion: 0, renderedRangeKey: '', renderFrame: 0, renderViewportOnly: false,
    pendingScrollRestore: null,
    galleryViewportSuspended: false, galleryViewportEpoch: 0,
    deferThumbnailLoads: false, scrollSettleTimer: 0,
    scrollSampleTop: 0, scrollSampleAt: 0,
    listResizeObserver: null, widgetOuterHeight: 0, widgetInnerHeight: 0, widgetWidth: 0,
    resizeAnchorWidgetWidth: 0,
    pointerInside: false, middlePanPointerId: null, documentPasteHandler: null,
    documentMiddlePanMoveHandler: null, documentMiddlePanEndHandler: null,
    documentMarqueeMoveHandler: null, documentMarqueeEndHandler: null,
    documentFocusScopeHandler: null, windowFocusHandler: null,
    filePickerPending: false, filePickerFocusTimer: 0, filePickerFocusFrame: 0,
    inputAbortController: null, inputRequestId: 0,
    searchTimer: 0, lightbox: null, lastMetrics: null, removed: false,
    uploadDepth: 0, dropzoneLabel: '', duplicateCleanupBusy: false,
    clearExternalDragState: null, restoreCanvasShortcutFocus: null, marqueeSelection: null,
    keyboardActive: false,
    queueRevision: 0, annotatedCountsRevision: -1, annotatedCounts: new Map(),
    thumbnailUrlCache: new WeakMap(), localObjectUrls: new Map(), activePickerInput: null,
    referenceShelfLayout: null, referenceLayoutWidth: 0, referenceLayoutWidgetY: 0,
    referenceOutputGutter: 0, referenceOutputGutterKey: '', referenceDragHoverIndex: null,
    referenceDragSourceIndex: null, referenceShelfPointerDrag: null,
    referenceThumbs: new Map(), presets: [],
    presetsLoaded: false, presetsPromise: null, presetRequestId: 0,
    presetPopover: null, presetPopoverDismiss: null,
    imageContextMenu: null, imageContextMenuDismiss: null, imageContextMenuSource: null
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
  const scheduleCanvasShortcutFocusRestore = (focusOwner = null) => {
    if (ctx.removed) return
    if (ctx.filePickerFocusFrame) cancelAnimationFrame(ctx.filePickerFocusFrame)
    ctx.filePickerFocusFrame = requestAnimationFrame(() => {
      ctx.filePickerFocusFrame = 0
      if (ctx.removed) return
      restoreGraphCanvasFocus(focusOwner, app.canvas?.canvas)
    })
  }
  ctx.restoreCanvasShortcutFocus = (focusOwner = document.activeElement) => {
    restoreGraphCanvasFocus(focusOwner, app.canvas?.canvas)
  }
  const restoreFocusAfterFilePicker = () => {
    if (!ctx.filePickerPending || ctx.removed) return
    const pickerInput = ctx.activePickerInput
    ctx.filePickerPending = false
    ctx.activePickerInput = null
    clearTimeout(ctx.filePickerFocusTimer)
    ctx.filePickerFocusTimer = 0
    scheduleCanvasShortcutFocusRestore(pickerInput)
  }
  const schedulePickerFocusRestore = () => {
    if (!ctx.filePickerPending || ctx.removed) return
    clearTimeout(ctx.filePickerFocusTimer)
    ctx.filePickerFocusTimer = setTimeout(restoreFocusAfterFilePicker, 0)
  }
  const openPicker = (pickerInput) => {
    ctx.filePickerPending = true
    ctx.activePickerInput = pickerInput
    try {
      pickerInput.click()
    } catch (error) {
      ctx.filePickerPending = false
      ctx.activePickerInput = null
      throw error
    }
  }
  addImagesBtn.addEventListener('click', () => openPicker(fileInput))
  addFoldersBtn.addEventListener('click', () => openPicker(folderInput))
  fileInput.addEventListener('change', () => {
    const files = fileInput.files
    restoreFocusAfterFilePicker()
    runUpload(files)
    fileInput.value = ''
  })
  fileInput.addEventListener('cancel', restoreFocusAfterFilePicker)
  folderInput.addEventListener('change', () => {
    const sources = makePickerFolderSources(folderInput.files)
    restoreFocusAfterFilePicker()
    folderInput.value = ''
    if (!sources.length) {
      window.alert('No browsable folder was selected. Choose a folder containing files, or drag folders onto the tab bar.')
      return
    }
    addFolderSources(node, sources)
  })
  folderInput.addEventListener('cancel', restoreFocusAfterFilePicker)
  ctx.windowFocusHandler = schedulePickerFocusRestore
  window.addEventListener('focus', ctx.windowFocusHandler)
  conveyorTab.addEventListener('click', () => switchBrowserView(node, 'conveyor'))
  inputTab.addEventListener('click', () => switchBrowserView(node, 'input'))
  refreshBtn.addEventListener('click', () => void refreshInputFiles(node, { force: true }))
  addSelectedInputBtn.addEventListener('click', () => void addSelectedLibraryEntries(node))
  contextAddBtn.addEventListener('click', () => void addSelectedLibraryEntries(node))
  cleanDuplicatesBtn.addEventListener('click', () => void cleanManagedDuplicates(node))

  searchInput.addEventListener('input', () => {
    clearTimeout(ctx.searchTimer)
    const targetView = ctx.browser.activeView
    const query = searchInput.value
    ctx.searchTimer = setTimeout(() => {
      const targetBrowser = browserForView(ctx, targetView)
      if (!targetBrowser) return
      targetBrowser.query = query
      targetBrowser.scrollTop = 0
      if (ctx.browser.activeView === targetView) list.scrollTop = 0
      scheduleRenderNode(node)
    }, 70)
  })
  conveyorFilter.addEventListener('change', () => { ctx.browser.conveyor.filter = conveyorFilter.value; list.scrollTop = 0; scheduleRenderNode(node) })
  folderSelect.addEventListener('change', () => { ctx.browser.input.folder = folderSelect.value; list.scrollTop = 0; scheduleRenderNode(node) })
  inputSort.addEventListener('change', () => { if (isLibraryView(ctx)) activeBrowser(ctx).sort = inputSort.value; scheduleRenderNode(node) })
  conveyorSort.addEventListener('change', () => { ctx.browser.conveyor.sort = conveyorSort.value })
  sizeSelect.addEventListener('change', () => {
    const items = ctx.visibleItems || []
    const previous = getGalleryMetrics(ctx)
    const anchorIndex = Math.min(items.length - 1, Math.max(0, Math.floor(list.scrollTop / previous.rowStride) * previous.columns))
    const anchorId = items[anchorIndex] ? getViewItemId(ctx, items[anchorIndex]) : null
    activeBrowser(ctx).size = sizeSelect.value
    ctx.renderedRangeKey = ''
    scheduleRenderNode(node, { forceVisibleRows: true })
    requestAnimationFrame(() => {
      if (!anchorId || !node.__bil) return
      const newIndex = (ctx.visibleItems || []).findIndex((item) => getViewItemId(ctx, item) === anchorId)
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
  deleteSelectedBtn.addEventListener('click', () => deleteSelectedConveyorItems(node))
  clearSelectionBtn.addEventListener('click', () => {
    if (isLibraryView(ctx)) {
      activeBrowser(ctx).selected.clear(); renderSelectionContext(node); scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
    } else {
      ctx.browser.conveyor.selected.clear(); renderSelectionContext(node); scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
    }
  })
  selectVisibleBtn.addEventListener('click', () => {
    if (isLibraryView(ctx)) {
      const browser = activeBrowser(ctx)
      const entries = ctx.browser.activeView === 'input' ? browser.files : browser.entries
      browser.selected = new Set(entries.filter((item) => item.kind !== 'folder').map((item) => getViewItemId(ctx, item)))
      renderSelectionContext(node); scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
    } else {
      const { state } = getRenderableState(node); ctx.browser.conveyor.selected = new Set(state.items.map((item) => item.id)); renderSelectionContext(node); scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
    }
  })
  autoQueue.checkbox.addEventListener('change', () => { const { state, uiState } = getRenderableState(node); state.auto_queue = autoQueue.checkbox.checked; updateState(node, state, uiState) })
  dontConsume.checkbox.addEventListener('change', () => { const { state, uiState } = getRenderableState(node); state.dont_consume = dontConsume.checkbox.checked; updateState(node, state, uiState) })
  outputModeSelect.addEventListener('change', () => {
    const { state, uiState } = getRenderableState(node)
    state.output_mode = normalizeOutputMode(outputModeSelect.value, state.images_per_execution, true)
    updateQueueWidget(node, null)
    updateState(node, state, uiState)
  })
  imagesPerExecutionSelect.addEventListener('change', () => {
    const { state, uiState } = getRenderableState(node)
    state.images_per_execution = normalizeImagesPerExecution(imagesPerExecutionSelect.value)
    imagesPerExecutionSelect.value = String(state.images_per_execution)
    updateState(node, state, uiState)
  })
  canvasDrop.checkbox.addEventListener('change', () => { const { state, uiState } = getRenderableState(node); state.catch_canvas_drops = canvasDrop.checkbox.checked; updateState(node, state, uiState) })
  clearQueuedBtn.addEventListener('click', () => { const { state, uiState } = getRenderableState(node); for (const item of state.items) if (item.status === 'queued') item.status = 'pending'; updateState(node, state, uiState) })
  clearProcessedBtn.addEventListener('click', () => {
    const { state, uiState } = getRenderableState(node); const kept = state.items.filter((item) => item.status !== 'processed'); const ids = new Set(kept.map((item) => item.id)); state.items = kept
    uiState.selected_ids = uiState.selected_ids.filter((id) => ids.has(id)); uiState.source_paths = Object.fromEntries(Object.entries(uiState.source_paths).filter(([id]) => ids.has(id))); updateState(node, state, uiState)
  })
  jumpPendingBtn.addEventListener('click', () => {
    if (ctx.browser.activeView !== 'conveyor') {
      switchBrowserView(node, 'conveyor')
    }
    ctx.browser.conveyor.query = ''
    ctx.browser.conveyor.filter = 'all'
    ctx.visibleItems = getViewItems(node)
    const index = ctx.visibleItems.findIndex((item) => item.status === 'pending')
    if (index >= 0) {
      ctx.browser.conveyor.focusedId = ctx.visibleItems[index].id
      const metrics = getGalleryMetrics(ctx)
      const scrollTop = Math.floor(index / metrics.columns) * metrics.rowStride
      ctx.browser.conveyor.scrollTop = scrollTop
      ctx.pendingScrollRestore = { view: 'conveyor', scrollTop }
    }
    scheduleRenderNode(node, { forceVisibleRows: true })
  })

  list.addEventListener('scroll', () => {
    if (
      ctx.galleryViewportSuspended ||
      !isGalleryViewportMeasurable(list.clientWidth, list.clientHeight)
    ) {
      suspendGalleryViewport(ctx)
      return
    }
    if (ctx.pendingScrollRestore?.view === ctx.browser.activeView) return
    const now = globalThis.performance?.now?.() ?? Date.now()
    const previousAt = ctx.scrollSampleAt
    const previousTop = ctx.scrollSampleTop
    ctx.scrollSampleTop = list.scrollTop
    ctx.scrollSampleAt = now
    if (previousAt && (ctx.deferThumbnailLoads || isHighVelocityScroll(
      list.scrollTop - previousTop,
      now - previousAt,
      ctx.lastMetrics?.rowStride
    ))) {
      ctx.deferThumbnailLoads = true
      clearTimeout(ctx.scrollSettleTimer)
      ctx.scrollSettleTimer = setTimeout(() => {
        if (ctx.removed) return
        ctx.deferThumbnailLoads = false
        ctx.renderedRangeKey = ''
        scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
      }, FAST_SCROLL_SETTLE_MS)
    }
    activeBrowser(ctx).scrollTop = list.scrollTop
    scheduleRenderNode(node, { viewportOnly: true })
  }, { passive: true })
  ctx.documentFocusScopeHandler = (event) => {
    if (!(event.target instanceof Node) || !root.contains(event.target)) releaseGalleryKeyboardOwnership(node)
  }
  document.addEventListener('pointerdown', ctx.documentFocusScopeHandler, true)

  if (typeof ResizeObserver === 'function') {
    ctx.listResizeObserver = new ResizeObserver(() => {
      if (!isGalleryViewportMeasurable(list.clientWidth, list.clientHeight)) {
        suspendGalleryViewport(ctx)
        return
      }
      const previousWidgetWidth = ctx.resizeAnchorWidgetWidth || ctx.widgetWidth
      const currentWidgetWidth = ctx.widgetWidth
      ctx.resizeAnchorWidgetWidth = currentWidgetWidth
      const resuming = ctx.galleryViewportSuspended
      if (resuming && ctx.pendingScrollRestore?.view !== ctx.browser.activeView) {
        ctx.pendingScrollRestore = {
          view: ctx.browser.activeView,
          scrollTop: activeBrowser(ctx).scrollTop
        }
      }
      const previous = ctx.lastMetrics
      const items = ctx.visibleItems || []
      const anchorIndex = previous
        ? Math.min(items.length - 1, Math.max(0, Math.floor(list.scrollTop / previous.rowStride) * previous.columns))
        : -1
      const anchorId = anchorIndex >= 0
        ? getViewItemId(ctx, items[anchorIndex])
        : null
      ctx.renderedRangeKey = ''
      scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
      if (resuming) return
      if (anchorId && previous && shouldReanchorGalleryResize(
        previousWidgetWidth,
        currentWidgetWidth,
        previous.width,
        Math.floor(list.clientWidth || 0)
      )) {
        const view = ctx.browser.activeView
        const viewportEpoch = ctx.galleryViewportEpoch
        requestAnimationFrame(() => {
          if (
            ctx.removed ||
            ctx.browser.activeView !== view ||
            ctx.galleryViewportEpoch !== viewportEpoch ||
            !isGalleryViewportMeasurable(list.clientWidth, list.clientHeight)
          ) return
          const index = (ctx.visibleItems || []).findIndex((item) => getViewItemId(ctx, item) === anchorId)
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
  list.addEventListener('pointerdown', (event) => { beginMarqueeSelection(node, event) })
  list.addEventListener('dragover', (event) => {
    if (!ctx.draggedId) return
    const intent = internalDragIntentAt(ctx, event.clientX, event.clientY)
    if (!intent) { clearInternalDragTarget(ctx); return }
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    ctx.dragIntent = intent
    renderInternalDragTarget(ctx, intent)
  })
  list.addEventListener('dragleave', (event) => {
    if (!ctx.draggedId) return
    if (event.relatedTarget instanceof Node && list.contains(event.relatedTarget)) return
    clearInternalDragTarget(ctx)
  })
  list.addEventListener('drop', (event) => {
    if (!ctx.draggedId) return
    const draggedId = ctx.draggedId
    const intent = internalDragIntentAt(ctx, event.clientX, event.clientY) || ctx.dragIntent
    event.preventDefault()
    event.stopPropagation()
    ctx.draggedId = null
    clearInternalDragTarget(ctx)
    if (!intent) return
    const { state, uiState } = getRenderableState(node)
    const changed = intent.type === 'card'
      ? moveItems(state, draggedId, ctx.visibleItems?.[intent.targetIndex]?.id)
      : moveItemToInsertionIndex(state, draggedId, intent.insertionIndex)
    if (changed) updateState(node, state, uiState)
  })
  root.addEventListener('pointerdown', (event) => {
    claimGalleryKeyboardOwnership(node)
    if (event.button === 1) { if (!app.canvas) return; ctx.middlePanPointerId = event.pointerId; event.preventDefault(); app.canvas.processMouseDown(event); return }
  }, true)
  root.addEventListener('click', (event) => {
    if (shouldRetainWidgetFocus(event.target)) return
    restoreGraphCanvasFocus(document.activeElement, app.canvas?.canvas)
  })
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
  ctx.documentMarqueeMoveHandler = (event) => {
    const selection = ctx.marqueeSelection
    if (!selection || event.pointerId !== selection.pointerId) return
    selection.clientX = event.clientX
    selection.clientY = event.clientY
    if (selection.active || Math.hypot(
      event.clientX - selection.anchorClientX,
      event.clientY - selection.anchorClientY
    ) >= MARQUEE_DRAG_THRESHOLD) event.preventDefault()
    scheduleMarqueeSelectionFrame(node)
  }
  ctx.documentMarqueeEndHandler = (event) => {
    if (!ctx.marqueeSelection || event.pointerId !== ctx.marqueeSelection.pointerId) return
    finishMarqueeSelection(node, event, event.type === 'pointercancel')
  }
  document.addEventListener('pointermove', ctx.documentMarqueeMoveHandler, true)
  document.addEventListener('pointerup', ctx.documentMarqueeEndHandler, true)
  document.addEventListener('pointercancel', ctx.documentMarqueeEndHandler, true)

  ctx.documentPasteHandler = (event) => {
    if (event.defaultPrevented || isModifiedPlainTextPaste(event) || shouldIgnoreClipboardPasteTarget(event.target)) return
    if (!(ctx.pointerInside || ctx.keyboardActive || root.contains(document.activeElement))) return
    const files = getClipboardImageFiles(event); if (!files.length) return
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.(); runUpload(files)
  }
  document.addEventListener('paste', ctx.documentPasteHandler, true)

  let externalDragDepth = 0
  const isFolderTabDropTarget = (target) => target instanceof Node && tabs.contains(target)
  const setDragActive = (active, folderReady = false, folderHover = false) => {
    root.classList.toggle('bil-dragover', active)
    tabs.classList.toggle('bil-folder-drop-ready', active && folderReady)
    tabs.classList.toggle('bil-folder-drop-hover', active && folderReady && folderHover)
    if (!active) clearCardDragTargets(ctx)
  }
  const clearExternalDragState = () => { externalDragDepth = 0; setDragActive(false) }
  ctx.clearExternalDragState = clearExternalDragState
  root.addEventListener('dragenter', (event) => { if (!consumeExternalFileDrag(event) && !activatePotentialExternalFileDrag(event)) return; externalDragDepth += 1; const folderReady = hasExternalDirectoryDrag(event); setDragActive(true, folderReady, isFolderTabDropTarget(event.target)) }, true)
  root.addEventListener('dragover', (event) => { if (!consumeExternalFileDrag(event) && !activatePotentialExternalFileDrag(event)) return; const folderReady = hasExternalDirectoryDrag(event); setDragActive(true, folderReady, isFolderTabDropTarget(event.target)) }, true)
  root.addEventListener('dragleave', (event) => { if (!(externalDragDepth > 0 || hasExternalFileDrag(event))) return; event.preventDefault(); event.stopPropagation(); externalDragDepth = Math.max(0, externalDragDepth - 1); if (!externalDragDepth) setDragActive(false) }, true)
  root.addEventListener('drop', async (event) => {
    if (!hasExternalFileDrag(event)) { clearExternalDragState(); return }
    const folderTarget = isFolderTabDropTarget(event.target)
    finalizeExternalFileDrag(event)
    const pending = folderTarget ? getDroppedFolderSources(event) : getDroppedImageFiles(event)
    clearExternalDragState()
    claimGalleryKeyboardOwnership(node)
    ctx.restoreCanvasShortcutFocus?.()
    const entries = await pending
    if (folderTarget) {
      if (entries.length) addFolderSources(node, entries)
      else window.alert('Drop one or more folders onto the tab bar. Image files dropped there are not added to the Conveyor.')
    } else if (entries.length) runUpload(entries)
  }, true)
  root.addEventListener('dragend', clearExternalDragState, true)

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
 * @param {{feedbackView?: string}} [options] - Browser view that receives import errors.
 * @returns {boolean} `true` if one or more files were uploaded and applied to the node state, `false` if the node widget context is missing or no valid image files were provided.
 */
async function uploadViaNode(node, files, { feedbackView = 'input' } = {}) {
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
    for (const entry of uploaded) {
      const item = makeItemFromUploadResponse(entry)
      if (!item) continue
      state.items.push(item)
      const runtimeSourcePath = normalizeSourcePath(entry?.source_path)
      if (runtimeSourcePath) uiState.source_paths[item.id] = runtimeSourcePath
    }
    mergeUploadedInputMetadata(ctx, uploaded)
    const feedbackBrowser = browserForView(ctx, feedbackView) ?? ctx.browser.input
    if (uploaded.length && !errors.length) feedbackBrowser.error = ''
    if (uploaded.length) updateState(node, state, uiState)
    if (errors.length) {
      const firstFailure = errors[0].error.message
      feedbackBrowser.error = errors.length === 1
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

async function presetRequest(path = '', options = {}) {
  const response = await api.fetchApi(`/image-conveyor/reference-presets${path}`, options)
  return readJsonResponse(response, 'Reference preset request failed')
}

async function loadReferencePresets(node, { force = false } = {}) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return []
  if (ctx.presetsLoaded && !force) return ctx.presets
  if (ctx.presetsPromise && !force) return ctx.presetsPromise
  const requestId = ++ctx.presetRequestId
  const request = presetRequest().then((payload) => {
    if (node.__bil !== ctx || ctx.removed || requestId !== ctx.presetRequestId) return ctx.presets
    ctx.presets = Array.isArray(payload?.presets)
      ? payload.presets.map((preset) => ({
          ...preset,
          slots: normalizeReferenceSlots(preset?.slots)
        }))
      : []
    ctx.presetsLoaded = true
    node.setDirtyCanvas?.(true, true)
    return ctx.presets
  }).finally(() => {
    if (node.__bil === ctx && ctx.presetsPromise === request) ctx.presetsPromise = null
  })
  ctx.presetsPromise = request
  return request
}

function activeReferencePreset(ctx, state) {
  const id = String(state?.active_reference_preset_id ?? '')
  return ctx.presets.find((preset) => preset?.id === id) ?? null
}

function hydrateReferencePresetName(node, state) {
  const ctx = node.__bil
  if (!ctx || ctx.removed || !String(state?.active_reference_preset_id ?? '').trim()) return
  queueMicrotask(() => {
    if (node.__bil !== ctx || ctx.removed) return
    void loadReferencePresets(node).catch((error) => {
      if (node.__bil !== ctx || ctx.removed) return
      console.warn('Image Conveyor: unable to load reference preset names.', error)
    })
  })
}

async function createReferencePreset(node, name, slots) {
  const payload = await presetRequest('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, slots: normalizeReferenceSlots(slots) })
  })
  await loadReferencePresets(node, { force: true })
  return payload?.preset ?? null
}

async function updateReferencePreset(node, presetId, changes) {
  const payload = await presetRequest(`/${encodeURIComponent(presetId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes)
  })
  await loadReferencePresets(node, { force: true })
  return payload?.preset ?? null
}

function loadPresetIntoNode(node, preset) {
  const snapshot = loadPresetSnapshot(preset)
  if (!snapshot.activePresetId) return false
  const { state, uiState } = getRenderableState(node)
  state.reference_slots = snapshot.slots
  state.active_reference_preset_id = snapshot.activePresetId
  updateState(node, state, uiState)
  node.setDirtyCanvas?.(true, true)
  return true
}

async function saveActiveReferencePreset(node) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return
  try {
    await loadReferencePresets(node)
    if (node.__bil !== ctx || ctx.removed) return
    const state = ctx.state ?? getRenderableState(node).state
    const active = activeReferencePreset(ctx, state)
    let preset
    if (active) {
      preset = await updateReferencePreset(node, active.id, {
        slots: normalizeReferenceSlots(state.reference_slots)
      })
    } else {
      const name = window.prompt('Character preset name:')
      if (!name?.trim()) return
      preset = await createReferencePreset(node, name, state.reference_slots)
    }
    if (node.__bil !== ctx || ctx.removed) return
    if (!preset) return
    const latest = getRenderableState(node)
    latest.state.active_reference_preset_id = preset.id
    updateState(node, latest.state, latest.uiState)
  } catch (error) {
    if (node.__bil !== ctx || ctx.removed) return
    window.alert(error?.message || 'Unable to save the character preset.')
  }
}

function closePresetPopover(ctx) {
  if (ctx?.presetPopoverDismiss) {
    document.removeEventListener('pointerdown', ctx.presetPopoverDismiss.pointerdown, true)
    document.removeEventListener('keydown', ctx.presetPopoverDismiss.keydown, true)
    ctx.presetPopoverDismiss = null
  }
  ctx?.presetPopover?.remove?.()
  if (ctx) ctx.presetPopover = null
}

async function showPresetPopover(node, clientX, clientY) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return
  closePresetPopover(ctx)
  try {
    await loadReferencePresets(node)
  } catch (error) {
    window.alert(error?.message || 'Unable to load character presets.')
    return
  }
  if (node.__bil !== ctx || ctx.removed) return
  const popover = document.createElement('div')
  popover.className = 'bil-reference-preset-popover'
  Object.assign(popover.style, {
    position: 'fixed', zIndex: '100001', left: `${Math.max(8, clientX)}px`,
    top: `${Math.max(8, clientY)}px`, width: '260px', padding: '9px',
    border: '1px solid rgba(255,255,255,.22)', borderRadius: '9px',
    background: 'rgba(28,28,32,.98)', color: '#eee', boxShadow: '0 12px 34px rgba(0,0,0,.45)',
    font: '12px/1.35 system-ui,sans-serif'
  })
  const select = document.createElement('select')
  select.className = 'bil-select'
  select.style.width = '100%'
  const empty = document.createElement('option')
  empty.value = ''
  empty.textContent = ctx.presets.length ? 'Choose character…' : 'No saved characters'
  select.appendChild(empty)
  const { state } = getRenderableState(node)
  for (const preset of ctx.presets) {
    const option = document.createElement('option')
    option.value = preset.id
    option.textContent = preset.name
    select.appendChild(option)
  }
  select.value = activeReferencePreset(ctx, state)?.id ?? ''
  const actions = document.createElement('div')
  Object.assign(actions.style, { display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '8px' })
  const button = (label, handler) => {
    const element = document.createElement('button')
    element.className = 'bil-btn'
    element.type = 'button'
    element.textContent = label
    element.addEventListener('click', () => void handler())
    actions.appendChild(element)
    return element
  }
  const selectedPreset = () => ctx.presets.find((preset) => preset.id === select.value) ?? null
  button('Load', async () => {
    const preset = selectedPreset()
    if (preset) loadPresetIntoNode(node, preset)
    closePresetPopover(ctx)
  })
  button('New', async () => {
    const name = window.prompt('New character preset name:')
    if (!name?.trim()) return
    try {
      const preset = await createReferencePreset(node, name, Array(REFERENCE_SLOT_COUNT).fill(null))
      if (preset) loadPresetIntoNode(node, preset)
      closePresetPopover(ctx)
    } catch (error) { window.alert(error?.message || 'Unable to create the preset.') }
  })
  button('Save as…', async () => {
    const name = window.prompt('Save current references as:')
    if (!name?.trim()) return
    try {
      const current = getRenderableState(node).state
      const preset = await createReferencePreset(node, name, current.reference_slots)
      if (preset) {
        const latest = getRenderableState(node)
        latest.state.active_reference_preset_id = preset.id
        updateState(node, latest.state, latest.uiState)
      }
      closePresetPopover(ctx)
    } catch (error) { window.alert(error?.message || 'Unable to save the preset.') }
  })
  button('Rename', async () => {
    const preset = selectedPreset()
    if (!preset) return
    const name = window.prompt('Rename character preset:', preset.name)
    if (!name?.trim() || name.trim() === preset.name) return
    try {
      await updateReferencePreset(node, preset.id, { name })
      closePresetPopover(ctx)
    } catch (error) { window.alert(error?.message || 'Unable to rename the preset.') }
  })
  button('Duplicate', async () => {
    const preset = selectedPreset()
    if (!preset) return
    const name = window.prompt('Duplicate preset as:', `${preset.name} copy`)
    if (!name?.trim()) return
    try {
      const duplicate = await createReferencePreset(node, name, preset.slots)
      if (duplicate) loadPresetIntoNode(node, duplicate)
      closePresetPopover(ctx)
    } catch (error) { window.alert(error?.message || 'Unable to duplicate the preset.') }
  })
  button('Delete', async () => {
    const preset = selectedPreset()
    if (!preset || !window.confirm(`Delete character preset '${preset.name}'? Image files will not be deleted.`)) return
    try {
      await presetRequest(`/${encodeURIComponent(preset.id)}`, { method: 'DELETE' })
      await loadReferencePresets(node, { force: true })
      const snapshot = getRenderableState(node)
      if (snapshot.state.active_reference_preset_id === preset.id) {
        snapshot.state.active_reference_preset_id = ''
        updateState(node, snapshot.state, snapshot.uiState)
      }
      closePresetPopover(ctx)
    } catch (error) { window.alert(error?.message || 'Unable to delete the preset.') }
  })
  button('Close', async () => closePresetPopover(ctx))
  popover.append(select, actions)
  document.body.appendChild(popover)
  const rect = popover.getBoundingClientRect()
  if (rect.right > innerWidth - 8) popover.style.left = `${Math.max(8, innerWidth - rect.width - 8)}px`
  if (rect.bottom > innerHeight - 8) popover.style.top = `${Math.max(8, innerHeight - rect.height - 8)}px`
  ctx.presetPopover = popover
  const pointerdown = (event) => {
    if (!popover.contains(event.target)) closePresetPopover(ctx)
  }
  const keydown = (event) => {
    if (event.key === 'Escape') closePresetPopover(ctx)
  }
  ctx.presetPopoverDismiss = { pointerdown, keydown }
  document.addEventListener('pointerdown', pointerdown, true)
  document.addEventListener('keydown', keydown, true)
  select.focus({ preventScroll: true })
}

function roundedRect(context, x, y, width, height, radius = 6) {
  if (typeof context.roundRect === 'function') {
    context.beginPath()
    context.roundRect(x, y, width, height, radius)
    return
  }
  context.beginPath()
  context.rect(x, y, width, height)
}

function referenceThumbnail(ctx, node, reference) {
  const key = reference?.annotated || ''
  if (!key) return null
  const existing = ctx.referenceThumbs.get(key)
  if (existing) return existing
  const image = new Image()
  const entry = { image, ready: false, failed: false }
  image.onload = () => { entry.ready = true; node.setDirtyCanvas?.(true, false) }
  image.onerror = () => { entry.failed = true; node.setDirtyCanvas?.(true, false) }
  image.src = thumbnailUrl(reference, 'small')
  ctx.referenceThumbs.set(key, entry)
  return entry
}

function drawContainedImage(context, image, x, y, width, height) {
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight)
}

function drawReferenceShelf(node, context) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return
  const { state } = getRenderableState(node)
  if (state.output_mode !== OUTPUT_MODE_PERSISTENT) {
    ctx.referenceShelfLayout = null
    ctx.referenceShelfPointerDrag = null
    ctx.referenceDragSourceIndex = null
    ctx.referenceDragHoverIndex = null
    return
  }
  const outputGutterKey = JSON.stringify(
    (node.outputs ?? []).map((output) => String(output?.label || output?.name || ''))
  )
  if (ctx.referenceOutputGutterKey !== outputGutterKey) {
    ctx.referenceOutputGutter = 72
    for (const output of node.outputs ?? []) {
      ctx.referenceOutputGutter = Math.max(
        ctx.referenceOutputGutter,
        context.measureText(String(output?.label || output?.name || '')).width + 30
      )
    }
    ctx.referenceOutputGutterKey = outputGutterKey
    ctx.referenceShelfLayout = null
  }
  const widgetY = getFiniteNumber(node.__bilWidget?.y, node.__bilWidget?.last_y)
  const nodeWidth = getFiniteNumber(node.size?.[0])
  if (
    !ctx.referenceShelfLayout ||
    ctx.referenceLayoutWidth !== nodeWidth ||
    ctx.referenceLayoutWidgetY !== widgetY
  ) {
    ctx.referenceShelfLayout = calculateReferenceShelfLayout(
      nodeWidth,
      widgetY,
      ctx.referenceOutputGutter,
      30
    )
    ctx.referenceLayoutWidth = nodeWidth
    ctx.referenceLayoutWidgetY = widgetY
  }
  const layout = ctx.referenceShelfLayout
  if (!layout.usable) return
  const characterLabel = referencePresetDisplay(
    ctx.presets,
    ctx.presetsLoaded,
    state.active_reference_preset_id,
    state.reference_slots
  ).label
  context.save()
  context.font = '12px sans-serif'
  context.textBaseline = 'middle'
  context.fillStyle = 'rgba(255,255,255,.82)'
  context.fillText(`Character: ${characterLabel}`, layout.left + 4, layout.top + layout.headerHeight / 2)
  context.textAlign = 'center'
  const menuWidth = Math.min(54, layout.width * 0.18)
  const saveWidth = Math.min(52, layout.width * 0.18)
  context.fillStyle = 'rgba(255,255,255,.07)'
  roundedRect(context, layout.right - menuWidth - saveWidth, layout.top + 2, saveWidth - 4, layout.headerHeight - 4, 5)
  context.fill()
  roundedRect(context, layout.right - menuWidth, layout.top + 2, menuWidth - 4, layout.headerHeight - 4, 5)
  context.fill()
  context.fillStyle = 'rgba(255,255,255,.86)'
  context.fillText('Save', layout.right - menuWidth - saveWidth / 2 - 2, layout.top + layout.headerHeight / 2)
  context.fillText('•••', layout.right - menuWidth / 2 - 2, layout.top + layout.headerHeight / 2)
  for (let index = 0; index < REFERENCE_SLOT_COUNT; index += 1) {
    const reference = state.reference_slots[index]
    const slot = layout.slots[index]
    roundedRect(context, slot.x, slot.y, slot.width, slot.height, 6)
    context.fillStyle = ctx.referenceDragSourceIndex === index
      ? 'rgba(75,140,220,.22)'
      : reference ? 'rgba(0,0,0,.30)' : 'rgba(255,255,255,.035)'
    context.fill()
    context.strokeStyle = ctx.referenceDragHoverIndex === index
      ? 'rgba(110,180,255,.98)'
      : ctx.referenceDragSourceIndex === index
        ? 'rgba(110,180,255,.62)'
      : 'rgba(255,255,255,.15)'
    context.lineWidth = ctx.referenceDragHoverIndex === index ? 2 : 1
    context.stroke()
    if (reference) {
      const thumbnail = referenceThumbnail(ctx, node, reference)
      if (thumbnail?.ready) {
        context.save()
        roundedRect(context, slot.x + 2, slot.y + 2, slot.width - 4, slot.height - 4, 5)
        context.clip()
        drawContainedImage(context, thumbnail.image, slot.x + 2, slot.y + 2, slot.width - 4, slot.height - 4)
        context.restore()
      }
      context.fillStyle = 'rgba(12,12,14,.78)'
      context.fillRect(slot.x + slot.width - 17, slot.y, 17, 17)
      context.fillStyle = '#fff'
      context.fillText('×', slot.x + slot.width - 8.5, slot.y + 8.5)
    }
    context.textAlign = 'left'
    context.fillStyle = 'rgba(255,255,255,.88)'
    context.fillText(`Ref ${index + 1}`, slot.x + 5, slot.y + slot.height - 10)
    context.textAlign = 'center'
  }
  for (const key of ctx.referenceThumbs.keys()) {
    let retained = false
    for (const reference of state.reference_slots) {
      if (reference?.annotated === key) {
        retained = true
        break
      }
    }
    if (!retained) ctx.referenceThumbs.delete(key)
  }
  context.restore()
}

function eventNodePoint(node, event, localPosition = null) {
  if (Array.isArray(localPosition) && localPosition.length >= 2) {
    return { x: Number(localPosition[0]), y: Number(localPosition[1]) }
  }
  try { app.canvas?.adjustMouseEvent?.(event) } catch {}
  const canvasX = Number(event?.canvasX)
  const canvasY = Number(event?.canvasY)
  if (!Number.isFinite(canvasX) || !Number.isFinite(canvasY)) return null
  return { x: canvasX - Number(node.pos?.[0] || 0), y: canvasY - Number(node.pos?.[1] || 0) }
}

function referenceShelfEventHit(node, event, localPosition = null) {
  const ctx = node.__bil
  const state = ctx ? getRenderableState(node).state : null
  if (!ctx?.referenceShelfLayout || state?.output_mode !== OUTPUT_MODE_PERSISTENT) return null
  const point = eventNodePoint(node, event, localPosition)
  return point ? referenceShelfHit(ctx.referenceShelfLayout, point.x, point.y) : null
}

function beginReferenceShelfPointerDrag(node, event, localPosition, index) {
  const ctx = node.__bil
  const reference = ctx ? getRenderableState(node).state.reference_slots[index] : null
  const point = eventNodePoint(node, event, localPosition)
  if (!ctx || !reference || !point) return false
  ctx.referenceShelfPointerDrag = {
    pointerId: event?.pointerId ?? null,
    fromIndex: index,
    targetIndex: index,
    startX: point.x,
    startY: point.y,
    active: false
  }
  ctx.referenceDragSourceIndex = index
  ctx.referenceDragHoverIndex = null
  node.setDirtyCanvas?.(true, false)
  return true
}

function updateReferenceShelfPointerDrag(node, event, localPosition = null) {
  const ctx = node.__bil
  const drag = ctx?.referenceShelfPointerDrag
  if (!drag || (drag.pointerId != null && event?.pointerId != null && drag.pointerId !== event.pointerId)) return false
  if (Number.isFinite(event?.buttons) && (event.buttons & 1) === 0) {
    finishReferenceShelfPointerDrag(node, event)
    return true
  }
  const point = eventNodePoint(node, event, localPosition)
  if (!point) return true
  if (!drag.active && Math.hypot(point.x - drag.startX, point.y - drag.startY) >= MARQUEE_DRAG_THRESHOLD) {
    drag.active = true
  }
  let targetIndex = null
  if (drag.active) {
    const hit = referenceShelfHit(ctx.referenceShelfLayout, point.x, point.y)
    if (hit?.type === 'slot' || hit?.type === 'clear') targetIndex = hit.index
  }
  drag.targetIndex = targetIndex
  if (ctx.referenceDragHoverIndex !== targetIndex) {
    ctx.referenceDragHoverIndex = targetIndex
    node.setDirtyCanvas?.(true, false)
  }
  event.preventDefault?.()
  event.stopPropagation?.()
  return true
}

function finishReferenceShelfPointerDrag(node, event = null) {
  const ctx = node.__bil
  const drag = ctx?.referenceShelfPointerDrag
  if (!drag || (drag.pointerId != null && event?.pointerId != null && drag.pointerId !== event.pointerId)) return false
  ctx.referenceShelfPointerDrag = null
  ctx.referenceDragSourceIndex = null
  ctx.referenceDragHoverIndex = null
  if (drag.active && drag.targetIndex != null && drag.targetIndex !== drag.fromIndex) {
    const { state, uiState } = getRenderableState(node)
    state.reference_slots = moveReferenceSlot(state.reference_slots, drag.fromIndex, drag.targetIndex)
    updateState(node, state, uiState)
  } else {
    node.setDirtyCanvas?.(true, false)
  }
  event?.preventDefault?.()
  event?.stopPropagation?.()
  return true
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
  imageContextMenuCoordinator.registerNode(node)

  chainNodeCallback(node, 'onDrawForeground', function (context) {
    drawReferenceShelf(node, context)
  })

  const previousMouseDown = node.onMouseDown
  node.onMouseDown = function (event, localPosition, graphCanvas) {
    const hit = referenceShelfEventHit(node, event, localPosition)
    if (hit) {
      if (event.button === 2 && (hit.type === 'slot' || hit.type === 'clear')) {
        const reference = getRenderableState(node).state.reference_slots[hit.index]
        if (reference) {
          showImageContextMenu(node, reference, event.clientX, event.clientY, { referenceIndex: hit.index })
          event.preventDefault?.()
          event.stopPropagation?.()
          return true
        }
      }
      if (event.button !== 0) return previousMouseDown?.call(this, event, localPosition, graphCanvas)
      if (hit.type === 'clear') clearReferenceSlot(node, hit.index)
      else if (hit.type === 'slot') {
        beginReferenceShelfPointerDrag(node, event, localPosition, hit.index)
      } else if (hit.type === 'save') {
        void saveActiveReferencePreset(node)
      } else {
        void showPresetPopover(node, event.clientX, event.clientY)
      }
      event.preventDefault?.()
      event.stopPropagation?.()
      return true
    }
    return previousMouseDown?.call(this, event, localPosition, graphCanvas)
  }

  const previousMouseMove = node.onMouseMove
  node.onMouseMove = function (event, localPosition, graphCanvas) {
    if (updateReferenceShelfPointerDrag(node, event, localPosition)) return true
    return previousMouseMove?.call(this, event, localPosition, graphCanvas)
  }

  const previousMouseUp = node.onMouseUp
  node.onMouseUp = function (event, localPosition, graphCanvas) {
    if (finishReferenceShelfPointerDrag(node, event)) return true
    return previousMouseUp?.call(this, event, localPosition, graphCanvas)
  }

  const previousDragOver = node.onDragOver
  node.onDragOver = (event) => {
    const hit = referenceShelfEventHit(node, event)
    if (hit?.type === 'slot' && (activeReferenceDrag || hasExternalFileDrag(event))) {
      event.preventDefault?.()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      const dragCtx = node.__bil
      if (dragCtx?.referenceDragHoverIndex !== hit.index) {
        if (dragCtx) dragCtx.referenceDragHoverIndex = hit.index
        node.setDirtyCanvas?.(true, false)
      }
      return true
    }
    if (node.__bil?.referenceDragHoverIndex != null) {
      node.__bil.referenceDragHoverIndex = null
      node.setDirtyCanvas?.(true, false)
    }
    const previousResult = previousDragOver?.call(node, event)
    if (previousResult === true) return true
    if (!hasExternalFileDrag(event)) return false
    event.preventDefault?.()
    event.stopPropagation?.()
    event.stopImmediatePropagation?.()
    return true
  }

  const previousDragDrop = node.onDragDrop
  node.onDragDrop = async (event) => {
    const hit = referenceShelfEventHit(node, event)
    if (hit?.type === 'slot') {
      event.preventDefault?.()
      event.stopPropagation?.()
      const drag = activeReferenceDrag
      activeReferenceDrag = null
      if (node.__bil) node.__bil.referenceDragHoverIndex = null
      node.setDirtyCanvas?.(true, false)
      if (drag) return await assignReferenceDrag(node, drag, hit.index)
      if (hasExternalFileDrag(event)) {
        const files = await getDroppedImageFiles(event)
        return await importReferenceOnly(node, files, hit.index)
      }
      return false
    }
    const previousResult = await previousDragDrop?.call(node, event)
    if (previousResult === true) return true
    if (!consumeExternalFileDrag(event)) return false
    const files = await getDroppedImageFiles(event)
    if (!files.length) return false
    return await uploadViaNode(node, files)
  }

  const previousDragLeave = node.onDragLeave
  node.onDragLeave = function (event) {
    if (node.__bil?.referenceDragHoverIndex != null) {
      node.__bil.referenceDragHoverIndex = null
      node.setDirtyCanvas?.(true, false)
    }
    return previousDragLeave?.call(this, event)
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
    hydrateReferencePresetName(node, snapshot.state)
    queueMicrotask(() => scheduleRenderNode(node))
  })

  chainNodeCallback(node, 'onResize', function () {
    syncDomWidgetSize(node, widget)
    scheduleRenderNode(node, { viewportOnly: true, forceVisibleRows: true })
  })

  chainNodeCallback(node, 'onRemoved', function () {
    autoQueueCoordinator.unregisterNode(node)
    canvasDropCoordinator.unregisterNode(node)
    imageContextMenuCoordinator.unregisterNode(node)
    keyboardCoordinator.unregisterNode(node)
    const ctx = node.__bil
    if (!ctx) return
    ctx.removed = true
    ctx.presetRequestId += 1
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
    if (ctx.documentMarqueeMoveHandler) {
      document.removeEventListener('pointermove', ctx.documentMarqueeMoveHandler, true)
      ctx.documentMarqueeMoveHandler = null
    }
    if (ctx.documentMarqueeEndHandler) {
      document.removeEventListener('pointerup', ctx.documentMarqueeEndHandler, true)
      document.removeEventListener('pointercancel', ctx.documentMarqueeEndHandler, true)
      ctx.documentMarqueeEndHandler = null
    }
    ctx.middlePanPointerId = null
    cancelMarqueeSelection(node, false)
    if (ctx.documentFocusScopeHandler) {
      document.removeEventListener('pointerdown', ctx.documentFocusScopeHandler, true)
      ctx.documentFocusScopeHandler = null
    }
    if (ctx.windowFocusHandler) {
      window.removeEventListener('focus', ctx.windowFocusHandler)
      ctx.windowFocusHandler = null
    }
    ctx.filePickerPending = false
    ctx.activePickerInput = null
    clearTimeout(ctx.filePickerFocusTimer)
    ctx.filePickerFocusTimer = 0
    if (ctx.filePickerFocusFrame) cancelAnimationFrame(ctx.filePickerFocusFrame)
    ctx.filePickerFocusFrame = 0
    ctx.restoreCanvasShortcutFocus = null
    ctx.inputAbortController?.abort?.()
    ctx.inputAbortController = null
    clearTimeout(ctx.searchTimer)
    clearTimeout(ctx.scrollSettleTimer)
    ctx.scrollSettleTimer = 0
    ctx.lightbox?.root?.remove?.()
    closePresetPopover(ctx)
    closeImageContextMenu(ctx)
    if (activeReferenceDrag?.node === node) activeReferenceDrag = null
    ctx.referenceShelfPointerDrag = null
    ctx.referenceDragSourceIndex = null
    ctx.referenceDragHoverIndex = null
    ctx.listResizeObserver?.disconnect?.()
    ctx.listResizeObserver = null
    ctx.clearExternalDragState?.()
    ctx.clearExternalDragState = null
    for (const slot of ctx.cardPool) resetCardThumbnail(slot)
    ctx.cardPool.length = 0
    ctx.thumbnailUrlCache = new WeakMap()
    for (const entry of ctx.referenceThumbs.values()) {
      entry.image.onload = null
      entry.image.onerror = null
      entry.image.removeAttribute?.('src')
    }
    ctx.referenceThumbs.clear()
    for (const entry of ctx.localObjectUrls.values()) URL.revokeObjectURL(entry.url)
    ctx.localObjectUrls.clear()
    ctx.browser.folderViews.clear()
    ctx.browser.folderSources.clear()
    ctx.folderTabElements.clear()
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
  hydrateReferencePresetName(node, snapshot.state)
  queueMicrotask(() => scheduleRenderNode(node))
  keyboardCoordinator.registerNode(node)
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
          onHide: () => suspendGalleryViewport(node.__bil),
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
