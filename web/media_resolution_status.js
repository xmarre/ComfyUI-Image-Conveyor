import { app } from '../../scripts/app.js'

const TARGET_CLASS = 'ImageConveyorMediaResolution'
const ROW_HEIGHT = 17
const LEFT_PADDING = 10
const BOTTOM_PADDING = 8

function isMediaResolutionNode(node) {
  return node?.comfyClass === TARGET_CLASS || node?.type === TARGET_CLASS
}

function setStatus(node, text) {
  const lines = Array.isArray(text) ? text.filter((value) => typeof value === 'string' && value.length > 0) : []
  node.__imageConveyorMpStatus = lines
  if (!lines.length) return

  // computeSize includes the existing built-in widgets/ports; no canvas-time
  // resizing, custom serializable widgets, or workflow widget-order changes.
  const computed = node.computeSize?.()
  const widgetBottom = Math.max(0, ...(node.widgets || []).map((w) =>
    (Number(w.last_y) || 0) + (Number(w.height) || 20)
  ))
  const top = Math.max(Number(computed?.[1]) || 0, widgetBottom) + 4
  node.__imageConveyorMpStatusTop = top
  const requiredHeight = top + lines.length * ROW_HEIGHT + BOTTOM_PADDING
  const currentHeight = Number(node.size?.[1]) || 0
  if (requiredHeight > currentHeight) {
    if (typeof node.setSize === 'function') node.setSize([Number(node.size?.[0]) || 340, requiredHeight])
    else node.size = [Number(node.size?.[0]) || 340, requiredHeight]
  }
  node.setDirtyCanvas?.(true, true)
}

app.registerExtension({
  name: 'Comfy.ImageConveyor.MediaResolutionStatus',
  nodeCreated(node) {
    if (!isMediaResolutionNode(node) || node.__imageConveyorMpStatusInstalled) return
    node.__imageConveyorMpStatusInstalled = true

    const previousExecuted = node.onExecuted
    node.onExecuted = function(message) {
      previousExecuted?.apply(this, arguments)
      setStatus(this, message?.text)
    }

    const previousDraw = node.onDrawForeground
    node.onDrawForeground = function(ctx) {
      previousDraw?.apply(this, arguments)
      if (this.flags?.collapsed || !this.__imageConveyorMpStatus?.length) return
      ctx.save()
      ctx.font = '12px Arial, sans-serif'
      ctx.fillStyle = '#d0d7de'
      ctx.textBaseline = 'top'
      const x = LEFT_PADDING
      const maxWidth = Math.max(0, (Number(this.size?.[0]) || 340) - LEFT_PADDING * 2)
      for (let i = 0; i < this.__imageConveyorMpStatus.length; i += 1) {
        ctx.fillText(this.__imageConveyorMpStatus[i], x,
          this.__imageConveyorMpStatusTop + i * ROW_HEIGHT, maxWidth)
      }
      ctx.restore()
    }
  }
})
