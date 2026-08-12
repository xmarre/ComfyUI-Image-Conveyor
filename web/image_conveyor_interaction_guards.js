import { app } from '../../scripts/app.js'
import { referenceShelfHit } from './image_conveyor_math.mjs'

const EXTENSION_NAME = 'Comfy.ImageConveyor.InteractionGuards'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const INTERNAL_REFERENCE_MIME = 'application/x-image-conveyor-reference'
const SERVER_INPUT_SOURCE_ID = '__image_conveyor_input__'
const patchedNodes = new WeakSet()

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

function itemPath(item) {
  if (!item || item.kind === 'folder' || item.localFile) return ''
  const explicit = normalizePath(item.relative_path)
  if (explicit) return explicit
  if (String(item.type ?? 'input').toLowerCase() !== 'input') return ''
  return normalizePath(String(item.annotated ?? '').replace(/ \[(input|output|temp)\]$/, ''))
}

function activeBrowser(ctx) {
  return ctx.browser?.[ctx.browser.activeView] ?? ctx.browser?.folderViews?.get(ctx.browser.activeView) ?? null
}

function cardSlotAtTarget(ctx, target) {
  if (!(target instanceof Node)) return null
  return ctx.cardPool?.find((slot) => slot?.itemId && slot.card?.contains(target)) ?? null
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

function allServerDirectories(ext) {
  const result = new Set(Array.from(ext.serverDirectories ?? []).map(normalizeFolder).filter(Boolean))
  for (const entry of ext.allFiles ?? []) {
    let current = normalizeFolder(entry?.subfolder)
    while (current) {
      result.add(current)
      current = parentPath(current)
    }
  }
  return result
}

function directEntries(ext, folderPath = '') {
  const folder = normalizeFolder(folderPath) || ''
  const entries = []
  for (const directory of allServerDirectories(ext)) {
    if (parentPath(directory) === folder) entries.push(folderEntry(directory))
  }
  for (const file of ext.allFiles ?? []) {
    if ((normalizeFolder(file?.subfolder) || '') === folder) entries.push(file)
  }
  return entries
}

function preserveActiveScroll(ctx, view = ctx.browser.activeView, scrollTop = null) {
  const browser = ctx.browser?.[view] ?? ctx.browser?.folderViews?.get(view) ?? null
  const value = Number(scrollTop ?? ctx.list?.scrollTop ?? browser?.scrollTop ?? 0)
  if (browser) browser.scrollTop = value
  ctx.pendingScrollRestore = { view, scrollTop: value }
  ctx.renderedRangeKey = ''
  return value
}

function installFolderModeRefreshGuard(node, ctx, ext) {
  const input = ctx.browser?.input
  if (!input || input.__icxFolderRefreshGuard) return
  input.__icxFolderRefreshGuard = true

  let filesValue = input.files
  let assignmentGeneration = 0
  Object.defineProperty(input, 'files', {
    configurable: true,
    enumerable: true,
    get() { return filesValue },
    set(next) {
      filesValue = next
      if (
        ext.inputMode !== 'folders' ||
        next === ext.displayFiles ||
        !Array.isArray(next) ||
        next.some((entry) => entry?.kind === 'folder')
      ) return

      const generation = ++assignmentGeneration
      const view = ctx.browser.activeView
      const scrollTop = Number(ctx.list?.scrollTop ?? activeBrowser(ctx)?.scrollTop ?? 0)
      queueMicrotask(() => {
        if (
          generation !== assignmentGeneration ||
          node.__bil !== ctx ||
          ctx.removed ||
          ext.inputMode !== 'folders' ||
          filesValue !== next
        ) return

        // refreshInputFiles() temporarily assigns the authoritative flat snapshot to
        // browser.input.files. Capture that snapshot, then restore the folder-mode backing
        // lists before the requestAnimationFrame render scheduled by the main module runs.
        // This prevents both the visible Flat-view flash/reset and the scroll clamp to 0.
        ext.allFiles = next.filter((entry) => entry && entry.kind !== 'folder')
        ext.dataRevision = (ext.dataRevision || 0) + 1
        ext.directoryCacheRevision = -1
        ext.directoryCache = new Set()
        ext.displayFiles = directEntries(ext, '')
        filesValue = ext.displayFiles

        for (const browser of ctx.browser.folderViews?.values?.() ?? []) {
          if (browser.sourceKind === 'server-input' || browser.sourceId === SERVER_INPUT_SOURCE_ID) {
            browser.sourceKind = 'server-input'
            browser.entries = directEntries(ext, browser.folderPath)
          }
        }

        // The main refresh increments inputVersion immediately after assigning `files`.
        // Mark that authoritative generation as consumed so the older draw-time bridge does
        // not mistake the restored folder list for a new flat snapshot on the next canvas draw.
        ext.seenInputVersion = ctx.inputVersion
        preserveActiveScroll(ctx, view, scrollTop)
        node.setDirtyCanvas?.(true, true)
      })
    }
  })
}

function internalDragKind(event) {
  try {
    const raw = event?.dataTransfer?.getData?.(INTERNAL_REFERENCE_MIME)
    if (!raw) return ''
    const payload = JSON.parse(raw)
    return String(payload?.kind || '')
  } catch {
    return ''
  }
}

function installDragEffectContract() {
  if (window.__imageConveyorDragEffectContractInstalled) return
  window.__imageConveyorDragEffectContractInstalled = true

  // Bubble phase is intentional. The card's own dragstart handler writes the custom MIME
  // payload first; a capture-phase listener runs too early and cannot know whether this is an
  // Input/Conveyor drag. Local/external imports remain copy-only.
  window.addEventListener('dragstart', (event) => {
    const transfer = event.dataTransfer
    if (!transfer) return
    const kind = internalDragKind(event)
    if (kind !== 'input' && kind !== 'conveyor') return
    try { transfer.effectAllowed = 'copyMove' } catch {}
  })
}

function installPresetMenuStyles() {
  if (document.getElementById('image-conveyor-preset-menu-contrast')) return
  const style = document.createElement('style')
  style.id = 'image-conveyor-preset-menu-contrast'
  style.textContent = `
    .bil-reference-preset-popover { color-scheme: dark !important; }
    .bil-reference-preset-popover select,
    .bil-reference-preset-popover .bil-select {
      background: #202124 !important;
      color: #f2f2f2 !important;
      border-color: rgba(255,255,255,.24) !important;
      color-scheme: dark !important;
    }
    .bil-reference-preset-popover option {
      background: #202124 !important;
      color: #f2f2f2 !important;
    }
    .bil-reference-preset-popover .bil-btn {
      background: rgba(255,255,255,.075) !important;
      color: #f2f2f2 !important;
    }
    .bil-reference-preset-popover .bil-btn:hover,
    .bil-reference-preset-popover .bil-btn:focus-visible {
      background: rgba(120,175,240,.20) !important;
    }
  `
  document.head.appendChild(style)
}

function referenceHit(node, ctx, event) {
  if (!ctx?.referenceShelfLayout) return null
  try { app.canvas?.adjustMouseEvent?.(event) } catch {}
  const canvasX = Number(event?.canvasX)
  const canvasY = Number(event?.canvasY)
  if (!Number.isFinite(canvasX) || !Number.isFinite(canvasY)) return null
  const point = {
    x: canvasX - Number(node.pos?.[0] || 0),
    y: canvasY - Number(node.pos?.[1] || 0)
  }
  return referenceShelfHit(ctx.referenceShelfLayout, point.x, point.y)
}

function clearReferencePointerState(node, ctx) {
  if (!ctx || ctx.removed) return false
  let changed = false
  if (ctx.referenceShelfPointerDrag || ctx.referenceDragSourceIndex != null || ctx.referenceDragHoverIndex != null) {
    ctx.referenceShelfPointerDrag = null
    ctx.referenceDragSourceIndex = null
    ctx.referenceDragHoverIndex = null
    changed = true
  }
  const ext = ctx.icx
  if (ext?.referenceSelected?.size) {
    ext.referenceSelected.clear()
    ext.referenceAnchor = null
    changed = true
  }
  if (changed) node.setDirtyCanvas?.(true, false)
  return changed
}

function isManagedFolderTabTarget(ctx, target) {
  if (!(target instanceof Node)) return false
  if (ctx.conveyorTab?.contains(target) || ctx.inputTab?.contains(target)) return true
  for (const elements of ctx.folderTabElements?.values?.() ?? []) {
    if (elements?.tab?.contains(target)) return true
  }
  return false
}

function shouldSuppressSameFolderBodyDrop(ctx, ext, event) {
  const batch = ext.batchDrag ?? ext.cardDrag
  if (!batch?.items?.length || !(event.target instanceof Node) || !ctx.list?.contains(event.target)) return false
  if (isManagedFolderTabTarget(ctx, event.target)) return false
  const targetSlot = cardSlotAtTarget(ctx, event.target)
  if (targetSlot?.item?.kind === 'folder') return false

  const view = ctx.browser.activeView
  if (view === 'input') {
    // Flat mode represents the whole recursive Input tree, not one physical destination.
    // Treating its body as input-root silently moves nested files to root.
    if (ext.inputMode !== 'folders') return true
  }
  const browser = activeBrowser(ctx)
  let destination = ''
  if (view !== 'input') {
    if (!(browser?.sourceKind === 'server-input' || browser?.sourceId === SERVER_INPUT_SOURCE_ID)) return false
    destination = normalizeFolder(browser.folderPath || '') || ''
  }

  const paths = batch.items.map(itemPath).filter(Boolean)
  return paths.length > 0 && paths.every((path) => parentPath(path) === destination)
}

function clearBatchHover(ext) {
  if (ext.batchHover?.timer) clearTimeout(ext.batchHover.timer)
  ext.batchHover?.element?.classList.remove('icx-batch-drop-target')
  ext.batchHover = null
}

function installBatchDropGuard(ctx, ext) {
  if (!ext.batchWindowDrop || ext.__icxSameFolderDropGuard) return false
  ext.__icxSameFolderDropGuard = true
  const original = ext.batchWindowDrop
  window.removeEventListener('drop', original, true)
  ext.batchWindowDrop = (event) => {
    if (shouldSuppressSameFolderBodyDrop(ctx, ext, event)) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
      clearBatchHover(ext)
      // Native dragend owns final drag-state cleanup. This is a deliberate no-op: dropping an
      // Input file back onto an image/background in its own physical folder is not a filesystem
      // move and must not be sent to the backend as one.
      return
    }
    return original(event)
  }
  window.addEventListener('drop', ext.batchWindowDrop, true)
  return true
}

function installNode(node, attempts = 0) {
  if (!node || node.__bil?.removed || attempts > 120) return
  const ctx = node.__bil
  const ext = ctx?.icx
  if (!ctx || !ext || !ext.batchWindowDrop) {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }
  if (patchedNodes.has(node)) return
  patchedNodes.add(node)

  installFolderModeRefreshGuard(node, ctx, ext)
  installBatchDropGuard(ctx, ext)

  const documentMouseUp = () => {
    // LiteGraph's canvas mouseup gets first chance to finish a legitimate shelf reorder.
    // If the release happened outside the canvas/node, its handler never runs; clear the
    // still-live pointer state after normal mouseup propagation.
    queueMicrotask(() => {
      if (node.__bil === ctx && ctx.referenceShelfPointerDrag) clearReferencePointerState(node, ctx)
    })
  }
  const documentPointerDown = (event) => {
    if (event.button !== 0) return
    const hit = referenceHit(node, ctx, event)
    if (hit?.type === 'slot' || hit?.type === 'clear') return
    clearReferencePointerState(node, ctx)
  }
  const documentPointerCancel = () => clearReferencePointerState(node, ctx)
  const windowBlur = () => clearReferencePointerState(node, ctx)

  document.addEventListener('mouseup', documentMouseUp)
  document.addEventListener('pointerdown', documentPointerDown, true)
  document.addEventListener('pointercancel', documentPointerCancel, true)
  window.addEventListener('blur', windowBlur)

  const previousRemoved = node.onRemoved
  node.onRemoved = function (...args) {
    document.removeEventListener('mouseup', documentMouseUp)
    document.removeEventListener('pointerdown', documentPointerDown, true)
    document.removeEventListener('pointercancel', documentPointerCancel, true)
    window.removeEventListener('blur', windowBlur)
    if (ext.batchWindowDrop) window.removeEventListener('drop', ext.batchWindowDrop, true)
    clearReferencePointerState(node, ctx)
    return previousRemoved?.apply(this, args)
  }
}

installDragEffectContract()
installPresetMenuStyles()

app.registerExtension({
  name: EXTENSION_NAME,
  nodeCreated(node) {
    const type = String(node?.comfyClass || node?.type || '')
    if (!NODE_CLASSES.has(type)) return
    queueMicrotask(() => installNode(node))
  }
})
