import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'
import { libraryRefreshScrollRestore } from './image_conveyor_drag_math.mjs'
import { referenceShelfHit } from './image_conveyor_math.mjs'
import {
  characterEntriesFromIndex,
  characterReferenceIndexNeedsRefresh
} from './image_conveyor_character_materialization_sync_math.mjs'

const EXTENSION_NAME = 'Comfy.ImageConveyor.CharacterMaterializationSync'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const patchedNodes = new WeakSet()
const RECONCILE_TIMEOUT_MS = 30000

function nodePoint(node, event) {
  try { app.canvas?.adjustMouseEvent?.(event) } catch {}
  const canvasX = Number(event?.canvasX)
  const canvasY = Number(event?.canvasY)
  if (!Number.isFinite(canvasX) || !Number.isFinite(canvasY)) return null
  return {
    x: canvasX - Number(node.pos?.[0] || 0),
    y: canvasY - Number(node.pos?.[1] || 0)
  }
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
  return Boolean(
    point && rect
    && point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height
  )
}

function activePresetId(node) {
  return String(node.__bil?.state?.active_reference_preset_id || '')
}

function characterFolderClick(node, event) {
  const presetId = activePresetId(node)
  if (!presetId || event?.button !== 0) return ''
  return pointInRect(nodePoint(node, event), folderButtonRect(node.__bil)) ? presetId : ''
}

function characterReferenceDrop(node, event) {
  const presetId = activePresetId(node)
  if (!presetId) return ''
  const hit = shelfHit(node, event)
  return hit?.type === 'slot' ? presetId : ''
}

function browserForView(ctx, view) {
  return ctx.browser?.[view] ?? ctx.browser?.folderViews?.get(view) ?? null
}

function syncSharedInputIndex(ctx) {
  const ext = ctx?.icx
  if (!ext) return false
  const current = ctx.browser?.input?.files
  const versionChanged = ext.seenInputVersion !== ctx.inputVersion
  if (!versionChanged && current === ext.displayFiles) return false

  if (current !== ext.displayFiles) {
    ext.allFiles = Array.isArray(current)
      ? current.filter((entry) => entry?.kind !== 'folder')
      : []
  } else if (versionChanged) {
    const byPath = new Map(
      (ext.allFiles ?? [])
        .map((entry) => [String(entry?.relative_path || ''), entry])
        .filter(([path]) => path)
    )
    for (const entry of current ?? []) {
      if (!entry || entry.kind === 'folder') continue
      const path = String(entry.relative_path || '')
      if (path) byPath.set(path, entry)
    }
    ext.allFiles = Array.from(byPath.values())
  }

  ext.seenInputVersion = ctx.inputVersion
  ext.dataRevision = (ext.dataRevision || 0) + 1
  ext.directoryCacheRevision = -1
  ctx.renderedRangeKey = ''
  return true
}

function refreshInputPreservingView(node) {
  const ctx = node.__bil
  if (!ctx || ctx.removed) return
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

function requestCharacterCacheRefresh(node) {
  const ctx = node.__bil
  if (!ctx?.icx || ctx.removed) return
  // library_ops treats presetSignature as the cache key for authoritative character metadata.
  // Invalidating only that key asks its existing draw hook to perform one normal registry sync;
  // it does not invoke migration or materialization.
  ctx.icx.presetSignature = null
  node.setDirtyCanvas?.(true, false)
}

async function fetchCharacter(presetId) {
  const response = await api.fetchApi('/image-conveyor/character-folders')
  let payload = null
  try { payload = await response.json() } catch {}
  if (!response.ok) throw new Error(payload?.error || `${response.status} ${response.statusText}`)
  return (Array.isArray(payload?.characters) ? payload.characters : []).find(
    (entry) => String(entry?.preset_id || '') === String(presetId || '')
  ) ?? null
}

function reconcileCharacterViewWhenReady(node, character) {
  if (!character?.preset_id) return
  const ctx = node.__bil
  const startedAt = performance.now()
  const viewId = `character:${character.preset_id}`

  const check = () => {
    if (node.__bil !== ctx || !ctx?.icx || ctx.removed) return
    if (performance.now() - startedAt > RECONCILE_TIMEOUT_MS) {
      console.warn('Image Conveyor: timed out while reconciling character folder contents.')
      return
    }
    if (ctx.browser?.input?.loading) {
      setTimeout(check, 24)
      return
    }

    syncSharedInputIndex(ctx)
    const browser = ctx.browser?.folderViews?.get(viewId)
    if (!browser) {
      requestAnimationFrame(check)
      return
    }

    browser.entries = characterEntriesFromIndex(ctx.icx.allFiles, character)
    browser.error = ''
    ctx.renderedRangeKey = ''
    node.setDirtyCanvas?.(true, true)
  }

  check()
}

function refreshCharacterMetadata(node, presetId) {
  if (!presetId) return
  void fetchCharacter(presetId)
    .then((character) => {
      if (character) reconcileCharacterViewWhenReady(node, character)
    })
    .catch((error) => console.warn('Image Conveyor: unable to refresh character folder metadata.', error))
}

function ensureReferenceIndexContainsLiveSlots(node, inputRequestBefore) {
  const ctx = node.__bil
  if (!ctx?.icx || ctx.removed) return
  const startedAt = performance.now()

  const check = () => {
    if (node.__bil !== ctx || !ctx?.icx || ctx.removed) return
    if (Number(ctx.inputRequestId || 0) !== Number(inputRequestBefore || 0)) return
    if (performance.now() - startedAt > RECONCILE_TIMEOUT_MS) {
      console.warn('Image Conveyor: timed out while checking the character reference file index.')
      return
    }
    if (ctx.browser?.input?.loading) {
      setTimeout(check, 24)
      return
    }

    syncSharedInputIndex(ctx)
    const slots = ctx.state?.reference_slots
    if (!characterReferenceIndexNeedsRefresh(slots, ctx.icx.allFiles)) return
    refreshInputPreservingView(node)
  }

  check()
}

function installNode(node, attempts = 0) {
  if (!node || attempts > 180 || patchedNodes.has(node)) return
  const ctx = node.__bil
  // Install only after the batch drag layer exists so this wrapper observes its final result.
  if (!ctx?.icx?.batchWindowDrop || typeof node.onDragDrop !== 'function' || typeof node.onMouseDown !== 'function') {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }

  patchedNodes.add(node)

  const previousMouseDown = node.onMouseDown
  node.onMouseDown = function (event, localPosition, graphCanvas) {
    const presetId = characterFolderClick(node, event)
    const result = previousMouseDown?.call(this, event, localPosition, graphCanvas)
    if (presetId) refreshCharacterMetadata(node, presetId)
    return result
  }

  const previousDragDrop = node.onDragDrop
  node.onDragDrop = async function (event) {
    const presetId = characterReferenceDrop(node, event)
    const inputRequestBefore = Number(ctx.inputRequestId || 0)
    const result = await previousDragDrop?.call(this, event)
    if (!presetId || !result || node.__bil !== ctx || ctx.removed) return result

    // The older materialization path refreshes when it physically moves/deduplicates a file.
    // A new local upload can already live in the target character folder, producing moved=[]
    // even though the frontend Input index is stale. Refresh only when no refresh was already
    // started and the live reference slots prove that the current index is missing a path.
    // If another Input refresh was already running before this drop, let it finish first and
    // only start a second request if its completed result still lacks the new reference path.
    ensureReferenceIndexContainsLiveSlots(node, inputRequestBefore)

    // Membership can change without a physical move (shared canonical references). Reconcile
    // the visible character collection immediately and invalidate library_ops' metadata cache
    // so future rebuilds also use the authoritative registry state.
    requestCharacterCacheRefresh(node)
    refreshCharacterMetadata(node, presetId)
    return result
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
