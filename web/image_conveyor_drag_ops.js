import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'
import { normalizeReferenceSlots, referenceShelfHit } from './image_conveyor_math.mjs'
import {
  cardIntentInsertionIndex,
  libraryRefreshScrollRestore,
  materializationNeedsLibraryRefresh,
  reorderSelectedItems
} from './image_conveyor_drag_math.mjs'

const EXTENSION_NAME = 'Comfy.ImageConveyor.BatchDragOperations'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const STATE_WIDGET = 'state_json'
const UI_STATE_WIDGET = 'ui_state_json'
const SERVER_INPUT_SOURCE_ID = '__image_conveyor_input__'
const HOVER_OPEN_MS = 600
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'avif'])
const patchedNodes = new Set()

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `icx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function normalizePath(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/')
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return ''
  const parts = raw.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return ''
  return parts.join('/')
}

function normalizeFolder(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!raw) return ''
  const parts = raw.split('/').filter(Boolean)
  if (parts.some((part) => part === '.' || part === '..')) return null
  return parts.join('/')
}

function parentPath(value) {
  const path = normalizePath(value) || normalizeFolder(value) || ''
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function pathName(value) {
  const path = normalizePath(value) || normalizeFolder(value) || ''
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

function annotatedPath(value) {
  return String(value ?? '').replace(/ \[(input|output|temp)\]$/, '')
}

function itemInputPath(item) {
  if (!item || item.kind === 'folder' || item.localFile) return ''
  const explicit = normalizePath(item.relative_path)
  if (explicit) return explicit
  if (String(item.type ?? 'input').toLowerCase() !== 'input') return ''
  return normalizePath(annotatedPath(item.annotated))
}

function itemViewId(item) {
  return String(item?.key ?? item?.relative_path ?? item?.id ?? '')
}

function isImageFile(file) {
  if (!(file instanceof File)) return false
  if (String(file.type || '').startsWith('image/')) return true
  const extension = String(file.name || '').split('.').at(-1)?.toLowerCase() || ''
  return IMAGE_EXTENSIONS.has(extension)
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
  const ctx = node.__bil
  const state = ctx?.state ? clone(ctx.state) : readJsonWidget(node, STATE_WIDGET, { version: 2, items: [], reference_slots: [] })
  state.items = Array.isArray(state.items) ? state.items : []
  state.reference_slots = normalizeReferenceSlots(state.reference_slots)
  return state
}

function readUiState(node) {
  const ctx = node.__bil
  const ui = ctx?.uiState ? clone(ctx.uiState) : readJsonWidget(node, UI_STATE_WIDGET, { version: 2, selected_ids: [], source_paths: {} })
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
  const browser = ctx.browser?.[ctx.browser.activeView] ?? ctx.browser?.folderViews?.get(ctx.browser.activeView)
  if (ctx.searchInput && browser) {
    ctx.searchInput.value = String(browser.query || '')
    ctx.searchInput.dispatchEvent(new Event('input'))
  }
  node.setDirtyCanvas?.(true, true)
}

function commitState(node, state, uiState = readUiState(node)) {
  const ctx = node.__bil
  state.reference_slots = normalizeReferenceSlots(state.reference_slots)
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

async function jsonRequest(path, options = {}) {
  const response = await api.fetchApi(path, options)
  let payload = null
  try { payload = await response.json() } catch {}
  if (!response.ok) throw new Error(payload?.error || `${response.status} ${response.statusText}`)
  return payload
}

function pathToReference(relativePath) {
  const path = normalizePath(relativePath)
  if (!path) return null
  return {
    annotated: `${path} [input]`,
    filename: pathName(path),
    subfolder: parentPath(path),
    type: 'input'
  }
}

function queueItemFromPath(relativePath) {
  const path = normalizePath(relativePath)
  if (!path) return null
  return {
    id: makeId(),
    annotated: `${path} [input]`,
    filename: pathName(path),
    subfolder: parentPath(path),
    source_path: path,
    type: 'input',
    status: 'pending',
    added_at: Date.now(),
    last_queued_at: 0,
    last_processed_at: 0
  }
}

function cardSlotAtTarget(ctx, target) {
  if (!(target instanceof Node)) return null
  return ctx.cardPool?.find((slot) => slot?.itemId && slot.card?.contains(target)) ?? null
}

function browserForView(ctx, view) {
  return ctx.browser?.[view] ?? ctx.browser?.folderViews?.get(view) ?? null
}

function selectionItemsForDrag(node, sourceView, draggedItem, fallbackItems = []) {
  const ctx = node.__bil
  const browser = browserForView(ctx, sourceView)
  const selected = browser?.selected instanceof Set
    ? browser.selected
    : new Set(Array.from(browser?.selected ?? []))
  const draggedId = itemViewId(draggedItem)
  if (!draggedId || !selected.has(draggedId) || selected.size < 2) {
    return Array.from(fallbackItems?.length ? fallbackItems : [draggedItem]).filter(Boolean)
  }

  if (sourceView === 'conveyor') {
    const selectedItems = readState(node).items.filter((item) => selected.has(itemViewId(item)))
    return selectedItems.length ? selectedItems : Array.from(fallbackItems).filter(Boolean)
  }

  const result = []
  const seen = new Set()
  const collect = (entries) => {
    for (const item of Array.isArray(entries) ? entries : []) {
      if (!item || item.kind === 'folder') continue
      const id = itemViewId(item)
      if (!id || !selected.has(id) || seen.has(id)) continue
      seen.add(id)
      result.push(item)
    }
  }

  // Visible ordering comes first. Browser backing data then recovers selected items that
  // virtualization has moved outside the current DOM/card window.
  collect(ctx.visibleItems)
  collect(browser?.entries)
  collect(browser?.files)
  if (sourceView === 'input') collect(ctx.icx?.allFiles)
  collect(fallbackItems)
  if (!seen.has(draggedId) && draggedItem) result.push(draggedItem)
  return result
}

function getQueuedInputPaths() {
  const paths = new Set()
  for (const node of patchedNodes) {
    const state = node.__bil?.state ?? readState(node)
    for (const item of state.items ?? []) {
      if (item?.status !== 'queued') continue
      const path = itemInputPath(item)
      if (path) paths.add(path)
    }
  }
  return paths
}

function clearMainDragState(node) {
  const ctx = node.__bil
  if (!ctx) return
  // Never dispatch a synthetic dragend from inside an active native drop sequence. Native
  // dragend follows the drop and clears the main module's private drag token itself. Forcing
  // dragend here creates re-entrant browser drag processing and is unnecessary.
  ctx.draggedId = null
  ctx.dragIntent = null
  if (ctx.dropIndicator) ctx.dropIndicator.hidden = true
  for (const slot of ctx.cardPool ?? []) slot.card?.classList.remove('bil-drag-target')
  ctx.referenceDragHoverIndex = null
  if (ctx.icx) {
    ctx.icx.cardDrag = null
    ctx.icx.batchDrag = null
  }
  node.setDirtyCanvas?.(true, false)
}

function rewriteLivePaths(replacements) {
  const mapping = new Map()
  for (const entry of replacements ?? []) {
    const oldPath = normalizePath(entry?.relative_path)
    const keepPath = normalizePath(entry?.keep_path)
    if (oldPath && keepPath && oldPath !== keepPath) mapping.set(oldPath, keepPath)
  }
  if (!mapping.size) return

  for (const node of patchedNodes) {
    const ctx = node.__bil
    if (!ctx || ctx.removed) continue
    const state = readState(node)
    const ui = readUiState(node)
    let changed = false
    for (const item of state.items ?? []) {
      const oldPath = itemInputPath(item)
      const keepPath = mapping.get(oldPath)
      if (!keepPath) continue
      item.annotated = `${keepPath} [input]`
      item.filename = pathName(keepPath)
      item.subfolder = parentPath(keepPath)
      if (normalizePath(item.source_path) === oldPath) item.source_path = keepPath
      if (normalizePath(ui.source_paths?.[item.id]) === oldPath) ui.source_paths[item.id] = keepPath
      changed = true
    }
    const slots = normalizeReferenceSlots(state.reference_slots)
    for (let index = 0; index < slots.length; index += 1) {
      const oldPath = itemInputPath(slots[index])
      const keepPath = mapping.get(oldPath)
      if (!keepPath) continue
      slots[index] = pathToReference(keepPath)
      changed = true
    }
    if (changed) {
      state.reference_slots = slots
      commitState(node, state, ui)
    }
  }
}

function refreshInputs() {
  for (const node of patchedNodes) {
    const ctx = node.__bil
    if (!ctx || ctx.removed) continue
    const view = ctx.browser?.activeView
    const browser = browserForView(ctx, view)
    const restore = libraryRefreshScrollRestore(
      view,
      browser?.scrollTop,
      ctx.list?.scrollTop,
      ctx.list?.clientWidth,
      ctx.list?.clientHeight
    )
    if (restore && browser) {
      browser.scrollTop = restore.scrollTop
      ctx.pendingScrollRestore = restore
    }
    ctx.refreshBtn?.click?.()
  }
}

function createUploadSession() {
  return { needsSnapshotRefresh: true }
}

async function uploadOne(file, destinationFolder, session = null) {
  const body = new FormData()
  body.append('image', file)
  body.append('type', 'input')
  body.append('subfolder', destinationFolder)
  if (!session || session.needsSnapshotRefresh) body.append('refresh_snapshot', 'true')
  const payload = await jsonRequest('/image-conveyor/resolve-upload', { method: 'POST', body })
  if (session) session.needsSnapshotRefresh = false
  const path = normalizePath(payload?.relative_path || `${payload?.subfolder ? `${payload.subfolder}/` : ''}${payload?.name || ''}`)
  if (!path) throw new Error(`Invalid upload response for '${file.name}'.`)
  return path
}

async function relocateResolvedInputPaths(paths, destinationFolder) {
  const normalized = Array.from(new Set(paths.map(normalizePath).filter(Boolean)))
  if (!normalized.length) return { files: [], skipped: [] }
  return await jsonRequest('/image-conveyor/input-files/copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      relative_paths: normalized,
      destination_subfolder: destinationFolder,
      protected_paths: Array.from(getQueuedInputPaths())
    })
  })
}

async function moveInputPaths(paths, destinationFolder) {
  const normalized = Array.from(new Set(paths.map(normalizePath).filter(Boolean)))
  if (!normalized.length) return { moved: [], skipped: [] }
  const payload = await jsonRequest('/image-conveyor/input-files/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      relative_paths: normalized,
      destination_subfolder: destinationFolder,
      protected_paths: Array.from(getQueuedInputPaths()),
      collision_safe: true
    })
  })
  const moved = Array.isArray(payload?.moved) ? payload.moved : []
  if (moved.length) rewriteLivePaths(moved)
  return payload
}

async function addCharacterMembers(presetId, paths) {
  const normalized = Array.from(new Set(paths.map(normalizePath).filter(Boolean)))
  if (!presetId || !normalized.length) return
  await jsonRequest(`/image-conveyor/character-folders/${encodeURIComponent(presetId)}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relative_paths: normalized })
  })
}

async function getCharacter(presetId) {
  const payload = await jsonRequest('/image-conveyor/character-folders')
  return (Array.isArray(payload?.characters) ? payload.characters : []).find(
    (entry) => String(entry?.preset_id || '') === String(presetId || '')
  ) ?? null
}

function characterDestinationFromView(ctx, viewId, browser, element) {
  const elements = ctx.folderTabElements?.get(viewId)
  const folder = normalizeFolder(elements?.tab?.title)
  if (folder == null) return null
  return {
    kind: 'folder',
    key: `character:${viewId}`,
    folder,
    characterId: String(browser?.characterId || ''),
    element,
    open: null
  }
}

function destinationFromTab(ctx, target) {
  if (!(target instanceof Node)) return null
  if (ctx.conveyorTab?.contains(target)) {
    return {
      kind: 'conveyor',
      key: 'conveyor',
      folder: '',
      characterId: null,
      element: ctx.conveyorTab,
      open: () => ctx.conveyorTab?.click?.()
    }
  }
  if (ctx.inputTab?.contains(target)) {
    return {
      kind: 'folder',
      key: 'input',
      folder: '',
      characterId: null,
      element: ctx.inputTab,
      open: () => ctx.inputTab?.click?.()
    }
  }
  for (const [viewId, elements] of ctx.folderTabElements ?? []) {
    if (!elements?.tab?.contains(target)) continue
    const browser = ctx.browser.folderViews.get(viewId)
    if (!browser) return null
    if (browser.sourceKind === 'character') {
      const destination = characterDestinationFromView(ctx, viewId, browser, elements.tab)
      if (destination) destination.open = () => elements.tab.click()
      return destination
    }
    if (browser.sourceKind === 'server-input' || browser.sourceId === SERVER_INPUT_SOURCE_ID) {
      const folder = normalizeFolder(browser.folderPath || '')
      if (folder == null) return null
      return {
        kind: 'folder',
        key: viewId,
        folder,
        characterId: null,
        element: elements.tab,
        open: () => elements.tab.click()
      }
    }
  }
  return null
}

function destinationFromFolderCard(ctx, target) {
  const slot = cardSlotAtTarget(ctx, target)
  if (slot?.item?.kind !== 'folder' || slot.item.sourceId !== SERVER_INPUT_SOURCE_ID) return null
  const folder = normalizeFolder(slot.item.folderPath)
  if (folder == null) return null
  return {
    kind: 'folder',
    key: `folder-card:${folder}`,
    folder,
    characterId: null,
    element: slot.card,
    open: () => slot.media?.click?.()
  }
}

function destinationFromActiveLibraryArea(ctx, target) {
  if (!(target instanceof Node) || !ctx.list?.contains(target)) return null
  const viewId = ctx.browser.activeView
  if (viewId === 'conveyor') return null
  if (viewId === 'input') {
    return {
      kind: 'folder',
      key: 'active:input',
      folder: '',
      characterId: null,
      element: ctx.list,
      open: null
    }
  }
  const browser = ctx.browser.folderViews.get(viewId)
  if (!browser) return null
  if (browser.sourceKind === 'character') {
    return characterDestinationFromView(ctx, viewId, browser, ctx.list)
  }
  if (browser.sourceKind === 'server-input' || browser.sourceId === SERVER_INPUT_SOURCE_ID) {
    const folder = normalizeFolder(browser.folderPath || '')
    if (folder == null) return null
    return {
      kind: 'folder',
      key: `active:${viewId}`,
      folder,
      characterId: null,
      element: ctx.list,
      open: null
    }
  }
  return null
}

function destinationAt(ctx, target) {
  return destinationFromTab(ctx, target)
    ?? destinationFromFolderCard(ctx, target)
    ?? destinationFromActiveLibraryArea(ctx, target)
}

function clearHoverTarget(ext) {
  if (ext.batchHover?.timer) clearTimeout(ext.batchHover.timer)
  ext.batchHover?.element?.classList.remove('icx-batch-drop-target')
  ext.batchHover = null
}

function setHoverTarget(ext, destination) {
  if (ext.batchHover?.key === destination.key) return
  clearHoverTarget(ext)
  destination.element?.classList.add('icx-batch-drop-target')
  const timer = destination.open
    ? setTimeout(() => {
        if (ext.batchHover?.key !== destination.key) return
        destination.open?.()
      }, HOVER_OPEN_MS)
    : null
  ext.batchHover = { ...destination, timer }
}

function batchFromInternalDrag(ctx) {
  const drag = ctx.icx?.batchDrag ?? ctx.icx?.cardDrag
  if (!drag?.items?.length) return null
  return {
    ...drag,
    sourceView: drag.sourceView ?? drag.view ?? ctx.browser.activeView,
    items: Array.from(drag.items)
  }
}

function batchFromExternalFiles(event) {
  const files = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile)
  return files.length ? { sourceView: 'external', items: [], externalFiles: files } : null
}

async function sourcePathsForBatch(batch, defaultUploadFolder = '') {
  const paths = []
  const errors = []
  const session = createUploadSession()
  for (const item of batch.items ?? []) {
    if (item?.localFile instanceof File) {
      const destination = normalizeFolder(item.relativeSubfolder ?? item.subfolder ?? defaultUploadFolder)
      try {
        paths.push(await uploadOne(item.localFile, destination == null ? defaultUploadFolder : destination, session))
      } catch (error) {
        errors.push(error)
      }
      continue
    }
    const path = itemInputPath(item)
    if (path) paths.push(path)
  }
  for (const file of Array.from(batch.externalFiles ?? []).filter(isImageFile)) {
    try {
      paths.push(await uploadOne(file, defaultUploadFolder, session))
    } catch (error) {
      errors.push(error)
    }
  }
  return { paths, errors }
}

async function addBatchToConveyor(node, batch) {
  if (batch.sourceView === 'conveyor') {
    node.__bil?.conveyorTab?.click?.()
    return
  }
  const { paths, errors } = await sourcePathsForBatch(batch, '')
  const state = readState(node)
  const ui = readUiState(node)
  let added = 0
  for (const path of paths) {
    const item = queueItemFromPath(path)
    if (!item) continue
    state.items.push(item)
    ui.source_paths[item.id] = path
    added += 1
  }
  if (added) commitState(node, state, ui)
  node.__bil?.conveyorTab?.click?.()
  if (errors.length) {
    window.alert(`${errors.length} image${errors.length === 1 ? '' : 's'} failed to import into the Conveyor.`)
  }
}

async function dropBatchIntoFolder(node, batch, destination) {
  const inputPaths = []
  const localFiles = []
  for (const item of batch.items ?? []) {
    if (item?.localFile instanceof File) localFiles.push(item)
    else {
      const path = itemInputPath(item)
      if (path) inputPaths.push(path)
    }
  }

  const finalPaths = []
  let skipped = []
  if (inputPaths.length) {
    const result = await moveInputPaths(inputPaths, destination.folder)
    const moved = Array.isArray(result?.moved) ? result.moved : []
    skipped = Array.isArray(result?.skipped) ? result.skipped : []
    const movedMap = new Map(moved.map((entry) => [normalizePath(entry.relative_path), normalizePath(entry.keep_path)]))
    for (const path of inputPaths) {
      const movedPath = movedMap.get(path)
      if (movedPath) finalPaths.push(movedPath)
      else if (parentPath(path) === destination.folder) finalPaths.push(path)
    }
  }

  const uploadErrors = []
  const uploadedPaths = []
  const session = createUploadSession()
  for (const item of localFiles) {
    try {
      uploadedPaths.push(await uploadOne(item.localFile, destination.folder, session))
    } catch (error) {
      uploadErrors.push(error)
    }
  }
  for (const file of Array.from(batch.externalFiles ?? []).filter(isImageFile)) {
    try {
      uploadedPaths.push(await uploadOne(file, destination.folder, session))
    } catch (error) {
      uploadErrors.push(error)
    }
  }
  if (uploadedPaths.length) {
    // resolve-upload may deduplicate to an existing canonical Input path outside the requested
    // folder. Canonical relocation moves that one physical file into the requested destination.
    const relocated = await relocateResolvedInputPaths(uploadedPaths, destination.folder)
    finalPaths.push(...(relocated?.files ?? []).map((entry) => normalizePath(entry.relative_path)).filter(Boolean))
    skipped.push(...(Array.isArray(relocated?.skipped) ? relocated.skipped : []))
  }

  if (destination.characterId && finalPaths.length) {
    await addCharacterMembers(destination.characterId, finalPaths)
  }
  refreshInputs()

  if (skipped.length || uploadErrors.length) {
    const messages = []
    if (skipped.length) messages.push(`${skipped.length} image${skipped.length === 1 ? '' : 's'} could not be moved: ${skipped[0]?.reason || 'filesystem changed'}`)
    if (uploadErrors.length) messages.push(`${uploadErrors.length} local image${uploadErrors.length === 1 ? '' : 's'} failed to import.`)
    window.alert(messages.join('\n'))
  }
}

async function dropBatchIntoDestination(node, batch, destination) {
  if (destination.kind === 'conveyor') return await addBatchToConveyor(node, batch)
  return await dropBatchIntoFolder(node, batch, destination)
}

function nodePoint(node, event) {
  try { app.canvas?.adjustMouseEvent?.(event) } catch {}
  const canvasX = Number(event?.canvasX)
  const canvasY = Number(event?.canvasY)
  if (!Number.isFinite(canvasX) || !Number.isFinite(canvasY)) return null
  return { x: canvasX - Number(node.pos?.[0] || 0), y: canvasY - Number(node.pos?.[1] || 0) }
}

function shelfHit(node, event) {
  const ctx = node.__bil
  const point = ctx?.referenceShelfLayout ? nodePoint(node, event) : null
  return point ? referenceShelfHit(ctx.referenceShelfLayout, point.x, point.y) : null
}

async function materializeCharacterDrop(node, startIndex, batch, externalFiles) {
  const state = readState(node)
  const presetId = String(state.active_reference_preset_id || '')
  if (!presetId) return false
  const character = await getCharacter(presetId)
  if (!character?.folder) throw new Error('Unable to resolve the active character folder.')

  const sourcePaths = []
  const uploadErrors = []
  const session = createUploadSession()
  for (const item of batch?.items ?? []) {
    if (item?.localFile instanceof File) {
      try { sourcePaths.push(await uploadOne(item.localFile, character.folder, session)) } catch (error) { uploadErrors.push(error) }
    } else {
      const path = itemInputPath(item)
      if (path) sourcePaths.push(path)
    }
  }
  for (const file of Array.from(externalFiles ?? []).filter(isImageFile)) {
    try { sourcePaths.push(await uploadOne(file, character.folder, session)) } catch (error) { uploadErrors.push(error) }
  }
  if (!sourcePaths.length) {
    if (uploadErrors.length) window.alert(`${uploadErrors.length} image${uploadErrors.length === 1 ? '' : 's'} failed to import.`)
    return false
  }

  const payload = await jsonRequest(
    `/image-conveyor/character-folders/${encodeURIComponent(presetId)}/materialize`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relative_paths: sourcePaths,
        protected_paths: Array.from(getQueuedInputPaths())
      })
    }
  )
  const skipped = Array.isArray(payload?.skipped) ? payload.skipped : []
  const references = (Array.isArray(payload?.files) ? payload.files : [])
    .map((entry) => pathToReference(entry.relative_path))
    .filter(Boolean)
  if (skipped.length) {
    window.alert(`${skipped.length} queued reference image${skipped.length === 1 ? ' was' : 's were'} left in place and not reassigned.`)
  }
  if (!references.length) return false

  const next = readState(node)
  const slots = normalizeReferenceSlots(next.reference_slots)
  for (let offset = 0; offset < references.length; offset += 1) {
    const index = Number(startIndex) + offset
    if (index < 0 || index >= slots.length) break
    slots[index] = references[offset]
  }
  next.reference_slots = slots
  commitState(node, next)

  // Reference-slot assignment itself does not mutate a source collection. Only
  // refresh library views when the materialization response proves that a file
  // was physically relocated/deduplicated and the collection contents changed.
  if (materializationNeedsLibraryRefresh(payload)) refreshInputs()

  if (uploadErrors.length) {
    window.alert(`${uploadErrors.length} image${uploadErrors.length === 1 ? '' : 's'} failed to import; successful images were kept.`)
  }
  return true
}

async function assignPlainReferenceDrop(node, startIndex, batch) {
  const references = []
  const errors = []
  const session = createUploadSession()
  for (const item of batch.items ?? []) {
    if (item?.localFile instanceof File) {
      const destination = normalizeFolder(item.relativeSubfolder ?? item.subfolder ?? '')
      try {
        const path = await uploadOne(item.localFile, destination == null ? '' : destination, session)
        const reference = pathToReference(path)
        if (reference) references.push(reference)
      } catch (error) {
        errors.push(error)
      }
      continue
    }
    const reference = pathToReference(itemInputPath(item))
    if (reference) references.push(reference)
  }
  if (!references.length) {
    if (errors.length) window.alert(`${errors.length} image${errors.length === 1 ? '' : 's'} failed to import as references.`)
    return false
  }
  const state = readState(node)
  const slots = normalizeReferenceSlots(state.reference_slots)
  for (let offset = 0; offset < references.length; offset += 1) {
    const index = Number(startIndex) + offset
    if (index < 0 || index >= slots.length) break
    slots[index] = references[offset]
  }
  state.reference_slots = slots
  commitState(node, state)
  if (errors.length) window.alert(`${errors.length} image${errors.length === 1 ? '' : 's'} failed to import; successful references were kept.`)
  return true
}

function handleMultiReorderDrop(node, event, batch) {
  const ctx = node.__bil
  if (batch.sourceView !== 'conveyor' || (batch.items?.length ?? 0) < 2) return false
  if (ctx.browser.activeView !== 'conveyor' || !(event.target instanceof Node) || !ctx.list?.contains(event.target)) return false

  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation?.()
  const intent = ctx.dragIntent
  const state = readState(node)
  const selectedIds = batch.items.map((item) => String(item?.id || '')).filter(Boolean)
  let insertionIndex = -1
  if (intent?.type === 'card') {
    const targetId = String(ctx.visibleItems?.[intent.targetIndex]?.id || '')
    insertionIndex = cardIntentInsertionIndex(state.items, batch.draggedId || ctx.draggedId, targetId)
  } else if (intent && Number.isFinite(Number(intent.insertionIndex))) {
    insertionIndex = Number(intent.insertionIndex)
  }
  if (insertionIndex < 0) {
    const target = cardSlotAtTarget(ctx, event.target)
    const targetId = String(target?.item?.id || '')
    if (targetId) insertionIndex = cardIntentInsertionIndex(state.items, batch.draggedId || ctx.draggedId, targetId)
  }

  if (insertionIndex >= 0) {
    const reordered = reorderSelectedItems(state.items, selectedIds, insertionIndex)
    if (reordered.changed) {
      state.items = reordered.items
      commitState(node, state)
    }
  }
  clearMainDragState(node)
  return true
}

function installStyles() {
  if (document.getElementById('image-conveyor-batch-drag-style')) return
  const style = document.createElement('style')
  style.id = 'image-conveyor-batch-drag-style'
  style.textContent = `
    .icx-batch-drop-target { outline: 2px solid rgba(105, 180, 255, .95) !important; outline-offset: -2px; }
    .bil-folder-card .bil-media { display: grid !important; place-items: center !important; }
    .bil-folder-icon:not([hidden]) {
      display: block !important;
      position: relative !important;
      width: clamp(58px, 48%, 104px) !important;
      height: auto !important;
      aspect-ratio: 1.35 / 1 !important;
      align-self: center !important;
      justify-self: center !important;
      margin: 0 !important;
    }
    .bil-folder-icon:not([hidden])::before { top: -18% !important; height: 28% !important; }
  `
  document.head.appendChild(style)
}

function installNode(node) {
  const ctx = node.__bil
  if (!ctx?.icx || ctx.icx.batchDragV2 || ctx.removed) return false
  installStyles()
  const ext = ctx.icx
  ext.batchDragV2 = true
  ext.batchDrag = null
  ext.batchHover = null
  patchedNodes.add(node)

  ext.batchWindowDragStart = (event) => {
    const target = event.target
    if (!(target instanceof Node) || !ctx.root?.contains(target)) return
    const sourceView = ctx.browser.activeView
    const slot = cardSlotAtTarget(ctx, target)
    const draggedItem = slot?.item ?? null
    queueMicrotask(() => {
      if (node.__bil !== ctx || ctx.removed) return
      const drag = ext.cardDrag
      if (!drag?.items?.length && !draggedItem) return
      const items = selectionItemsForDrag(node, sourceView, draggedItem, drag?.items ?? [])
      if (!items.length) return
      ext.batchDrag = {
        ...(drag ?? {}),
        sourceView,
        items,
        draggedId: itemViewId(draggedItem) || ctx.draggedId || itemViewId(items[0])
      }
    })
  }

  ext.batchWindowDragOver = (event) => {
    const batch = batchFromInternalDrag(ctx) ?? batchFromExternalFiles(event)
    if (!batch) { clearHoverTarget(ext); return }
    const destination = destinationAt(ctx, event.target)
    if (!destination) { clearHoverTarget(ext); return }
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = destination.kind === 'conveyor' || batch.sourceView === 'external' ? 'copy' : 'move'
    setHoverTarget(ext, destination)
  }

  ext.batchWindowDrop = (event) => {
    const batch = batchFromInternalDrag(ctx) ?? batchFromExternalFiles(event)
    if (!batch) return

    if (handleMultiReorderDrop(node, event, batch)) {
      clearHoverTarget(ext)
      return
    }

    const destination = destinationAt(ctx, event.target)
    if (!destination) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation?.()
    clearHoverTarget(ext)
    const captured = { ...batch, items: Array.from(batch.items ?? []) }
    clearMainDragState(node)
    void dropBatchIntoDestination(node, captured, destination).catch((error) => {
      console.error('Image Conveyor: batch drop failed.', error)
      window.alert(error?.message || 'Unable to apply the selected image drop.')
    })
  }

  ext.batchWindowDragEnd = () => {
    clearHoverTarget(ext)
    ext.batchDrag = null
  }

  // Window capture deliberately precedes the older document/root drop handlers. Folder and
  // Conveyor tab targets are owned here so a batch cannot collapse to the legacy single-item
  // path before the selection-aware operation runs.
  window.addEventListener('dragstart', ext.batchWindowDragStart, true)
  window.addEventListener('dragover', ext.batchWindowDragOver, true)
  window.addEventListener('drop', ext.batchWindowDrop, true)
  window.addEventListener('dragend', ext.batchWindowDragEnd, true)

  const previousDragDrop = node.onDragDrop
  node.onDragDrop = async function (event) {
    const hit = shelfHit(node, event)
    const current = readState(node)
    const presetId = String(current.active_reference_preset_id || '')
    const batch = batchFromInternalDrag(ctx)
    const files = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile)
    if (hit?.type === 'slot' && batch?.items?.length) {
      event.preventDefault?.()
      event.stopPropagation?.()
      ctx.referenceDragHoverIndex = null
      const captured = { ...batch, items: Array.from(batch.items) }
      clearMainDragState(node)
      try {
        if (presetId) return await materializeCharacterDrop(node, hit.index, captured, [])
        return await assignPlainReferenceDrop(node, hit.index, captured)
      } catch (error) {
        console.error('Image Conveyor: reference batch drop failed.', error)
        window.alert(error?.message || 'Unable to apply the selected reference images.')
        return false
      }
    }
    if (hit?.type === 'slot' && presetId && files.length) {
      event.preventDefault?.()
      event.stopPropagation?.()
      ctx.referenceDragHoverIndex = null
      clearMainDragState(node)
      try {
        return await materializeCharacterDrop(node, hit.index, { items: [], sourceView: 'external' }, files)
      } catch (error) {
        console.error('Image Conveyor: character materialization failed.', error)
        window.alert(error?.message || 'Unable to move the selected images into the active character folder.')
        return false
      }
    }
    return await previousDragDrop?.call(this, event)
  }

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    clearHoverTarget(ext)
    patchedNodes.delete(node)
    window.removeEventListener('dragstart', ext.batchWindowDragStart, true)
    window.removeEventListener('dragover', ext.batchWindowDragOver, true)
    window.removeEventListener('drop', ext.batchWindowDrop, true)
    window.removeEventListener('dragend', ext.batchWindowDragEnd, true)
    return previousRemoved?.apply(this, args)
  }
  return true
}

function scheduleInstall(node, attempts = 0) {
  if (!node || node.__bil?.removed || attempts > 60) return
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
