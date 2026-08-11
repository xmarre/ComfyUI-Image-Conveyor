import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'
import {
  REFERENCE_SLOT_COUNT,
  moveReferenceSlot,
  normalizeReferenceSlots,
  referenceShelfHit
} from './image_conveyor_math.mjs'

const EXTENSION_NAME = 'Comfy.ImageConveyor.LibraryOperations'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const STATE_WIDGET = 'state_json'
const UI_STATE_WIDGET = 'ui_state_json'
const SERVER_INPUT_SOURCE_ID = '__image_conveyor_input__'
const CHARACTER_SOURCE_PREFIX = '__image_conveyor_character__:'
const DEFAULT_LIBRARY_SORT = 'newest'
const VALID_LIBRARY_SORTS = new Set(['name_asc', 'name_desc', 'newest', 'oldest'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'avif'])
const DRAG_THRESHOLD = 4
const enhancedNodes = new Set()
let characterCache = new Map()
let characterSyncPromise = null
let characterCacheRevision = 0

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
  if (ctx?.state) return clone(ctx.state)
  const state = readJsonWidget(node, STATE_WIDGET, { version: 2, items: [], reference_slots: [] })
  state.items = Array.isArray(state.items) ? state.items : []
  state.reference_slots = normalizeReferenceSlots(state.reference_slots)
  return state
}

function readUiState(node) {
  const ctx = node.__bil
  if (ctx?.uiState) return clone(ctx.uiState)
  const ui = readJsonWidget(node, UI_STATE_WIDGET, { version: 2, selected_ids: [], source_paths: {} })
  ui.selected_ids = Array.isArray(ui.selected_ids) ? ui.selected_ids : []
  ui.source_paths = ui.source_paths && typeof ui.source_paths === 'object' ? ui.source_paths : {}
  return ui
}

function writeWidget(entry, value) {
  if (!entry) return
  entry.value = value
  entry.callback?.(value)
}

function requestMainRender(node) {
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

function commitNodeState(node, state, uiState = readUiState(node)) {
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
  requestMainRender(node)
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

function queueItemFromReference(reference) {
  const path = itemInputPath(reference) || normalizePath(annotatedPath(reference?.annotated))
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

function activeBrowser(ctx) {
  return ctx.browser?.[ctx.browser.activeView] ?? ctx.browser?.folderViews?.get(ctx.browser.activeView) ?? null
}

function viewItemId(item) {
  return item?.key ?? item?.relative_path ?? item?.id ?? ''
}

function isServerLibraryView(ctx, view = ctx.browser.activeView) {
  if (view === 'input') return true
  const browser = ctx.browser.folderViews.get(view)
  return browser?.sourceKind === 'server-input' || browser?.sourceKind === 'character'
}

function getQueuedInputPaths() {
  const paths = new Set()
  for (const node of enhancedNodes) {
    const state = node.__bil?.state ?? readState(node)
    for (const item of state.items ?? []) {
      if (item?.status !== 'queued') continue
      const path = itemInputPath(item)
      if (path) paths.add(path)
    }
  }
  return paths
}

function rewriteLivePaths(replacements) {
  const mapping = new Map()
  for (const entry of replacements ?? []) {
    const oldPath = normalizePath(entry?.relative_path)
    const keepPath = normalizePath(entry?.keep_path)
    if (oldPath && keepPath && oldPath !== keepPath) mapping.set(oldPath, keepPath)
  }
  if (!mapping.size) return 0
  let changedCount = 0
  for (const node of enhancedNodes) {
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
      changedCount += 1
    }
    const slots = normalizeReferenceSlots(state.reference_slots)
    for (let index = 0; index < slots.length; index += 1) {
      const oldPath = itemInputPath(slots[index])
      const keepPath = mapping.get(oldPath)
      if (!keepPath) continue
      slots[index] = pathToReference(keepPath)
      changed = true
      changedCount += 1
    }
    if (changed) {
      state.reference_slots = slots
      commitNodeState(node, state, ui)
    }
  }
  return changedCount
}

function removeLivePaths(relativePaths) {
  const removed = new Set((relativePaths ?? []).map(normalizePath).filter(Boolean))
  if (!removed.size) return 0
  let changedCount = 0
  for (const node of enhancedNodes) {
    const ctx = node.__bil
    if (!ctx || ctx.removed) continue
    const state = readState(node)
    const ui = readUiState(node)
    const removedIds = new Set()
    const kept = []
    for (const item of state.items ?? []) {
      if (removed.has(itemInputPath(item))) {
        removedIds.add(item.id)
        changedCount += 1
      } else {
        kept.push(item)
      }
    }
    let changed = kept.length !== (state.items ?? []).length
    state.items = kept
    const slots = normalizeReferenceSlots(state.reference_slots)
    for (let index = 0; index < slots.length; index += 1) {
      if (!removed.has(itemInputPath(slots[index]))) continue
      slots[index] = null
      changed = true
      changedCount += 1
    }
    if (!changed) continue
    state.reference_slots = slots
    ui.selected_ids = (ui.selected_ids ?? []).filter((id) => !removedIds.has(id))
    for (const id of removedIds) delete ui.source_paths?.[id]
    for (const id of removedIds) ctx.browser?.conveyor?.selected?.delete(id)
    commitNodeState(node, state, ui)
  }
  return changedCount
}

async function refreshPresetCaches() {
  let payload
  try {
    payload = await jsonRequest('/image-conveyor/reference-presets')
  } catch (error) {
    console.warn('Image Conveyor: unable to refresh saved character references.', error)
    return
  }
  for (const node of enhancedNodes) {
    const ctx = node.__bil
    if (!ctx || ctx.removed) continue
    ctx.presets = Array.isArray(payload?.presets)
      ? payload.presets.map((preset) => ({ ...preset, slots: normalizeReferenceSlots(preset?.slots) }))
      : []
    ctx.presetsLoaded = true
    node.setDirtyCanvas?.(true, true)
  }
}

function refreshAllInputs() {
  for (const node of enhancedNodes) {
    const ctx = node.__bil
    if (!ctx || ctx.removed) continue
    ctx.refreshBtn?.click?.()
  }
}

function librarySort(value, fallback = DEFAULT_LIBRARY_SORT) {
  return VALID_LIBRARY_SORTS.has(String(value)) ? String(value) : fallback
}

function invalidateDirectoryCache(ext) {
  ext.directoryCacheRevision = -1
}

function allDirectories(ext) {
  if (ext.directoryCacheRevision === ext.dataRevision) return ext.directoryCache
  const result = new Set(ext.serverDirectories)
  for (const entry of ext.allFiles) {
    let current = normalizeFolder(entry?.subfolder)
    while (current) {
      result.add(current)
      current = parentPath(current)
    }
  }
  for (const character of characterCache.values()) {
    let current = normalizeFolder(character.folder)
    while (current) {
      result.add(current)
      current = parentPath(current)
    }
  }
  ext.directoryCache = result
  ext.directoryCacheRevision = ext.dataRevision
  return result
}

function serverSource(ctx) {
  const ext = ctx.icx
  let source = ctx.browser.folderSources.get(SERVER_INPUT_SOURCE_ID)
  if (!source) {
    source = { id: SERVER_INPUT_SOURCE_ID, name: 'Input Folder', directories: new Set(), files: [] }
    ctx.browser.folderSources.set(SERVER_INPUT_SOURCE_ID, source)
  }
  source.directories = allDirectories(ext)
  return source
}

function folderEntry(path) {
  return {
    kind: 'folder',
    key: `input-folder:${path}`,
    sourceId: SERVER_INPUT_SOURCE_ID,
    sourceKind: 'server-input',
    folderPath: path,
    filename: pathName(path),
    relative_path: path,
    subfolder: parentPath(path),
    type: 'input'
  }
}

function directInputEntries(ctx, folderPath = '') {
  const ext = ctx.icx
  const currentFolder = normalizeFolder(folderPath) || ''
  const entries = []
  for (const directory of allDirectories(ext)) {
    if (parentPath(directory) === currentFolder) entries.push(folderEntry(directory))
  }
  for (const file of ext.allFiles) {
    if ((normalizeFolder(file?.subfolder) || '') === currentFolder) entries.push(file)
  }
  return entries
}

function characterEntries(ctx, character) {
  const ext = ctx.icx
  const wanted = new Set(character?.members ?? [])
  const folder = normalizeFolder(character?.folder) || ''
  for (const file of ext.allFiles) {
    const path = normalizePath(file.relative_path)
    if (folder && path.startsWith(`${folder}/`)) wanted.add(path)
  }
  const byPath = new Map(ext.allFiles.map((file) => [normalizePath(file.relative_path), file]))
  return Array.from(wanted).map((path) => byPath.get(path)).filter(Boolean)
}

function captureMainInputData(ctx) {
  const ext = ctx.icx
  const current = ctx.browser.input.files
  const versionChanged = ext.seenInputVersion !== ctx.inputVersion
  if (!versionChanged && current === ext.displayFiles) return false

  if (current !== ext.displayFiles) {
    ext.allFiles = Array.isArray(current) ? current.filter((entry) => entry?.kind !== 'folder') : []
  } else if (versionChanged) {
    const byPath = new Map(ext.allFiles.map((entry) => [normalizePath(entry.relative_path), entry]))
    for (const entry of current ?? []) {
      if (!entry || entry.kind === 'folder') continue
      const path = normalizePath(entry.relative_path)
      if (path) byPath.set(path, entry)
    }
    ext.allFiles = Array.from(byPath.values())
  }
  ext.seenInputVersion = ctx.inputVersion
  ext.dataRevision += 1
  invalidateDirectoryCache(ext)
  return true
}

function rebuildInputViews(node) {
  const ctx = node.__bil
  const ext = ctx?.icx
  if (!ctx || !ext) return
  serverSource(ctx)
  ext.displayFiles = ext.inputMode === 'folders' ? directInputEntries(ctx, '') : ext.allFiles
  if (ctx.browser.input.files !== ext.displayFiles) ctx.browser.input.files = ext.displayFiles

  for (const [viewId, browser] of ctx.browser.folderViews) {
    if (browser.sourceId === SERVER_INPUT_SOURCE_ID) {
      browser.sourceKind = 'server-input'
      browser.entries = directInputEntries(ctx, browser.folderPath)
      if (!ext.seenLibraryViews.has(viewId)) {
        browser.sort = ext.lastLibrarySort
        ext.seenLibraryViews.add(viewId)
      } else if (!VALID_LIBRARY_SORTS.has(browser.sort)) {
        browser.sort = ext.lastLibrarySort
      }
    } else if (browser.sourceKind === 'character') {
      browser.entries = characterEntries(ctx, characterCache.get(browser.characterId))
      if (!ext.seenLibraryViews.has(viewId)) {
        browser.sort = ext.lastLibrarySort
        ext.seenLibraryViews.add(viewId)
      }
    } else if (!ext.seenLibraryViews.has(viewId)) {
      browser.sort = ext.lastLibrarySort
      ext.seenLibraryViews.add(viewId)
    } else if (!VALID_LIBRARY_SORTS.has(browser.sort)) {
      browser.sort = ext.lastLibrarySort
    }
  }
  ctx.renderedRangeKey = ''
}

async function loadInputDirectories(node) {
  const ctx = node.__bil
  const ext = ctx?.icx
  if (!ctx || !ext || ext.directoriesBusy) return
  ext.directoriesBusy = true
  try {
    const payload = await jsonRequest('/image-conveyor/input-directories')
    if (node.__bil !== ctx || ctx.removed) return
    ext.serverDirectories = new Set(
      (Array.isArray(payload?.directories) ? payload.directories : [])
        .map(normalizeFolder)
        .filter(Boolean)
    )
    ext.dataRevision += 1
    invalidateDirectoryCache(ext)
    rebuildInputViews(node)
    requestMainRender(node)
  } catch (error) {
    console.warn('Image Conveyor: unable to enumerate input subfolders.', error)
  } finally {
    if (node.__bil === ctx) ext.directoriesBusy = false
  }
}

async function syncCharacterFolders(force = false) {
  if (characterSyncPromise) {
    if (!force) return characterSyncPromise
    return characterSyncPromise.then(
      () => syncCharacterFolders(false),
      () => syncCharacterFolders(false)
    )
  }
  const request = jsonRequest('/image-conveyor/character-folders').then((payload) => {
    const next = new Map()
    for (const character of Array.isArray(payload?.characters) ? payload.characters : []) {
      const id = String(character?.preset_id || '')
      const folder = normalizeFolder(character?.folder)
      if (!id || !folder) continue
      next.set(id, {
        preset_id: id,
        name: String(character?.name || 'Character'),
        folder,
        members: Array.from(new Set((character?.members ?? []).map(normalizePath).filter(Boolean)))
      })
    }
    characterCache = next
    characterCacheRevision += 1
    for (const node of enhancedNodes) {
      const ctx = node.__bil
      if (!ctx || ctx.removed || !ctx.icx) continue
      ctx.icx.characterRevision = characterCacheRevision
      ctx.icx.dataRevision += 1
      invalidateDirectoryCache(ctx.icx)
      rebuildInputViews(node)
      node.setDirtyCanvas?.(true, false)
    }
    return characterCache
  }).finally(() => {
    if (characterSyncPromise === request) characterSyncPromise = null
  })
  characterSyncPromise = request
  return request
}

async function activeCharacter(node) {
  const state = node.__bil?.state ?? readState(node)
  const presetId = String(state.active_reference_preset_id || '')
  if (!presetId) return null
  let character = characterCache.get(presetId)
  if (!character) {
    try {
      await syncCharacterFolders(true)
    } catch (error) {
      console.warn('Image Conveyor: character-folder sync failed during reference assignment.', error)
      throw new Error('Unable to refresh the active character folder. The reference drop was not applied.')
    }
    character = characterCache.get(presetId) ?? null
  }
  return character
}

async function addCharacterMembers(character, paths) {
  if (!character || !paths.length) return
  const payload = await jsonRequest(
    `/image-conveyor/character-folders/${encodeURIComponent(character.preset_id)}/members`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relative_paths: paths })
    }
  )
  const cached = characterCache.get(character.preset_id)
  if (cached && Array.isArray(payload?.members)) {
    cached.members = Array.from(new Set(payload.members.map(normalizePath).filter(Boolean)))
    characterCacheRevision += 1
  }
}

function customTabElements(node, viewId, label, title) {
  const ctx = node.__bil
  ctx.tabs?.setAttribute('role', 'tablist')
  const shell = document.createElement('div')
  shell.className = 'bil-tab-shell'
  const tab = document.createElement('button')
  tab.className = 'bil-tab'
  tab.type = 'button'
  tab.setAttribute('role', 'tab')
  tab.setAttribute('aria-selected', 'false')
  tab.setAttribute('aria-controls', ctx.list.id)
  tab.id = `${ctx.tabSetId}-${viewId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  tab.title = title
  const labelElement = document.createElement('span')
  labelElement.className = 'bil-tab-label'
  labelElement.textContent = label
  tab.appendChild(labelElement)
  const close = document.createElement('button')
  close.className = 'bil-tab-close'
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', `Close ${label} tab`)
  shell.append(tab, close)
  ctx.tabs.appendChild(shell)
  ctx.folderTabElements.set(viewId, { shell, tab, close, label: labelElement })
  return { shell, tab, close, label: labelElement }
}

function switchCustomView(node, viewId) {
  const ctx = node.__bil
  const destination = ctx?.browser.folderViews.get(viewId)
  if (!ctx || !destination) return
  const current = activeBrowser(ctx)
  if (current && ctx.list && ctx.browser.activeView !== viewId) current.scrollTop = ctx.list.scrollTop
  ctx.browser.activeView = viewId
  ctx.conveyorTab?.setAttribute('aria-selected', 'false')
  ctx.inputTab?.setAttribute('aria-selected', 'false')
  for (const [candidateView, elements] of ctx.folderTabElements) {
    elements.tab?.setAttribute('aria-selected', String(candidateView === viewId))
    elements.shell?.classList.toggle('bil-tab-active', candidateView === viewId)
  }
  ctx.pendingScrollRestore = { view: viewId, scrollTop: destination.scrollTop || 0 }
  ctx.renderedRangeKey = ''
  requestMainRender(node)
  updateEnhancedControls(node)
}

function closeCustomView(node, viewId) {
  const ctx = node.__bil
  if (!ctx?.browser.folderViews.has(viewId)) return
  const order = ctx.browser.tabOrder
  const index = order.indexOf(viewId)
  if (ctx.browser.activeView === viewId) {
    const fallback = order[index + 1] ?? order[index - 1] ?? 'input'
    if (fallback === 'input') ctx.inputTab.click()
    else if (fallback === 'conveyor') ctx.conveyorTab.click()
    else switchCustomView(node, fallback)
  }
  ctx.browser.folderViews.delete(viewId)
  ctx.browser.tabOrder = order.filter((entry) => entry !== viewId)
  ctx.folderTabElements.get(viewId)?.shell?.remove()
  ctx.folderTabElements.delete(viewId)
  requestMainRender(node)
}

function openCharacterLibrary(node, character) {
  const ctx = node.__bil
  if (!ctx || !character) return
  const viewId = `character:${character.preset_id}`
  if (!ctx.browser.folderViews.has(viewId)) {
    const browser = {
      sourceId: `${CHARACTER_SOURCE_PREFIX}${character.preset_id}`,
      sourceKind: 'character',
      characterId: character.preset_id,
      folderPath: '',
      query: '',
      sort: ctx.icx.lastLibrarySort,
      size: activeBrowser(ctx)?.size || 'medium',
      scrollTop: 0,
      focusedId: null,
      lastSelectedId: null,
      entries: characterEntries(ctx, character),
      selected: new Set(),
      loading: false,
      error: ''
    }
    ctx.browser.folderViews.set(viewId, browser)
    ctx.browser.folderSources.set(browser.sourceId, {
      id: browser.sourceId,
      name: character.name || 'Character',
      directories: new Set(['']),
      files: []
    })
    ctx.browser.tabOrder.push(viewId)
    const elements = customTabElements(node, viewId, character.name || 'Character', character.folder)
    elements.tab.addEventListener('click', () => switchCustomView(node, viewId))
    elements.close.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      closeCustomView(node, viewId)
    })
  }
  switchCustomView(node, viewId)
}

async function openActiveCharacterLibrary(node) {
  try {
    const character = await activeCharacter(node)
    if (!character) {
      window.alert('Save or load a character preset first. Its character folder is created automatically.')
      return
    }
    openCharacterLibrary(node, character)
  } catch (error) {
    window.alert(error?.message || 'Unable to open the character library.')
  }
}

function selectedServerPaths(node) {
  const ctx = node.__bil
  if (!ctx || !isServerLibraryView(ctx)) return []
  const browser = activeBrowser(ctx)
  const selected = browser?.selected ?? new Set()
  const byPath = new Set()
  for (const item of ctx.visibleItems ?? []) {
    if (item?.kind === 'folder' || !selected.has(viewItemId(item))) continue
    const path = itemInputPath(item)
    if (path) byPath.add(path)
  }
  if (byPath.size < selected.size) {
    for (const file of ctx.icx.allFiles) {
      const path = normalizePath(file.relative_path)
      if (selected.has(path)) byPath.add(path)
    }
  }
  return Array.from(byPath)
}

async function moveInputPaths(node, paths, destinationSubfolder, { collisionSafe = false } = {}) {
  const normalized = Array.from(new Set(paths.map(normalizePath).filter(Boolean)))
  if (!normalized.length) return null
  const payload = await jsonRequest('/image-conveyor/input-files/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      relative_paths: normalized,
      destination_subfolder: destinationSubfolder,
      protected_paths: Array.from(getQueuedInputPaths()),
      collision_safe: collisionSafe
    })
  })
  const moved = Array.isArray(payload?.moved) ? payload.moved : []
  if (moved.length) rewriteLivePaths(moved)
  await refreshPresetCaches()
  await syncCharacterFolders(true).catch(() => {})
  refreshAllInputs()
  for (const candidate of enhancedNodes) {
    if (candidate.__bil?.icx?.inputMode === 'folders') void loadInputDirectories(candidate)
  }
  return payload
}

async function moveSelectedInput(node) {
  const ctx = node.__bil
  const paths = selectedServerPaths(node)
  if (!paths.length) return
  const browser = activeBrowser(ctx)
  const character = browser?.sourceKind === 'character' ? characterCache.get(browser.characterId) : null
  const currentFolder = character?.folder ?? (browser?.sourceKind === 'server-input' ? browser.folderPath : '') ?? ''
  const destination = window.prompt(
    `Move ${paths.length} selected input image${paths.length === 1 ? '' : 's'} to which input subfolder?\n\n` +
    'Use an existing folder path or type a new one. Leave empty to move to the input root.\n\n' +
    'Moving changes the ComfyUI input-relative path. Open Image Conveyor entries and saved character references are relinked automatically; closed workflow files may still contain the old path.',
    currentFolder
  )
  if (destination == null) return
  const normalizedDestination = normalizeFolder(destination)
  if (normalizedDestination == null) {
    window.alert('Invalid destination. Relative input subfolders cannot contain . or .. path segments.')
    return
  }
  try {
    const result = await moveInputPaths(node, paths, normalizedDestination)
    const moved = result?.moved?.length ?? 0
    const skipped = result?.skipped ?? []
    const summary = [`Moved ${moved} image${moved === 1 ? '' : 's'}.`]
    if (skipped.length) summary.push(`${skipped.length} skipped: ${skipped[0]?.reason || 'filesystem changed'}`)
    window.alert(summary.join('\n'))
  } catch (error) {
    window.alert(error?.message || 'Unable to move the selected input images.')
  }
}

async function deleteSelectedInput(node) {
  const paths = selectedServerPaths(node)
  if (!paths.length) return
  const confirmed = window.confirm(
    `Delete ${paths.length} selected input image${paths.length === 1 ? '' : 's'} from disk?\n\n` +
    'This permanently removes the file from ComfyUI’s Input Folder.\n' +
    '“Remove from Conveyor” only removes a queue entry and leaves its file on disk.\n\n' +
    'Open Conveyor/reference entries that use deleted paths will be removed or cleared. ' +
    'Saved character references are cleared before deletion. Saved workflows that are not currently open may still contain the old path.'
  )
  if (!confirmed) return
  try {
    const payload = await jsonRequest('/image-conveyor/input-files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relative_paths: paths,
        protected_paths: Array.from(getQueuedInputPaths())
      })
    })
    const deleted = Array.isArray(payload?.deleted) ? payload.deleted : []
    removeLivePaths(deleted.map((entry) => entry.relative_path))
    await refreshPresetCaches()
    await syncCharacterFolders(true).catch(() => {})
    refreshAllInputs()
    for (const candidate of enhancedNodes) {
      if (candidate.__bil?.icx?.inputMode === 'folders') void loadInputDirectories(candidate)
    }
    const skipped = Array.isArray(payload?.skipped) ? payload.skipped : []
    const summary = [`Deleted ${deleted.length} image${deleted.length === 1 ? '' : 's'} from disk.`]
    if (payload?.presets_cleared) summary.push(`Cleared ${payload.presets_cleared} saved character reference${payload.presets_cleared === 1 ? '' : 's'}.`)
    if (skipped.length) summary.push(`${skipped.length} skipped: ${skipped[0]?.reason || 'filesystem changed'}`)
    window.alert(summary.join('\n'))
  } catch (error) {
    window.alert(error?.message || 'Unable to delete the selected input images.')
  }
}

async function uploadFiles(files, destinationFolder = '') {
  const uploaded = []
  const errors = []
  let refreshed = false
  for (const file of Array.from(files ?? []).filter(isImageFile)) {
    try {
      const body = new FormData()
      body.append('image', file)
      body.append('type', 'input')
      body.append('subfolder', destinationFolder)
      if (!refreshed) body.append('refresh_snapshot', 'true')
      const payload = await jsonRequest('/image-conveyor/resolve-upload', { method: 'POST', body })
      const path = normalizePath(payload?.relative_path || `${payload?.subfolder ? `${payload.subfolder}/` : ''}${payload?.name || ''}`)
      if (!path) throw new Error(`Invalid upload response for '${file.name}'.`)
      uploaded.push({ ...payload, relative_path: path, file })
      refreshed = true
    } catch (error) {
      errors.push({ file, error })
    }
  }
  return { uploaded, errors }
}

async function assignReferences(node, startIndex, items = [], externalFiles = []) {
  let character
  try {
    character = await activeCharacter(node)
  } catch (error) {
    console.error('Image Conveyor: reference assignment aborted because the character folder could not be refreshed.', error)
    window.alert(error?.message || 'Unable to refresh the active character folder. The reference drop was not applied.')
    return false
  }
  const references = []
  const memberPaths = []
  const errors = []
  let uploadedAnything = false
  let membershipSaved = false

  for (const item of items) {
    if (item?.localFile instanceof File) continue
    const path = itemInputPath(item)
    if (!path) continue
    const reference = pathToReference(path)
    if (!reference) continue
    references.push(reference)
    memberPaths.push(path)
  }

  const localItems = items.filter((item) => item?.localFile instanceof File)
  if (character && (localItems.length || externalFiles.length)) {
    const result = await uploadFiles(
      [...localItems.map((item) => item.localFile), ...Array.from(externalFiles).filter(isImageFile)],
      character.folder
    )
    uploadedAnything = result.uploaded.length > 0
    for (const entry of result.uploaded) {
      const reference = pathToReference(entry.relative_path)
      if (reference) {
        references.push(reference)
        memberPaths.push(entry.relative_path)
      }
    }
    errors.push(...result.errors)
  } else {
    for (const item of localItems) {
      const destination = normalizeFolder(item.relativeSubfolder ?? item.subfolder ?? '')
      const result = await uploadFiles([item.localFile], destination == null ? '' : destination)
      uploadedAnything ||= result.uploaded.length > 0
      for (const entry of result.uploaded) {
        const reference = pathToReference(entry.relative_path)
        if (reference) references.push(reference)
      }
      errors.push(...result.errors)
    }
  }

  if (character && memberPaths.length) {
    try {
      await addCharacterMembers(character, Array.from(new Set(memberPaths)))
      membershipSaved = true
    } catch (error) {
      errors.push({ file: null, error })
    }
  }

  if (references.length) {
    const state = readState(node)
    const slots = normalizeReferenceSlots(state.reference_slots)
    for (let offset = 0; offset < references.length; offset += 1) {
      const index = Number(startIndex) + offset
      if (index < 0 || index >= REFERENCE_SLOT_COUNT) break
      slots[index] = references[offset]
    }
    state.reference_slots = slots
    commitNodeState(node, state)
  }

  if (uploadedAnything) refreshAllInputs()
  if (character && membershipSaved) {
    character.members = Array.from(new Set([...character.members, ...memberPaths]))
    characterCacheRevision += 1
    for (const candidate of enhancedNodes) {
      const ext = candidate.__bil?.icx
      if (!ext) continue
      ext.dataRevision += 1
      invalidateDirectoryCache(ext)
      rebuildInputViews(candidate)
    }
  }
  if (errors.length) {
    console.error('Image Conveyor: some reference images failed to import or catalog.', ...errors.map((entry) => entry.error))
    window.alert(
      errors.length === 1
        ? (errors[0].error?.message || 'One reference image failed to import.')
        : `${errors.length} reference images failed to import or catalog. The successful images were kept.`
    )
  }
  return references.length > 0
}

function gatherCardDrag(node, slot) {
  const ctx = node.__bil
  const view = ctx.browser.activeView
  const browser = activeBrowser(ctx)
  const selected = browser?.selected ?? new Set()
  const draggedId = slot.itemId
  const useSelection = selected.has(draggedId) && selected.size > 1
  const items = useSelection
    ? (ctx.visibleItems ?? []).filter((item) => item?.kind !== 'folder' && selected.has(viewItemId(item)))
    : [slot.item]
  return {
    node,
    view,
    items: items.filter(Boolean),
    sourceCard: slot.card,
    sourceIsServerInput: isServerLibraryView(ctx, view),
    startedAt: Date.now()
  }
}

function cardSlotAtTarget(ctx, target) {
  if (!(target instanceof Node)) return null
  return ctx.cardPool?.find((slot) => slot?.itemId && slot.card?.contains(target)) ?? null
}

function handleCardDragStart(node, event) {
  const ctx = node.__bil
  const ext = ctx?.icx
  if (!ctx || !ext) return
  const slot = cardSlotAtTarget(ctx, event.target)
  if (!slot || slot.item?.kind === 'folder') return
  ext.cardDrag = gatherCardDrag(node, slot)
  if (ext.cardDrag.sourceIsServerInput && ctx.browser.activeView !== 'input') {
    event.stopImmediatePropagation()
    event.dataTransfer?.setData('application/x-image-conveyor-library', JSON.stringify({ count: ext.cardDrag.items.length }))
    event.dataTransfer?.setData('text/plain', slot.itemId)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove'
  }
}

function clearCardDrag(node) {
  const ext = node.__bil?.icx
  if (ext) ext.cardDrag = null
}

function releaseMainCardDrag(drag) {
  const sourceCard = drag?.sourceCard
  if (!(sourceCard instanceof HTMLElement)) return
  try {
    sourceCard.dispatchEvent(new Event('dragend', { bubbles: true }))
  } catch {
    // The browser will still emit its native dragend event when available.
  }
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

function folderButtonRect(ctx) {
  const layout = ctx?.referenceShelfLayout
  if (!layout?.usable || layout.width < 220) return null
  const menuWidth = Math.min(54, layout.width * 0.18)
  const saveWidth = Math.min(52, layout.width * 0.18)
  const width = Math.min(58, layout.width * 0.19)
  return {
    x: layout.right - menuWidth - saveWidth - width,
    y: layout.top + 2,
    width: width - 4,
    height: layout.headerHeight - 4
  }
}

function pointInRect(point, rect) {
  return Boolean(point && rect && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height)
}

function drawEnhancementOverlay(node, context) {
  const ctx = node.__bil
  const ext = ctx?.icx
  const layout = ctx?.referenceShelfLayout
  if (!ctx || !ext || !layout?.usable) return
  const state = ctx.state
  if (!state) return
  context.save()
  for (const index of ext.referenceSelected) {
    const slot = layout.slots[index]
    if (!slot || !state.reference_slots?.[index]) continue
    context.strokeStyle = 'rgba(135,195,255,.98)'
    context.lineWidth = 2
    context.strokeRect(slot.x + 1, slot.y + 1, Math.max(0, slot.width - 2), Math.max(0, slot.height - 2))
  }
  if (state.active_reference_preset_id && characterCache.has(String(state.active_reference_preset_id))) {
    const rect = folderButtonRect(ctx)
    if (rect) {
      context.fillStyle = 'rgba(32,38,46,.96)'
      context.fillRect(rect.x, rect.y, rect.width, rect.height)
      context.strokeStyle = 'rgba(255,255,255,.16)'
      context.lineWidth = 1
      context.strokeRect(rect.x, rect.y, rect.width, rect.height)
      context.fillStyle = 'rgba(255,255,255,.88)'
      context.font = '11px sans-serif'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText('Folder', rect.x + rect.width / 2, rect.y + rect.height / 2)
    }
  }
  context.restore()
}

function selectReferenceForDrag(node, index, event) {
  const ext = node.__bil.icx
  const state = node.__bil.state ?? readState(node)
  if (!state.reference_slots?.[index]) return false
  if (event.shiftKey && ext.referenceAnchor != null) {
    const start = Math.min(index, ext.referenceAnchor)
    const end = Math.max(index, ext.referenceAnchor)
    if (!(event.ctrlKey || event.metaKey)) ext.referenceSelected.clear()
    for (let current = start; current <= end; current += 1) {
      if (state.reference_slots[current]) ext.referenceSelected.add(current)
    }
  } else if (event.ctrlKey || event.metaKey) {
    if (ext.referenceSelected.has(index)) ext.referenceSelected.delete(index)
    else ext.referenceSelected.add(index)
    ext.referenceAnchor = index
  } else {
    if (!ext.referenceSelected.has(index)) ext.referenceSelected = new Set([index])
    ext.referenceAnchor = index
  }
  if (!ext.referenceSelected.size) ext.referenceSelected.add(index)
  const indices = Array.from(ext.referenceSelected)
    .filter((current) => state.reference_slots[current])
    .sort((a, b) => a - b)
  ext.shelfPointerDrag = {
    pointerId: event.pointerId ?? null,
    fromIndex: index,
    indices,
    references: indices.map((current) => clone(state.reference_slots[current])),
    startX: Number(event.clientX || 0),
    startY: Number(event.clientY || 0),
    active: false
  }
  node.setDirtyCanvas?.(true, false)
  return true
}

function addReferencesToConveyor(node, references) {
  const state = readState(node)
  const ui = readUiState(node)
  let added = 0
  for (const reference of references ?? []) {
    const item = queueItemFromReference(reference)
    if (!item) continue
    state.items.push(item)
    ui.source_paths[item.id] = item.source_path
    added += 1
  }
  if (added) commitNodeState(node, state, ui)
  return added
}

function finishShelfPointerDrag(node, event) {
  const ctx = node.__bil
  const ext = ctx?.icx
  const drag = ext?.shelfPointerDrag
  if (!drag) return false
  if (drag.pointerId != null && event?.pointerId != null && drag.pointerId !== event.pointerId) return false
  ext.shelfPointerDrag = null
  ctx.root?.classList.remove('bil-dragover')
  ctx.referenceDragHoverIndex = null
  document.body.classList.remove('icx-reference-grabbing')

  const target = document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target
  if (drag.active && target instanceof Node && (ctx.conveyorTab?.contains(target) || (ctx.browser.activeView === 'conveyor' && ctx.list?.contains(target)))) {
    if (ctx.conveyorTab?.contains(target) && ctx.browser.activeView !== 'conveyor') ctx.conveyorTab.click()
    addReferencesToConveyor(node, drag.references)
    node.setDirtyCanvas?.(true, true)
    return true
  }

  if (drag.active && drag.indices.length === 1) {
    const hit = shelfHit(node, event)
    if ((hit?.type === 'slot' || hit?.type === 'clear') && hit.index !== drag.fromIndex) {
      const state = readState(node)
      state.reference_slots = moveReferenceSlot(state.reference_slots, drag.fromIndex, hit.index)
      ext.referenceSelected = new Set([hit.index])
      ext.referenceAnchor = hit.index
      commitNodeState(node, state)
      return true
    }
  }
  node.setDirtyCanvas?.(true, false)
  return true
}

function cancelShelfPointerDrag(node, event) {
  const ctx = node.__bil
  const ext = ctx?.icx
  const drag = ext?.shelfPointerDrag
  if (!drag) return false
  if (drag.pointerId != null && event?.pointerId != null && drag.pointerId !== event.pointerId) return false
  ext.shelfPointerDrag = null
  ctx.root?.classList.remove('bil-dragover')
  ctx.referenceDragHoverIndex = null
  document.body.classList.remove('icx-reference-grabbing')
  node.setDirtyCanvas?.(true, false)
  return true
}

function handleShelfPointerMove(node, event) {
  const ctx = node.__bil
  const ext = ctx?.icx
  const drag = ext?.shelfPointerDrag
  if (!drag) return false
  if (drag.pointerId != null && event?.pointerId != null && drag.pointerId !== event.pointerId) return false
  const distance = Math.hypot(Number(event.clientX || 0) - drag.startX, Number(event.clientY || 0) - drag.startY)
  if (!drag.active && distance >= DRAG_THRESHOLD) drag.active = true
  if (!drag.active) return true
  document.body.classList.add('icx-reference-grabbing')
  const target = document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target
  const conveyorTarget = target instanceof Node && (ctx.conveyorTab?.contains(target) || (ctx.browser.activeView === 'conveyor' && ctx.list?.contains(target)))
  ctx.root?.classList.toggle('bil-dragover', conveyorTarget)
  const hit = conveyorTarget ? null : shelfHit(node, event)
  const hover = hit?.type === 'slot' || hit?.type === 'clear' ? hit.index : null
  if (ctx.referenceDragHoverIndex !== hover) {
    ctx.referenceDragHoverIndex = hover
    node.setDirtyCanvas?.(true, false)
  }
  event.preventDefault?.()
  return true
}

function updateEnhancedControls(node) {
  const ctx = node.__bil
  const ext = ctx?.icx
  if (!ctx || !ext) return
  const inputRoot = ctx.browser.activeView === 'input'
  const serverView = isServerLibraryView(ctx)
  const selectedCount = serverView ? (activeBrowser(ctx)?.selected?.size ?? 0) : 0
  ext.modeButton.hidden = !inputRoot
  ext.modeButton.textContent = ext.inputMode === 'folders' ? 'View: Folders' : 'View: Flat'
  ctx.root.classList.toggle('icx-folder-mode', inputRoot && ext.inputMode === 'folders')
  ext.moveButton.hidden = !serverView || selectedCount === 0
  ext.deleteDiskButton.hidden = !serverView || selectedCount === 0
  if (ctx.deleteSelectedBtn) ctx.deleteSelectedBtn.textContent = 'Remove from Conveyor'
}

function tickNode(node) {
  const ctx = node.__bil
  const ext = ctx?.icx
  if (!ctx || !ext || ctx.removed) return
  const changed = captureMainInputData(ctx)
  const presetSignature = (ctx.presets ?? []).map((preset) => `${preset.id}:${preset.name}`).join('|')
  if (presetSignature !== ext.presetSignature) {
    ext.presetSignature = presetSignature
    void syncCharacterFolders(true).catch((error) => console.warn('Image Conveyor: character-folder sync failed.', error))
  }
  if (changed || ext.characterRevision !== characterCacheRevision) {
    ext.characterRevision = characterCacheRevision
    rebuildInputViews(node)
  }
  serverSource(ctx)
  for (const [viewId, browser] of ctx.browser.folderViews) {
    if (browser.sourceId === SERVER_INPUT_SOURCE_ID && browser.sourceKind !== 'server-input') {
      browser.sourceKind = 'server-input'
      browser.sort = ext.lastLibrarySort
      ext.seenLibraryViews.add(viewId)
      browser.entries = directInputEntries(ctx, browser.folderPath)
      ctx.renderedRangeKey = ''
    } else if (!ext.seenLibraryViews.has(viewId)) {
      browser.sort = ext.lastLibrarySort
      ext.seenLibraryViews.add(viewId)
    } else if (!VALID_LIBRARY_SORTS.has(browser.sort)) {
      browser.sort = ext.lastLibrarySort
    }
  }
  if (!VALID_LIBRARY_SORTS.has(ctx.browser.input.sort)) ctx.browser.input.sort = ext.lastLibrarySort
  updateEnhancedControls(node)
}

function installStyles() {
  if (document.getElementById('image-conveyor-library-ops-style')) return
  const style = document.createElement('style')
  style.id = 'image-conveyor-library-ops-style'
  style.textContent = `
    .bil-root.icx-folder-mode .icx-folder-select { display: none !important; }
    .icx-delete-disk { border-color: rgba(255,105,105,.55) !important; color: #ffb1b1 !important; }
    body.icx-reference-grabbing, body.icx-reference-grabbing * { cursor: grabbing !important; }
  `
  document.head.appendChild(style)
}

function installNodeEnhancement(node) {
  const ctx = node.__bil
  if (!ctx || ctx.icx || ctx.removed) return false
  installStyles()
  const ext = {
    inputMode: 'flat',
    allFiles: Array.isArray(ctx.browser.input.files) ? ctx.browser.input.files : [],
    displayFiles: null,
    serverDirectories: new Set(),
    directoryCache: new Set(),
    directoryCacheRevision: -1,
    seenInputVersion: ctx.inputVersion,
    dataRevision: 0,
    lastLibrarySort: DEFAULT_LIBRARY_SORT,
    seenLibraryViews: new Set(),
    directoriesBusy: false,
    characterRevision: characterCacheRevision,
    presetSignature: '',
    cardDrag: null,
    dropTargetCard: null,
    referenceSelected: new Set(),
    referenceAnchor: null,
    shelfPointerDrag: null,
    removed: false
  }
  ctx.icx = ext
  ctx.browser.input.sort = DEFAULT_LIBRARY_SORT
  if (ctx.inputSort) ctx.inputSort.value = DEFAULT_LIBRARY_SORT
  ctx.folderSelect?.classList.add('icx-folder-select')
  if (ctx.deleteSelectedBtn) ctx.deleteSelectedBtn.textContent = 'Remove from Conveyor'

  const secondary = ctx.refreshBtn?.parentElement
  const modeButton = document.createElement('button')
  modeButton.className = 'bil-btn'
  modeButton.type = 'button'
  modeButton.textContent = 'View: Flat'
  modeButton.title = 'Toggle between the current flattened recursive Input Folder view and real folder navigation'
  if (secondary) secondary.insertBefore(modeButton, ctx.refreshBtn)
  ext.modeButton = modeButton

  const moveButton = document.createElement('button')
  moveButton.className = 'bil-btn'
  moveButton.type = 'button'
  moveButton.textContent = 'Move files…'
  moveButton.hidden = true
  const deleteDiskButton = document.createElement('button')
  deleteDiskButton.className = 'bil-btn icx-delete-disk'
  deleteDiskButton.type = 'button'
  deleteDiskButton.textContent = 'Delete files from disk…'
  deleteDiskButton.hidden = true
  const clearButton = Array.from(ctx.contextBar?.querySelectorAll('button') ?? []).at(-1)
  if (ctx.contextBar) {
    ctx.contextBar.insertBefore(moveButton, clearButton ?? null)
    ctx.contextBar.insertBefore(deleteDiskButton, clearButton ?? null)
  }
  ext.moveButton = moveButton
  ext.deleteDiskButton = deleteDiskButton

  modeButton.addEventListener('click', () => {
    ext.inputMode = ext.inputMode === 'flat' ? 'folders' : 'flat'
    ctx.browser.input.folder = 'all'
    ctx.browser.input.scrollTop = 0
    if (ctx.browser.activeView === 'input') ctx.list.scrollTop = 0
    if (ext.inputMode === 'folders') void loadInputDirectories(node)
    rebuildInputViews(node)
    updateEnhancedControls(node)
    requestMainRender(node)
  })
  moveButton.addEventListener('click', () => void moveSelectedInput(node))
  deleteDiskButton.addEventListener('click', () => void deleteSelectedInput(node))
  ctx.inputSort?.addEventListener('change', () => {
    const value = librarySort(ctx.inputSort.value, ext.lastLibrarySort)
    ext.lastLibrarySort = value
    const browser = activeBrowser(ctx)
    if (browser) browser.sort = value
  })
  ctx.refreshBtn?.addEventListener('click', () => {
    if (ext.inputMode === 'folders') void loadInputDirectories(node)
  })

  const clearFolderDropTarget = () => {
    ext.dropTargetCard?.classList.remove('bil-drag-target')
    ext.dropTargetCard = null
  }

  ctx.root.addEventListener('dragstart', (event) => handleCardDragStart(node, event), true)
  ctx.root.addEventListener('dragend', () => {
    clearFolderDropTarget()
    queueMicrotask(() => clearCardDrag(node))
  }, true)
  ctx.root.addEventListener('click', () => queueMicrotask(() => updateEnhancedControls(node)))
  ctx.root.addEventListener('pointerup', () => queueMicrotask(() => updateEnhancedControls(node)))

  ctx.root.addEventListener('drop', (event) => {
    const drag = ext.cardDrag
    if (!drag?.sourceIsServerInput || !drag.items.length) return
    const target = cardSlotAtTarget(ctx, event.target)
    if (target?.item?.kind !== 'folder' || target.item.sourceId !== SERVER_INPUT_SOURCE_ID) return
    const paths = drag.items.map(itemInputPath).filter(Boolean)
    if (!paths.length) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation?.()
    clearFolderDropTarget()
    clearCardDrag(node)
    releaseMainCardDrag(drag)
    void moveInputPaths(node, paths, target.item.folderPath).then((result) => {
      const skipped = result?.skipped?.length ?? 0
      if (skipped) window.alert(`${skipped} image${skipped === 1 ? ' was' : 's were'} not moved: ${result.skipped[0]?.reason || 'filesystem changed'}`)
    }).catch((error) => window.alert(error?.message || 'Unable to move the selected input images.'))
  }, true)

  ext.documentDragOver = (event) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
      clearFolderDropTarget()
      return
    }
    const slot = cardSlotAtTarget(ctx, event.target)
    if (slot?.item?.kind !== 'folder' || slot.item.sourceId !== SERVER_INPUT_SOURCE_ID) {
      clearFolderDropTarget()
      return
    }
    if (ext.dropTargetCard !== slot.card) clearFolderDropTarget()
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    slot.card.classList.add('bil-drag-target')
    ext.dropTargetCard = slot.card
  }
  ext.documentDragLeave = (event) => {
    const card = ext.dropTargetCard
    if (!card) return
    const origin = event.target
    const related = event.relatedTarget
    if (!(origin instanceof Node) || !card.contains(origin)) return
    if (related instanceof Node && card.contains(related)) return
    clearFolderDropTarget()
  }
  ext.documentDragEnd = () => clearFolderDropTarget()
  ext.documentDrop = (event) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
      clearFolderDropTarget()
      return
    }
    const slot = cardSlotAtTarget(ctx, event.target)
    clearFolderDropTarget()
    if (slot?.item?.kind !== 'folder' || slot.item.sourceId !== SERVER_INPUT_SOURCE_ID) return
    const files = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile)
    if (!files.length) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation?.()
    void uploadFiles(files, slot.item.folderPath).then((result) => {
      refreshAllInputs()
      if (result.errors.length) window.alert(`${result.errors.length} image${result.errors.length === 1 ? '' : 's'} failed to import into the folder.`)
    }).catch((error) => window.alert(error?.message || 'Unable to import images into the folder.'))
  }
  document.addEventListener('dragover', ext.documentDragOver, true)
  document.addEventListener('dragleave', ext.documentDragLeave, true)
  document.addEventListener('dragend', ext.documentDragEnd, true)
  document.addEventListener('drop', ext.documentDrop, true)

  ext.documentPointerMove = (event) => { handleShelfPointerMove(node, event) }
  ext.documentPointerUp = (event) => {
    if (ext.shelfPointerDrag) finishShelfPointerDrag(node, event)
    queueMicrotask(() => updateEnhancedControls(node))
  }
  ext.documentPointerCancel = (event) => {
    if (ext.shelfPointerDrag) cancelShelfPointerDrag(node, event)
    queueMicrotask(() => updateEnhancedControls(node))
  }
  document.addEventListener('pointermove', ext.documentPointerMove, true)
  document.addEventListener('pointerup', ext.documentPointerUp, true)
  document.addEventListener('pointercancel', ext.documentPointerCancel, true)

  const previousDraw = node.onDrawForeground
  node.onDrawForeground = function (context) {
    const result = previousDraw?.call(this, context)
    tickNode(node)
    drawEnhancementOverlay(node, context)
    return result
  }

  const previousMouseDown = node.onMouseDown
  node.onMouseDown = function (event, localPosition, graphCanvas) {
    const point = nodePoint(node, event)
    if (event.button === 0 && pointInRect(point, folderButtonRect(ctx))) {
      event.preventDefault?.()
      event.stopPropagation?.()
      void openActiveCharacterLibrary(node)
      return true
    }
    const hit = shelfHit(node, event)
    if (event.button === 0 && hit?.type === 'slot') {
      const state = ctx.state ?? readState(node)
      if (state.reference_slots?.[hit.index] && selectReferenceForDrag(node, hit.index, event)) {
        event.preventDefault?.()
        event.stopPropagation?.()
        return true
      }
    }
    return previousMouseDown?.call(this, event, localPosition, graphCanvas)
  }

  const previousDragOver = node.onDragOver
  node.onDragOver = function (event) {
    const hit = shelfHit(node, event)
    if (hit?.type === 'slot' && ext.cardDrag?.items?.length) {
      event.preventDefault?.()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      ctx.referenceDragHoverIndex = hit.index
      node.setDirtyCanvas?.(true, false)
      return true
    }
    return previousDragOver?.call(this, event)
  }

  const previousDragDrop = node.onDragDrop
  node.onDragDrop = async function (event) {
    const hit = shelfHit(node, event)
    if (hit?.type === 'slot' && ext.cardDrag?.items?.length) {
      const drag = ext.cardDrag
      clearCardDrag(node)
      event.preventDefault?.()
      event.stopPropagation?.()
      ctx.referenceDragHoverIndex = null
      node.setDirtyCanvas?.(true, false)
      const state = ctx.state ?? readState(node)
      const oneLocalWithoutCharacter = drag.items.length === 1
        && drag.items[0]?.localFile instanceof File
        && !state.active_reference_preset_id
      if (oneLocalWithoutCharacter) return await previousDragDrop?.call(this, event)
      releaseMainCardDrag(drag)
      return await assignReferences(node, hit.index, drag.items, [])
    }
    if (hit?.type === 'slot') {
      const files = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile)
      const state = ctx.state ?? readState(node)
      if (state.active_reference_preset_id && files.length) {
        event.preventDefault?.()
        event.stopPropagation?.()
        ctx.referenceDragHoverIndex = null
        return await assignReferences(node, hit.index, [], files)
      }
    }
    return await previousDragDrop?.call(this, event)
  }

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    ext.removed = true
    enhancedNodes.delete(node)
    clearFolderDropTarget()
    document.removeEventListener('dragover', ext.documentDragOver, true)
    document.removeEventListener('dragleave', ext.documentDragLeave, true)
    document.removeEventListener('dragend', ext.documentDragEnd, true)
    document.removeEventListener('drop', ext.documentDrop, true)
    document.removeEventListener('pointermove', ext.documentPointerMove, true)
    document.removeEventListener('pointerup', ext.documentPointerUp, true)
    document.removeEventListener('pointercancel', ext.documentPointerCancel, true)
    document.body.classList.remove('icx-reference-grabbing')
    return previousRemoved?.apply(this, args)
  }

  enhancedNodes.add(node)
  rebuildInputViews(node)
  updateEnhancedControls(node)
  requestMainRender(node)
  void syncCharacterFolders().catch((error) => console.warn('Image Conveyor: character-folder initialization failed.', error))
  return true
}

function scheduleInstall(node, attempts = 0) {
  if (!node || node.__bil?.removed || attempts > 30) return
  if (installNodeEnhancement(node)) return
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
