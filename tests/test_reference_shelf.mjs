import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OUTPUT_MODE_PERSISTENT,
  OUTPUT_MODE_QUEUE_GROUP,
  applyReferenceAssignments,
  calculateReferenceShelfLayout,
  classifyReferenceDrag,
  effectiveQueueGroupSize,
  loadPresetSnapshot,
  moveReferenceSlot,
  normalizeOutputMode,
  normalizeReferenceSlots,
  referenceShelfHit,
  referenceSlotsEqual,
  relinkReferenceSlots
} from '../web/image_conveyor_math.mjs'

const reference = (name) => ({
  annotated: `refs/${name}.png [input]`,
  filename: `${name}.png`,
  subfolder: 'refs',
  type: 'input'
})

test('legacy output-mode migration preserves grouped workflows deterministically', () => {
  assert.equal(normalizeOutputMode(undefined, 1, false), OUTPUT_MODE_PERSISTENT)
  assert.equal(normalizeOutputMode(undefined, 2, false), OUTPUT_MODE_QUEUE_GROUP)
  assert.equal(normalizeOutputMode('bad', 9, true), OUTPUT_MODE_PERSISTENT)
  assert.equal(normalizeOutputMode(OUTPUT_MODE_QUEUE_GROUP, 1, true), OUTPUT_MODE_QUEUE_GROUP)
})

test('persistent mode always has an effective queue group size of one', () => {
  assert.equal(effectiveQueueGroupSize(OUTPUT_MODE_PERSISTENT, 9), 1)
  assert.equal(effectiveQueueGroupSize(OUTPUT_MODE_QUEUE_GROUP, 9), 9)
})

test('reference slots normalize to exactly eight sparse input records', () => {
  const slots = normalizeReferenceSlots([reference('a'), 'bad', null, { annotated: 'x.png [output]' }])
  assert.equal(slots.length, 8)
  assert.deepEqual(slots[0], reference('a'))
  assert.deepEqual(slots.slice(1), Array(7).fill(null))
})

test('reference slot normalization rejects path escapes and unsupported storage', () => {
  const slots = normalizeReferenceSlots([
    { annotated: '/tmp/a.png [input]' },
    { annotated: '../a.png [input]' },
    { annotated: 'C:\\tmp\\a.png [input]' },
    { annotated: 'a.svg [input]' },
    { annotated: 'a.png [output]' }
  ])
  assert.deepEqual(slots, Array(8).fill(null))
})

test('reference slot normalization rejects dotless extension lookalikes', () => {
  assert.deepEqual(
    normalizeReferenceSlots([{ annotated: 'refs/png [input]' }]),
    Array(8).fill(null)
  )
})

test('reference-only assignment does not append, remove, or reorder Conveyor items', () => {
  const items = [{ id: 'A' }, { id: 'B' }]
  const state = { items, reference_slots: Array(8).fill(null) }
  const next = applyReferenceAssignments(state, 2, [reference('a'), reference('b')])
  assert.equal(next.items, items)
  assert.deepEqual(next.items.map((item) => item.id), ['A', 'B'])
  assert.deepEqual(next.reference_slots[2], reference('a'))
  assert.deepEqual(next.reference_slots[3], reference('b'))
})

test('sparse assignment clamps to the fixed slot range', () => {
  const next = applyReferenceAssignments(
    { items: [], reference_slots: [reference('existing')] },
    7,
    [reference('last'), reference('overflow')]
  )
  assert.equal(next.reference_slots.length, 8)
  assert.deepEqual(next.reference_slots[0], reference('existing'))
  assert.deepEqual(next.reference_slots[7], reference('last'))
})

test('reference shelf drag-sort moves one populated slot and preserves sparse order', () => {
  const slots = [reference('a'), reference('b'), null, reference('d')]
  assert.deepEqual(
    moveReferenceSlot(slots, 0, 2).slice(0, 4),
    [reference('b'), null, reference('a'), reference('d')]
  )
  assert.deepEqual(
    moveReferenceSlot(slots, 3, 0).slice(0, 4),
    [reference('d'), reference('a'), reference('b'), null]
  )
  assert.deepEqual(moveReferenceSlot(slots, 2, 0), normalizeReferenceSlots(slots))
})

test('preset snapshots are detached normalized copies and dirty comparison is exact', () => {
  const preset = { id: 'preset-id', slots: [reference('a')] }
  const loaded = loadPresetSnapshot(preset)
  assert.equal(loaded.activePresetId, 'preset-id')
  assert.equal(referenceSlotsEqual(loaded.slots, preset.slots), true)
  loaded.slots[0].annotated = 'refs/changed.png [input]'
  assert.equal(referenceSlotsEqual(loaded.slots, preset.slots), false)
  assert.equal(preset.slots[0].annotated, 'refs/a.png [input]')
})

test('duplicate cleanup relinks sparse live reference slots without touching others', () => {
  const result = relinkReferenceSlots(
    [reference('legacy'), null, reference('keep')],
    [{ relative_path: 'refs/legacy.png', keep_path: 'canonical/legacy.png' }]
  )
  assert.equal(result.changed, 1)
  assert.deepEqual(result.slots[0], {
    annotated: 'canonical/legacy.png [input]',
    filename: 'legacy.png',
    subfolder: 'canonical',
    type: 'input'
  })
  assert.equal(result.slots[1], null)
  assert.deepEqual(result.slots[2], reference('keep'))
})

test('drag classification separates reorder-capable Conveyor images from imports', () => {
  assert.deepEqual(
    classifyReferenceDrag({ id: 'A' }, 'conveyor', true),
    { kind: 'conveyor', requiresImport: false, canReorder: true }
  )
  assert.deepEqual(
    classifyReferenceDrag({ id: 'A' }, 'conveyor', false),
    { kind: 'conveyor', requiresImport: false, canReorder: false }
  )
  assert.deepEqual(
    classifyReferenceDrag({ relative_path: 'a.png' }, 'input', true),
    { kind: 'input', requiresImport: false, canReorder: false }
  )
  assert.deepEqual(
    classifyReferenceDrag({ localFile: {} }, 'folder:id:', true),
    { kind: 'local', requiresImport: true, canReorder: false }
  )
  assert.equal(classifyReferenceDrag({ kind: 'folder' }, 'input'), null)
})

test('4x2 shelf layout and hit testing stay within measured pre-widget geometry', () => {
  const layout = calculateReferenceShelfLayout(520, 290, 112, 30)
  assert.equal(layout.usable, true)
  assert.equal(layout.slots.length, 8)
  assert.equal(layout.slots[0].y, layout.slots[3].y)
  assert.ok(layout.slots[4].y > layout.slots[0].y)
  assert.ok(layout.slots.every((slot) => slot.x >= layout.left && slot.x + slot.width <= layout.right))
  const first = layout.slots[0]
  assert.deepEqual(referenceShelfHit(layout, first.x + 4, first.y + 4), { type: 'slot', index: 0 })
  assert.deepEqual(
    referenceShelfHit(layout, first.x + first.width - 2, first.y + 2),
    { type: 'clear', index: 0 }
  )
  assert.equal(referenceShelfHit(layout, layout.right + 1, layout.bottom + 1), null)
})

test('shelf header hit regions map to save, menu, and preset actions', () => {
  const layout = calculateReferenceShelfLayout(520, 290, 112, 30)
  const menuWidth = Math.min(54, layout.width * 0.18)
  const saveWidth = Math.min(52, layout.width * 0.18)
  const headerY = layout.top + layout.headerHeight / 2
  assert.deepEqual(referenceShelfHit(layout, layout.right - 1, headerY), { type: 'menu' })
  assert.deepEqual(
    referenceShelfHit(layout, layout.right - menuWidth - 1, headerY),
    { type: 'save' }
  )
  assert.deepEqual(
    referenceShelfHit(layout, layout.right - menuWidth - saveWidth - 1, headerY),
    { type: 'preset' }
  )
})

test('a narrow node produces an unusable shelf layout with no hits', () => {
  const layout = calculateReferenceShelfLayout(200, 120, 112, 30)
  assert.equal(layout.usable, false)
  assert.equal(referenceShelfHit(layout, layout.left + 1, layout.top + 1), null)
})
