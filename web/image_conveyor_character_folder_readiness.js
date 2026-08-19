import { app } from '../../scripts/app.js'
import { characterFolderReadinessAction } from './image_conveyor_character_folder_readiness_math.mjs'

const EXTENSION_NAME = 'Comfy.ImageConveyor.CharacterFolderReadiness'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const MAX_WAIT_MS = 30000
const controllers = new WeakMap()

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

function pointInRect(point, rect) {
  return Boolean(
    point && rect
    && point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height
  )
}

function isCharacterFolderClick(node, event) {
  const ctx = node.__bil
  if (!ctx?.icx || event?.button !== 0 || !ctx.state?.active_reference_preset_id) return false
  return pointInRect(nodePoint(node, event), folderButtonRect(ctx))
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
  // If a character tab somehow already exists, force the library layer to rebuild it
  // from the newly initialized shared input index on the next draw.
  ext.characterRevision = -1
  ctx.renderedRangeKey = ''
  return true
}

function ensureCharacterFolderInputReady(node, controller) {
  if (controller.readinessPromise) return controller.readinessPromise
  const ctx = node.__bil
  let refreshStarted = Boolean(ctx?.browser?.input?.loading)
  const startedAt = performance.now()

  controller.readinessPromise = new Promise((resolve, reject) => {
    const check = () => {
      if (node.__bil !== ctx || !ctx?.icx || ctx.removed) {
        reject(new Error('Image Conveyor node was removed while loading the character folder.'))
        return
      }
      if (performance.now() - startedAt > MAX_WAIT_MS) {
        reject(new Error('Timed out while loading the Input Folder index needed by the character folder.'))
        return
      }

      const action = characterFolderReadinessAction({
        loaded: Boolean(ctx.browser.input.loaded),
        loading: Boolean(ctx.browser.input.loading),
        refreshStarted
      })

      if (action === 'ready') {
        syncSharedInputIndex(ctx)
        resolve()
        return
      }
      if (action === 'error') {
        reject(new Error('Unable to load the Input Folder index needed by the character folder.'))
        return
      }
      if (action === 'refresh') {
        if (!ctx.refreshBtn?.click) {
          reject(new Error('Unable to initialize the Input Folder index needed by the character folder.'))
          return
        }
        refreshStarted = true
        ctx.refreshBtn.click()
      }
      setTimeout(check, 16)
    }
    check()
  }).finally(() => {
    controller.readinessPromise = null
  })

  return controller.readinessPromise
}

function installNode(node, attempts = 0) {
  if (!node || attempts > 120 || controllers.has(node)) return
  const ctx = node.__bil
  // Wait for the main widget and the library-operations layer. This guard must wrap
  // the Folder handler after library_ops installs it.
  if (!ctx?.icx || typeof node.onMouseDown !== 'function') {
    requestAnimationFrame(() => installNode(node, attempts + 1))
    return
  }

  const controller = { readinessPromise: null }
  controllers.set(node, controller)
  const previousMouseDown = node.onMouseDown

  node.onMouseDown = function (event, localPosition, graphCanvas) {
    if (!isCharacterFolderClick(node, event)) {
      return previousMouseDown?.call(this, event, localPosition, graphCanvas)
    }

    event.preventDefault?.()
    event.stopPropagation?.()
    if (controller.readinessPromise) return true

    void ensureCharacterFolderInputReady(node, controller)
      .then(() => {
        if (node.__bil !== ctx || ctx.removed) return
        previousMouseDown?.call(node, event, localPosition, graphCanvas)
      })
      .catch((error) => {
        console.error('Image Conveyor: unable to initialize character folder contents.', error)
        window.alert(error?.message || 'Unable to load the character folder.')
      })
    return true
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
