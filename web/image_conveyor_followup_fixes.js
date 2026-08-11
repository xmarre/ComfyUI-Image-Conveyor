import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'
import { normalizeReferenceSlots, referenceShelfHit } from './image_conveyor_math.mjs'

const EXTENSION_NAME = 'Comfy.ImageConveyor.FollowupFixes'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const STATE_WIDGET = 'state_json'
const UI_STATE_WIDGET = 'ui_state_json'
const SERVER_INPUT_SOURCE_ID = '__image_conveyor_input__'
const nodes = new Set()
let relocationSequence = 0
let relocationSyncPromise = null
let migrationPromise = null

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

function normalizePath(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/')
  if (!raw || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return ''
  const parts = raw.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return ''
  return parts.join('/')
}

function parentPath(path) {
  const value = normalizePath(path)
  const index = value.lastIndexOf('/')
  return index < 0 ? '' : value.slice(0, index)
}

function pathName(path) {
  const value = normalizePath(path)
  const index = value.lastIndexOf('/')
  return index < 0 ? value : value.slice(index + 1)
}

function itemPath(item) {
  if (!item || item.kind === 'folder' || item.localFile) return ''
  const explicit = normalizePath(item.relative_path)
  if (explicit) return explicit
  const annotated = String(item.annotated ?? '')
  return normalizePath(annotated.replace(/ \[(input|output|temp)\]$/, ''))
}

function itemId(item) {
  return String(item?.key ?? item?.relative_path ?? item?.id ?? '')
}

function pathReference(path) {
  const normalized = normalizePath(path)
  if (!normalized) return null
  return {
    annotated: `${normalized} [input]`,
    filename: pathName(normalized),
    subfolder: parentPath(normalized),
    type: 'input'
  }
}

function widget(node, name) {
  return (node.widgets ?? []).find((entry) => entry?.name === name) ?? null
}

function readWidget(node, name, fallback) {
  const entry = widget(node, name)
  try {
    const parsed = JSON.parse(String(entry?.value ?? ''))
    return parsed && typeof parsed === 'object' ? parsed : clone(fallback)
  } catch {
    return clone(fallback)
  }
}

function readState(node) {
  const ctx = node.__bil
  const state = ctx?.state ? clone(ctx.state) : readWidget(node, STATE_WIDGET, { version: 2, items: [], reference_slots: [] })
  state.items = Array.isArray(state.items) ? state.items : []
  state.reference_slots = normalizeReferenceSlots(state.reference_slots)
  return state
}

function readUi(node) {
  const ctx = node.__bil
  const ui = ctx?.uiState ? clone(ctx.uiState) : readWidget(node, UI_STATE_WIDGET, { version: 2, selected_ids: [], source_paths: {} })
  ui.selected_ids = Array.isArray(ui.selected_ids) ? ui.selected_ids : []
  ui.source_paths = ui.source_paths && typeof ui.source_paths === 'object' ? ui.source_paths : {}
  return ui
}

function writeState(node, state, ui = readUi(node)) {
  const stateWidget = widget(node, STATE_WIDGET)
  const uiWidget = widget(node, UI_STATE_WIDGET)
  state.reference_slots = normalizeReferenceSlots(state.reference_slots)
  if (stateWidget) {
    stateWidget.value = JSON.stringify(state)
    stateWidget.callback?.(stateWidget.value)
  }
  if (uiWidget) {
    uiWidget.value = JSON.stringify(ui)
    uiWidget.callback?.(uiWidget.value)
  }
  const ctx = node.__bil
  if (ctx) {
    ctx.state = state
    ctx.uiState = ui
    ctx.renderVersion = (ctx.renderVersion || 0) + 1
    ctx.queueRevision = (ctx.queueRevision || 0) + 1
    ctx.annotatedCountsRevision = -1
  }
  node.graph?.change?.()
  renderPreservingScroll(node)
}

function activeBrowser(ctx) {
  return ctx.browser?.[ctx.browser.activeView] ?? ctx.browser?.folderViews?.get(ctx.browser.activeView) ?? null
}

function renderPreservingScroll(node) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return
  const view = ctx.browser.activeView
  const browser = activeBrowser(ctx)
  const scrollTop = Number(ctx.list?.scrollTop ?? browser?.scrollTop ?? 0)
  if (browser) browser.scrollTop = scrollTop
  ctx.renderedRangeKey = ''
  node.setDirtyCanvas?.(true, true)
  queueMicrotask(() => {
    if (node.__bil !== ctx || ctx.removed || ctx.browser.activeView !== view) return
    if (browser) browser.scrollTop = scrollTop
    if (ctx.list && ctx.list.scrollTop !== scrollTop) ctx.list.scrollTop = scrollTop
    ctx.list?.dispatchEvent(new Event('scroll'))
  })
}

async function jsonRequest(path, options = {}) {
  const response = await api.fetchApi(path, options)
  let payload = null
  try { payload = await response.json() } catch {}
  if (!response.ok) throw new Error(payload?.error || `${response.status} ${response.statusText}`)
  return payload
}

function queuedPaths() {
  const result = new Set()
  for (const node of nodes) {
    for (const item of readState(node).items) {
      if (item?.status !== 'queued') continue
      const path = itemPath(item)
      if (path) result.add(path)
    }
  }
  return result
}

function updatedEntry(entry, keepPath) {
  const next = { ...entry }
  next.relative_path = keepPath
  next.filename = pathName(keepPath)
  next.subfolder = parentPath(keepPath)
  if (next.annotated) next.annotated = `${keepPath} [input]`
  if (next.source_path) next.source_path = keepPath
  return next
}

function dedupeEntries(entries) {
  const result = []
  const seen = new Set()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.kind === 'folder') { result.push(entry); continue }
    const key = itemPath(entry) || itemId(entry)
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    result.push(entry)
  }
  return result
}

function patchLibraryCaches(mapping) {
  for (const node of nodes) {
    const ctx = node.__bil
    const ext = ctx?.icx
    if (!ctx || !ext || ctx.removed || !(ext.allFiles instanceof Array)) continue
    const rewrite = (entries) => dedupeEntries((entries ?? []).map((entry) => {
      if (!entry || entry.kind === 'folder') return entry
      const keep = mapping.get(itemPath(entry))
      return keep ? updatedEntry(entry, keep) : entry
    }))
    ext.allFiles = rewrite(ext.allFiles)

    if (ext.inputMode === 'folders') {
      const folders = (ctx.browser.input.files ?? []).filter((entry) => entry?.kind === 'folder')
      const files = ext.allFiles.filter((entry) => entry?.kind !== 'folder' && parentPath(itemPath(entry)) === '')
      ext.displayFiles = dedupeEntries([...folders, ...files])
    } else {
      ext.displayFiles = ext.allFiles
    }
    ctx.browser.input.files = ext.displayFiles

    for (const [viewId, browser] of ctx.browser.folderViews ?? []) {
      if (browser.sourceKind === 'server-input' || browser.sourceId === SERVER_INPUT_SOURCE_ID) {
        const folder = String(browser.folderPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        const folders = (browser.entries ?? []).filter((entry) => entry?.kind === 'folder')
        const files = ext.allFiles.filter((entry) => entry?.kind !== 'folder' && parentPath(itemPath(entry)) === folder)
        browser.entries = dedupeEntries([...folders, ...files])
      } else if (browser.sourceKind === 'character') {
        const folder = String(ctx.folderTabElements?.get(viewId)?.tab?.title || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        const logical = rewrite(browser.entries)
        const physical = folder ? ext.allFiles.filter((entry) => itemPath(entry).startsWith(`${folder}/`)) : []
        browser.entries = dedupeEntries([...logical, ...physical])
      }
      if (browser.selected instanceof Set) {
        const valid = new Set((browser.entries ?? browser.files ?? []).map(itemId))
        browser.selected = new Set(Array.from(browser.selected).map((id) => mapping.get(id) || id).filter((id) => valid.has(id)))
      }
    }
    ext.dataRevision = (ext.dataRevision || 0) + 1
    ext.directoryCacheRevision = -1
    renderPreservingScroll(node)
  }
}

function applyMappings(entries) {
  const mapping = new Map()
  for (const entry of entries ?? []) {
    const oldPath = normalizePath(entry?.relative_path)
    const keepPath = normalizePath(entry?.keep_path)
    if (oldPath && keepPath && oldPath !== keepPath) mapping.set(oldPath, keepPath)
  }
  if (!mapping.size) return 0

  let changedCount = 0
  for (const node of nodes) {
    const state = readState(node)
    const ui = readUi(node)
    let changed = false
    for (const item of state.items) {
      const oldPath = itemPath(item)
      const keep = mapping.get(oldPath)
      if (!keep) continue
      item.annotated = `${keep} [input]`
      item.filename = pathName(keep)
      item.subfolder = parentPath(keep)
      if (normalizePath(item.source_path) === oldPath) item.source_path = keep
      if (normalizePath(ui.source_paths[item.id]) === oldPath) ui.source_paths[item.id] = keep
      changed = true
      changedCount += 1
    }
    const slots = normalizeReferenceSlots(state.reference_slots)
    for (let index = 0; index < slots.length; index += 1) {
      const oldPath = itemPath(slots[index])
      const keep = mapping.get(oldPath)
      if (!keep) continue
      slots[index] = pathReference(keep)
      changed = true
      changedCount += 1
    }
    if (changed) {
      state.reference_slots = slots
      writeState(node, state, ui)
    }
  }
  patchLibraryCaches(mapping)
  return changedCount
}

async function refreshPresetCaches() {
  let payload
  try { payload = await jsonRequest('/image-conveyor/reference-presets') }
  catch (error) { console.warn('Image Conveyor: unable to refresh saved character references.', error); return }
  for (const node of nodes) {
    const ctx = node.__bil
    if (!ctx || ctx.removed) continue
    ctx.presets = Array.isArray(payload?.presets)
      ? payload.presets.map((preset) => ({ ...preset, slots: normalizeReferenceSlots(preset?.slots) }))
      : []
    ctx.presetsLoaded = true
    if (ctx.icx) ctx.icx.presetSignature = '__followup-refresh__'
    node.setDirtyCanvas?.(true, true)
  }
}

async function syncRelocations() {
  if (relocationSyncPromise) return relocationSyncPromise
  relocationSyncPromise = (async () => {
    const payload = await jsonRequest(`/image-conveyor/relocations?after=${relocationSequence}`)
    relocationSequence = Math.max(relocationSequence, Number(payload?.sequence || 0))
    const moved = Array.isArray(payload?.moved) ? payload.moved : []
    if (moved.length) {
      applyMappings(moved)
      await refreshPresetCaches()
    }
    return moved
  })().catch((error) => {
    console.warn('Image Conveyor: relocation synchronization failed.', error)
    return []
  }).finally(() => { relocationSyncPromise = null })
  return relocationSyncPromise
}

async function migrateCharacters() {
  if (migrationPromise) return migrationPromise
  migrationPromise = (async () => {
    const aggregate = []
    const payload = await jsonRequest('/image-conveyor/character-folders/migrate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protected_paths: Array.from(queuedPaths()) })
    })
    if (payload?.moved?.length) aggregate.push(...payload.moved)

    const live = new Map()
    for (const node of nodes) {
      const state = readState(node)
      const presetId = String(state.active_reference_preset_id || '')
      if (!presetId) continue
      let paths = live.get(presetId)
      if (!paths) { paths = new Set(); live.set(presetId, paths) }
      for (const slot of normalizeReferenceSlots(state.reference_slots)) {
        const path = itemPath(slot)
        if (path) paths.add(path)
      }
    }
    for (const [presetId, paths] of live) {
      if (!paths.size) continue
      const result = await jsonRequest(`/image-conveyor/character-folders/${encodeURIComponent(presetId)}/materialize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relative_paths: Array.from(paths), protected_paths: Array.from(queuedPaths()) })
      })
      if (result?.moved?.length) aggregate.push(...result.moved)
    }
    if (aggregate.length) applyMappings(aggregate)
    await syncRelocations()
    await refreshPresetCaches()
    for (const node of nodes) node.__bil?.refreshBtn?.click?.()
    return payload
  })().catch((error) => {
    console.warn('Image Conveyor: character-folder migration failed.', error)
    return null
  }).finally(() => { migrationPromise = null })
  return migrationPromise
}

function nodePoint(node, event) {
  try { app.canvas?.adjustMouseEvent?.(event) } catch {}
  const x = Number(event?.canvasX)
  const y = Number(event?.canvasY)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: x - Number(node.pos?.[0] || 0), y: y - Number(node.pos?.[1] || 0) }
}

function shelfHit(node, event) {
  const ctx = node.__bil
  const point = ctx?.referenceShelfLayout ? nodePoint(node, event) : null
  return point ? referenceShelfHit(ctx.referenceShelfLayout, point.x, point.y) : null
}

function installNode(node) {
  const ctx = node.__bil
  if (!ctx?.icx?.batchDragV2 || ctx.icx.followupFixes || ctx.removed) return false
  const ext = ctx.icx
  ext.followupFixes = true
  ext.followupInputVersion = ctx.inputVersion
  ext.followupMigrationSignature = ''
  nodes.add(node)

  ext.followupSearchGuard = (event) => {
    if (event.isTrusted || event.target !== ctx.searchInput) return
    if (ctx.pendingScrollRestore?.view === ctx.browser.activeView) return
    event.stopImmediatePropagation()
    const browser = activeBrowser(ctx)
    if (browser) browser.query = String(ctx.searchInput.value || '')
    renderPreservingScroll(node)
  }
  ctx.searchInput?.addEventListener('input', ext.followupSearchGuard, true)

  ext.followupScrollbarGuard = (event) => {
    if (event.button !== 0 || event.isPrimary === false || !ctx.list) return
    const rect = ctx.list.getBoundingClientRect()
    const vertical = Math.max(0, ctx.list.offsetWidth - ctx.list.clientWidth)
    const horizontal = Math.max(0, ctx.list.offsetHeight - ctx.list.clientHeight)
    const inVertical = vertical > 0 && event.clientX >= rect.right - vertical && event.clientX <= rect.right
    const inHorizontal = horizontal > 0 && event.clientY >= rect.bottom - horizontal && event.clientY <= rect.bottom
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
    if (inside && (inVertical || inHorizontal)) event.stopImmediatePropagation()
  }
  ctx.list?.addEventListener('pointerdown', ext.followupScrollbarGuard, true)

  ext.followupRefresh = () => queueMicrotask(() => void syncRelocations())
  ctx.refreshBtn?.addEventListener('click', ext.followupRefresh)

  const previousDrop = node.onDragDrop
  node.onDragDrop = async function (event) {
    const hit = shelfHit(node, event)
    const state = readState(node)
    const presetId = String(state.active_reference_preset_id || '')
    const drag = ctx.icx?.batchDrag ?? ctx.icx?.cardDrag
    const internalPaths = Array.from(drag?.items ?? []).map(itemPath).filter(Boolean)
    const protectedSet = queuedPaths()
    if (hit?.type === 'slot' && presetId && internalPaths.some((path) => protectedSet.has(path))) {
      event.preventDefault?.()
      event.stopPropagation?.()
      const result = await jsonRequest(`/image-conveyor/character-folders/${encodeURIComponent(presetId)}/materialize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relative_paths: internalPaths, protected_paths: Array.from(protectedSet) })
      })
      if (result?.moved?.length) applyMappings(result.moved)
      const refs = (result?.files ?? []).map((entry) => pathReference(entry.relative_path)).filter(Boolean)
      if (refs.length) {
        const next = readState(node)
        const slots = normalizeReferenceSlots(next.reference_slots)
        refs.forEach((ref, offset) => {
          const index = hit.index + offset
          if (index < slots.length) slots[index] = ref
        })
        next.reference_slots = slots
        writeState(node, next)
      }
      await syncRelocations()
      ctx.refreshBtn?.click?.()
      if (result?.skipped?.length) {
        window.alert(`${result.skipped.length} queued reference image${result.skipped.length === 1 ? ' was' : 's were'} left in place.`)
      }
      return true
    }
    return await previousDrop?.call(this, event)
  }

  const previousDraw = node.onDrawForeground
  node.onDrawForeground = function (...args) {
    const result = previousDraw?.apply(this, args)
    if (ext.followupInputVersion !== ctx.inputVersion) {
      ext.followupInputVersion = ctx.inputVersion
      renderPreservingScroll(node)
    }
    const state = readState(node)
    const saved = (ctx.presets ?? []).map((preset) => `${preset.id}:${(preset.slots ?? []).map((slot) => slot?.annotated || '').join(',')}`).join('|')
    const live = `${state.active_reference_preset_id || ''}:${normalizeReferenceSlots(state.reference_slots).map((slot) => slot?.annotated || '').join(',')}`
    const queued = Array.from(queuedPaths()).sort().join(',')
    const signature = `${saved}|live=${live}|queued=${queued}`
    if (signature !== ext.followupMigrationSignature) {
      ext.followupMigrationSignature = signature
      void migrateCharacters()
    }
    return result
  }

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    nodes.delete(node)
    ctx.searchInput?.removeEventListener('input', ext.followupSearchGuard, true)
    ctx.list?.removeEventListener('pointerdown', ext.followupScrollbarGuard, true)
    ctx.refreshBtn?.removeEventListener('click', ext.followupRefresh)
    return previousRemoved?.apply(this, args)
  }

  queueMicrotask(() => {
    void syncRelocations()
    void migrateCharacters()
  })
  return true
}

function scheduleInstall(node, attempts = 0) {
  if (!node || node.__bil?.removed || attempts > 90) return
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
