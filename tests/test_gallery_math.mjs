import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateGalleryMetrics,
  calculateMarqueeGridIndexes,
  calculateVisibleCardRange,
  chooseViewAfterClose,
  groupDirectoryPickerFiles,
  isDragLeavingDocument,
  isHighVelocityScroll,
  isConveyorDeleteShortcut,
  isConveyorGalleryShortcut,
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
