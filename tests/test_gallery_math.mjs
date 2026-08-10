import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateGalleryMetrics,
  calculateGalleryDropIntent,
  calculateMarqueeGridIndexes,
  calculateReorderDestinationIndex,
  calculateVisibleCardRange,
  clientPointToScrollContent,
  chooseViewAfterClose,
  dispatchKeyboundCommandFallback,
  findKeyboundCommand,
  groupDirectoryPickerFiles,
  isDragLeavingDocument,
  isGalleryViewportMeasurable,
  isHighVelocityScroll,
  isConveyorDeleteShortcut,
  isConveyorGalleryShortcut,
  isReservedTextInputShortcut,
  keyboardComboSignature,
  planCardSlotReuse,
  planViewScrollSwitch,
  prepareManagedDuplicateCleanup,
  restoreGraphCanvasFocus
} from '../web/image_conveyor_math.mjs'

test('responsive metrics add columns as width grows', () => {
  const medium = calculateGalleryMetrics(520, 172, 10)
  const wide = calculateGalleryMetrics(1040, 172, 10)
  assert.equal(medium.columns, 2)
  assert.ok(wide.columns > medium.columns)
  assert.ok(medium.mediaHeight / medium.cardHeight >= 0.68)
  assert.equal(medium.columnStride, medium.cardWidth + 10)
})

test('hidden gallery viewports are excluded from virtual layout', () => {
  assert.equal(isGalleryViewportMeasurable(720, 700), true)
  assert.equal(isGalleryViewportMeasurable(0, 700), false)
  assert.equal(isGalleryViewportMeasurable(720, 0), false)
  assert.equal(isGalleryViewportMeasurable(Number.NaN, 700), false)
})

test('marquee hit testing follows virtual card geometry and ignores gaps', () => {
  const metrics = calculateGalleryMetrics(400, 100, 10)
  assert.equal(metrics.columns, 3)

  const firstCardRight = metrics.cardWidth
  assert.deepEqual(
    calculateMarqueeGridIndexes(20, metrics, {
      left: firstCardRight + 1,
      right: metrics.columnStride - 1,
      top: 10,
      bottom: 30
    }),
    []
  )
  assert.deepEqual(
    calculateMarqueeGridIndexes(20, metrics, {
      left: firstCardRight - 2,
      right: metrics.columnStride + 2,
      top: 10,
      bottom: 30
    }),
    [0, 1]
  )
  assert.deepEqual(
    calculateMarqueeGridIndexes(5, metrics, {
      left: 0,
      right: metrics.columnStride * 3,
      top: metrics.cardHeight - 2,
      bottom: metrics.rowStride + 2
    }),
    [0, 1, 2, 3, 4]
  )
})

test('client points map into unscaled scroll content under canvas transforms', () => {
  assert.deepEqual(
    clientPointToScrollContent(
      150,
      100,
      { left: 100, top: 50, width: 200, height: 150 },
      400,
      300,
      12,
      40
    ),
    { x: 112, y: 140 }
  )
  assert.deepEqual(
    clientPointToScrollContent(
      90,
      500,
      { left: 100, top: 50, width: 800, height: 600 },
      400,
      300
    ),
    { x: 0, y: 225 }
  )
  assert.deepEqual(
    clientPointToScrollContent(
      300,
      200,
      { left: 100, top: 50, width: 416, height: 320 },
      400,
      300,
      0,
      0,
      416,
      320
    ),
    { x: 200, y: 150 }
  )
})

test('insertion boundaries account for removing the dragged item first', () => {
  assert.equal(calculateReorderDestinationIndex(5, 0, 3), 2)
  assert.equal(calculateReorderDestinationIndex(5, 4, 1), 1)
  assert.equal(calculateReorderDestinationIndex(5, 2, 2), -1)
  assert.equal(calculateReorderDestinationIndex(5, 2, 3), -1)
  assert.equal(calculateReorderDestinationIndex(5, 2, 5), 4)
})

test('gallery reorder hit testing covers card centers, sides, and grid gaps', () => {
  const metrics = calculateGalleryMetrics(400, 100, 10)
  const firstCenter = calculateGalleryDropIntent(5, metrics, metrics.cardWidth / 2, 20)
  assert.deepEqual(firstCenter, { type: 'card', targetIndex: 0 })

  const firstLeft = calculateGalleryDropIntent(5, metrics, 1, 20)
  assert.equal(firstLeft.type, 'insertion')
  assert.equal(firstLeft.insertionIndex, 0)
  assert.equal(firstLeft.orientation, 'vertical')

  const exactFirstBorder = calculateGalleryDropIntent(5, metrics, metrics.cardWidth, 20)
  assert.equal(exactFirstBorder.type, 'insertion')
  assert.equal(exactFirstBorder.insertionIndex, 1)
  assert.equal(exactFirstBorder.left, metrics.cardWidth)

  const firstGap = calculateGalleryDropIntent(5, metrics, metrics.cardWidth + 4, 20)
  assert.equal(firstGap.type, 'insertion')
  assert.equal(firstGap.insertionIndex, 1)

  const rowGap = calculateGalleryDropIntent(5, metrics, 40, metrics.cardHeight + 5)
  assert.equal(rowGap.type, 'insertion')
  assert.equal(rowGap.insertionIndex, 3)
  assert.equal(rowGap.orientation, 'horizontal')

  const afterLast = calculateGalleryDropIntent(5, metrics, metrics.width, metrics.rowStride + 20)
  assert.equal(afterLast.type, 'insertion')
  assert.equal(afterLast.insertionIndex, 5)
})

test('the German Entf key maps to unmodified Delete for conveyor removal', () => {
  assert.equal(isConveyorDeleteShortcut({ key: 'Delete' }), true)
  assert.equal(isConveyorDeleteShortcut({ key: '', code: 'Delete' }), true)
  assert.equal(isConveyorDeleteShortcut({ key: 'Backspace' }), false)
  assert.equal(isConveyorDeleteShortcut({ key: 'Delete', ctrlKey: true }), false)
  assert.equal(isConveyorDeleteShortcut({ key: 'Delete', shiftKey: true }), false)
  assert.equal(isConveyorDeleteShortcut({ key: 'Delete', defaultPrevented: true }), false)
})

test('ten thousand items keep a bounded live-card range', () => {
  const metrics = calculateGalleryMetrics(720, 172, 10)
  const range = calculateVisibleCardRange(
    10_000,
    metrics.columns,
    metrics.rowStride,
    10,
    250_000,
    700,
    2
  )
  assert.ok(range.end - range.start <= 40)
  assert.ok(range.start > 0)
  assert.ok(range.end < 10_000)
})

test('range clamps scroll after filtering to a smaller collection', () => {
  const metrics = calculateGalleryMetrics(520, 172, 10)
  const range = calculateVisibleCardRange(3, metrics.columns, metrics.rowStride, 10, 999_999, 700, 2)
  assert.equal(range.scrollTop, 0)
  assert.deepEqual([range.start, range.end], [0, 3])
})

test('recycled card slots stay attached to overlapping item identities', () => {
  const assignments = planCardSlotReuse(
    ['a', 'b', 'c', 'd', null],
    ['c', 'd', 'e', 'f', 'g']
  )
  assert.deepEqual(assignments, [2, 3, 0, 1, 4])
  assert.equal(new Set(assignments).size, assignments.length)

  const previous = Array.from({ length: 40 }, (_, index) => `item-${index}`)
  const next = Array.from({ length: 40 }, (_, index) => `item-${index + 4}`)
  const shiftedAssignments = planCardSlotReuse(previous, next)
  const retained = shiftedAssignments.filter((slotIndex, index) => previous[slotIndex] === next[index])
  assert.equal(retained.length, 36)
})

test('only high-velocity scrolling defers intermediate thumbnail requests', () => {
  assert.equal(isHighVelocityScroll(80, 16, 220), false)
  assert.equal(isHighVelocityScroll(20, 0, 220), false)
  assert.equal(isHighVelocityScroll(240, 16, 220), true)
  assert.equal(isHighVelocityScroll(350, 100, 220), true)
})

test('widget interactions restore native canvas shortcut focus', () => {
  const calls = []
  const fileInput = { blur: () => calls.push(['blur']) }
  const ownerDocument = { activeElement: fileInput }
  const canvas = {
    ownerDocument,
    tabIndex: -1,
    focus(options) {
      calls.push(['focus', options])
      ownerDocument.activeElement = this
    }
  }

  assert.equal(restoreGraphCanvasFocus(fileInput, canvas), true)
  assert.deepEqual(calls, [['blur'], ['focus', { preventScroll: true }]])
  assert.equal(ownerDocument.activeElement, canvas)
  assert.equal(canvas.tabIndex, -1)

  assert.equal(restoreGraphCanvasFocus(fileInput, null), false)
  assert.deepEqual(calls.at(-1), ['focus', { preventScroll: true }])

  assert.equal(restoreGraphCanvasFocus(null, canvas), true)
  assert.deepEqual(calls.at(-1), ['focus', { preventScroll: true }])
})

test('live ComfyUI bindings provide a single fallback when the native listener is absent', () => {
  const canvas = { tagName: 'CANVAS', closest: () => null }
  const save = {
    id: 'Comfy.SaveWorkflow',
    keybinding: {
      combo: {
        key: 's', ctrl: true, alt: false, shift: false,
        isReservedByTextInput: false
      },
      targetElementId: null
    }
  }
  const calls = []
  const manager = {
    commands: [save],
    execute(id, options) { calls.push({ id, options }) }
  }
  const event = {
    key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true,
    target: canvas, defaultPrevented: false,
    composedPath: () => [canvas],
    preventDefault() { this.defaultPrevented = true },
    stopImmediatePropagation() { this.immediatePropagationStopped = true }
  }

  assert.equal(keyboardComboSignature(event), 'S:true:false:false')
  assert.equal(keyboardComboSignature({ key: 's', metaKey: true }), 'S:true:false:false')
  assert.equal(findKeyboundCommand(manager.commands, event, canvas), save)
  assert.equal(dispatchKeyboundCommandFallback(event, manager), true)
  assert.equal(event.defaultPrevented, true)
  assert.equal(event.immediatePropagationStopped, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'Comfy.SaveWorkflow')
  assert.equal(typeof calls[0].options.errorHandler, 'function')
  assert.equal(calls[0].options.metadata, undefined)

  assert.equal(dispatchKeyboundCommandFallback(event, manager), false)
  assert.equal(calls.length, 1)
})

test('fallback honors live reassignment, canvas scope, text editing, and modal state', () => {
  const canvas = { tagName: 'CANVAS' }
  const input = { tagName: 'INPUT' }
  const outside = { tagName: 'BUTTON' }
  const container = { contains: (target) => target === canvas || target === input }
  const documentRef = { getElementById: (id) => id === 'graph-canvas-container' ? container : null }
  const command = {
    id: 'Comfy.Canvas.SelectAll',
    keybinding: {
      combo: {
        key: 'x', ctrl: true, alt: false, shift: true,
        isReservedByTextInput: true
      },
      targetElementId: 'graph-canvas'
    }
  }
  const matching = { key: 'x', ctrlKey: true, shiftKey: true }

  assert.equal(findKeyboundCommand([command], matching, canvas, documentRef), command)
  assert.equal(findKeyboundCommand([command], matching, outside, documentRef), null)
  assert.equal(findKeyboundCommand([command], matching, input, documentRef), null)

  const manager = { commands: [command], execute: () => assert.fail('modal command executed') }
  assert.equal(dispatchKeyboundCommandFallback(
    { ...matching, preventDefault: () => assert.fail('modal event cancelled') },
    manager,
    { target: canvas, documentRef, modalOpen: true }
  ), false)
})

test('window listener ordering executes each live command once', () => {
  const canvas = { tagName: 'CANVAS', closest: () => null }
  const command = {
    id: 'Comfy.SaveWorkflow',
    keybinding: {
      combo: {
        key: 's', ctrl: true, alt: false, shift: false,
        isReservedByTextInput: false
      }
    }
  }
  const manager = { commands: [command], execute: () => { fallbackCalls += 1 } }
  const windowTarget = new EventTarget()
  let nativeActive = false
  let nativeCalls = 0
  let fallbackCalls = 0
  let downstreamCalls = 0

  windowTarget.addEventListener('keydown', (event) => {
    if (!nativeActive) return
    nativeCalls += 1
    event.preventDefault()
  })
  windowTarget.addEventListener('keydown', (event) => {
    dispatchKeyboundCommandFallback(event, manager, { target: canvas })
  })
  windowTarget.addEventListener('keydown', () => { downstreamCalls += 1 })

  const makeEvent = () => {
    const event = new Event('keydown', { cancelable: true })
    Object.defineProperties(event, {
      key: { value: 's' },
      ctrlKey: { value: true },
      metaKey: { value: false },
      altKey: { value: false },
      shiftKey: { value: false }
    })
    return event
  }

  assert.equal(windowTarget.dispatchEvent(makeEvent()), false)
  assert.deepEqual(
    { nativeCalls, fallbackCalls, downstreamCalls },
    { nativeCalls: 0, fallbackCalls: 1, downstreamCalls: 0 }
  )

  nativeActive = true
  assert.equal(windowTarget.dispatchEvent(makeEvent()), false)
  assert.deepEqual(
    { nativeCalls, fallbackCalls, downstreamCalls },
    { nativeCalls: 1, fallbackCalls: 1, downstreamCalls: 1 }
  )
})

test('text controls reserve editing chords while allowing ComfyUI commands', () => {
  assert.equal(isReservedTextInputShortcut({ key: 'a', ctrlKey: true }), true)
  assert.equal(isReservedTextInputShortcut({ key: 'z', metaKey: true }), true)
  assert.equal(isReservedTextInputShortcut({ key: 'ArrowLeft', shiftKey: true }), true)
  assert.equal(isReservedTextInputShortcut({ key: 'Enter' }), true)
  assert.equal(isReservedTextInputShortcut({ key: 'q' }), true)
  assert.equal(isReservedTextInputShortcut({ key: 'S', ctrlKey: true }), false)
  assert.equal(isReservedTextInputShortcut({ key: 's', ctrlKey: true }), false)
  assert.equal(isReservedTextInputShortcut({ key: 'b', ctrlKey: true }), false)
  assert.equal(isReservedTextInputShortcut({ key: 'Enter', ctrlKey: true }), false)
})

test('conveyor keyboard ownership excludes every modified ComfyUI hotkey', () => {
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    assert.equal(isConveyorGalleryShortcut({ key: 's', [modifier]: true }), false)
    assert.equal(isConveyorGalleryShortcut({ key: 'ArrowRight', [modifier]: true }), false)
  }
  assert.equal(isConveyorGalleryShortcut({ key: 'ArrowRight' }), true)
  assert.equal(isConveyorGalleryShortcut({ key: 'Enter' }), true)
  assert.equal(isConveyorGalleryShortcut({ key: 'Delete' }), true)
  assert.equal(isConveyorGalleryShortcut({ key: 's' }), false)
  assert.equal(isConveyorGalleryShortcut({ key: 'ArrowRight', isComposing: true }), false)
  assert.equal(isConveyorGalleryShortcut({ key: 'ArrowRight', defaultPrevented: true }), false)
})

test('tab switches preserve independent scroll positions', () => {
  const toInput = planViewScrollSwitch(
    'conveyor',
    'input',
    42_500,
    { conveyor: 0, input: 317_250 }
  )
  assert.deepEqual(toInput.positions, { conveyor: 42_500, input: 317_250 })
  assert.deepEqual(toInput.restore, { view: 'input', scrollTop: 317_250 })

  const backToConveyor = planViewScrollSwitch(
    'input',
    'conveyor',
    317_250,
    toInput.positions
  )
  assert.deepEqual(backToConveyor.positions, { conveyor: 42_500, input: 317_250 })
  assert.deepEqual(backToConveyor.restore, { view: 'conveyor', scrollTop: 42_500 })
})

test('rapid tab switches do not replace an unrendered destination position', () => {
  const switchedBack = planViewScrollSwitch(
    'input',
    'conveyor',
    42_500,
    { conveyor: 42_500, input: 317_250 },
    'input'
  )
  assert.equal(switchedBack.positions.input, 317_250)
  assert.deepEqual(switchedBack.restore, { view: 'conveyor', scrollTop: 42_500 })
})

test('dynamic folder tabs retain independent scroll positions', () => {
  const folderView = 'folder:source:nested'
  const switched = planViewScrollSwitch(
    'input',
    folderView,
    12_000,
    { conveyor: 900, input: 1_000, [folderView]: 88_000 }
  )
  assert.equal(switched.positions.input, 12_000)
  assert.equal(switched.positions[folderView], 88_000)
  assert.deepEqual(switched.restore, { view: folderView, scrollTop: 88_000 })
})

test('closing a folder tab chooses the adjacent tab only when it was active', () => {
  const order = ['conveyor', 'input', 'folder-a', 'folder-b']
  assert.equal(chooseViewAfterClose(order, 'folder-a', 'folder-a'), 'folder-b')
  assert.equal(chooseViewAfterClose(order, 'folder-b', 'folder-b'), 'folder-a')
  assert.equal(chooseViewAfterClose(order, 'input', 'folder-a'), 'input')
  assert.equal(chooseViewAfterClose(['conveyor', 'folder-a'], 'folder-a', 'folder-a'), 'conveyor')
})

test('directory picker files become independent nested folder sources', () => {
  const files = [
    { name: 'one.png', webkitRelativePath: 'First/one.png' },
    { name: 'two.jpg', webkitRelativePath: 'First/Nested/two.jpg' },
    { name: 'notes.txt', webkitRelativePath: 'First/Nested/Deep/notes.txt' },
    { name: 'three.webp', webkitRelativePath: 'Second/three.webp' },
    { name: 'loose.png', webkitRelativePath: '' }
  ]
  const groups = groupDirectoryPickerFiles(files, (file) => /\.(png|jpg|webp)$/.test(file.name))
  assert.deepEqual(groups.map((group) => group.name), ['First', 'Second'])
  assert.deepEqual(groups[0].files.map((entry) => entry.relativePath), ['one.png', 'Nested/two.jpg'])
  assert.deepEqual(groups[0].directories, ['', 'Nested', 'Nested/Deep'])
  assert.deepEqual(groups[1].files.map((entry) => entry.relativePath), ['three.webp'])
})

test('external drag exit distinguishes viewport exits from child transitions', () => {
  const documentNode = {}
  const insideNode = {}
  const outsideNode = {}
  const documentElement = {
    ownerDocument: documentNode,
    contains: (target) => target === insideNode
  }

  assert.equal(
    isDragLeavingDocument({ target: insideNode, relatedTarget: insideNode }, documentElement),
    false
  )
  assert.equal(
    isDragLeavingDocument({ target: insideNode, relatedTarget: null }, documentElement),
    true
  )
  assert.equal(
    isDragLeavingDocument({ target: insideNode, relatedTarget: outsideNode }, documentElement),
    true
  )
  assert.equal(
    isDragLeavingDocument({ target: documentNode, relatedTarget: insideNode }, documentElement),
    true
  )
})

test('duplicate cleanup excludes queued paths and recomputes the confirmed scope', () => {
  const result = prepareManagedDuplicateCleanup(
    [
      {
        digest: 'a'.repeat(64),
        keep_path: 'original.png',
        duplicates: [
          { relative_path: 'image_conveyor/queued.png', size: 100 },
          { relative_path: 'image_conveyor/delete.png', size: 250 }
        ]
      },
      {
        digest: 'b'.repeat(64),
        keep_path: 'other.png',
        duplicates: [{ relative_path: 'image_conveyor/also-queued.png', size: 500 }]
      }
    ],
    new Set(['image_conveyor/queued.png', 'image_conveyor/also-queued.png'])
  )

  assert.equal(result.protectedCount, 2)
  assert.equal(result.duplicateCount, 1)
  assert.equal(result.reclaimableBytes, 250)
  assert.equal(result.groups.length, 1)
  assert.match(result.groups[0].digest, /^[0-9a-f]{64}$/)
  assert.equal(result.groups[0].keep_path, 'original.png')
  assert.equal(result.groups[0].duplicates[0].relative_path, 'image_conveyor/delete.png')
})
