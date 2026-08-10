import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calculateAutoQueueExtraExecutions,
  completeExecutionGroupCount,
  makeQueueReservationPayload,
  markReservedGroupQueued,
  normalizeImagesPerExecution,
  processedItemIdsFromDelta,
  queueReservationMembers,
  selectExecutionGroup,
  shouldReanchorGalleryResize
} from '../web/image_conveyor_math.mjs'

function queueItems(ids, status = 'pending') {
  return ids.map((id) => ({
    id,
    annotated: `${id}.png [input]`,
    status,
    last_queued_at: 0,
    last_processed_at: 0
  }))
}

function reserveAndQueue(items, count, dontConsume = false, now = 100) {
  const group = selectExecutionGroup(items, count, dontConsume)
  const payload = group.length === normalizeImagesPerExecution(count)
    ? makeQueueReservationPayload(group)
    : null
  if (payload) markReservedGroupQueued(items, payload, dontConsume, now)
  return { group, payload }
}

function applyProcessedIds(items, delta, now = 200) {
  const ids = new Set(processedItemIdsFromDelta(delta))
  let changed = 0
  for (const item of items) {
    if (!ids.has(item.id)) continue
    if (delta.new_status === 'processed') item.status = 'processed'
    item.last_processed_at = now
    changed += 1
  }
  return changed
}

test('normalizes images-per-execution to the persisted 1-9 range', () => {
  assert.equal(normalizeImagesPerExecution(0), 1)
  assert.equal(normalizeImagesPerExecution(-4), 1)
  assert.equal(normalizeImagesPerExecution('bad'), 1)
  assert.equal(normalizeImagesPerExecution(10), 9)
  for (let count = 1; count <= 9; count += 1) {
    assert.equal(normalizeImagesPerExecution(count), count)
  }
})

test('reserves the first complete pending group in Conveyor order', () => {
  const items = queueItems(['A', 'B', 'C', 'D', 'E', 'F'])
  assert.deepEqual(
    selectExecutionGroup(items, 3).map((item) => item.id),
    ['A', 'B', 'C']
  )
})

test('afterQueued marks the whole reserved group queued with one timestamp', () => {
  const items = queueItems(['A', 'B', 'C', 'D'])
  const { payload } = reserveAndQueue(items, 3, false, 12345)
  assert.deepEqual(queueReservationMembers(payload).map((item) => item.id), ['A', 'B', 'C'])
  assert.deepEqual(items.map((item) => item.status), ['queued', 'queued', 'queued', 'pending'])
  assert.deepEqual(items.slice(0, 3).map((item) => item.last_queued_at), [12345, 12345, 12345])
})

test('next consuming reservation skips every already queued group member', () => {
  const items = queueItems(['A', 'B', 'C', 'D', 'E', 'F'])
  reserveAndQueue(items, 3, false, 1)
  const second = selectExecutionGroup(items, 3, false)
  assert.deepEqual(second.map((item) => item.id), ['D', 'E', 'F'])
})

test('three prompt reservations over nine items have zero overlap', () => {
  const items = queueItems(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'])
  const reservations = []
  for (let prompt = 0; prompt < 3; prompt += 1) {
    const { group } = reserveAndQueue(items, 3, false, prompt + 1)
    reservations.push(group.map((item) => item.id))
  }
  assert.deepEqual(reservations, [
    ['A', 'B', 'C'],
    ['D', 'E', 'F'],
    ['G', 'H', 'I']
  ])
  assert.equal(new Set(reservations.flat()).size, 9)
})

test("Don't consume leaves statuses unchanged and repeats the same group", () => {
  const items = queueItems(['A', 'B', 'C', 'D'])
  const first = reserveAndQueue(items, 3, true, 1)
  const second = reserveAndQueue(items, 3, true, 2)
  assert.deepEqual(first.group.map((item) => item.id), ['A', 'B', 'C'])
  assert.deepEqual(second.group.map((item) => item.id), ['A', 'B', 'C'])
  assert.deepEqual(items.map((item) => item.status), ['pending', 'pending', 'pending', 'pending'])
  assert.deepEqual(items.map((item) => item.last_queued_at), [0, 0, 0, 0])
})

test("Don't consume uses processed fallback only when no pending or queued items exist", () => {
  const items = queueItems(['A', 'B', 'C'], 'processed')
  assert.deepEqual(
    selectExecutionGroup(items, 2, true).map((item) => item.id),
    ['A', 'B']
  )

  items[0].status = 'pending'
  assert.deepEqual(
    selectExecutionGroup(items, 2, true).map((item) => item.id),
    ['A']
  )
})

test('group payload preserves first-item compatibility fields and exact ordering', () => {
  const items = queueItems(['A', 'B', 'C'])
  const payload = makeQueueReservationPayload(items)
  assert.equal(payload.id, 'A')
  assert.equal(payload.annotated, 'A.png [input]')
  assert.deepEqual(payload.items, [
    { id: 'A', annotated: 'A.png [input]' },
    { id: 'B', annotated: 'B.png [input]' },
    { id: 'C', annotated: 'C.png [input]' }
  ])
  assert.deepEqual(queueReservationMembers(payload), payload.items)
})

test('single-item payload remains in legacy id/annotated shape', () => {
  const [item] = queueItems(['A'])
  const payload = makeQueueReservationPayload([item])
  assert.deepEqual(payload, { id: 'A', annotated: 'A.png [input]' })
  assert.deepEqual(queueReservationMembers(payload), [payload])
})

test('duplicate physical paths remain independent reservation members by queue id', () => {
  const items = [
    { id: 'A1', annotated: 'same.png [input]', status: 'pending' },
    { id: 'A2', annotated: 'same.png [input]', status: 'pending' },
    { id: 'B', annotated: 'other.png [input]', status: 'pending' }
  ]
  const payload = makeQueueReservationPayload(selectExecutionGroup(items, 3))
  assert.deepEqual(queueReservationMembers(payload).map((item) => item.id), ['A1', 'A2', 'B'])
})

test('new grouped backend delta identifies every processed logical item', () => {
  const delta = {
    processed_item_id: 'A',
    processed_items: [
      { id: 'A', annotated: 'A.png [input]' },
      { id: 'B', annotated: 'B.png [input]' },
      { id: 'C', annotated: 'C.png [input]' }
    ],
    new_status: 'processed',
    consumed: true
  }
  assert.deepEqual(processedItemIdsFromDelta(delta), ['A', 'B', 'C'])
  const items = queueItems(['A', 'B', 'C', 'D'], 'queued')
  assert.equal(applyProcessedIds(items, delta, 88), 3)
  assert.deepEqual(items.map((item) => item.status), ['processed', 'processed', 'processed', 'queued'])
  assert.deepEqual(items.map((item) => item.last_processed_at), [88, 88, 88, 0])
})

test('legacy singular backend delta remains supported', () => {
  const delta = { processed_item_id: 'B', new_status: 'processed', consumed: true }
  assert.deepEqual(processedItemIdsFromDelta(delta), ['B'])
  const items = queueItems(['A', 'B'], 'queued')
  applyProcessedIds(items, delta, 99)
  assert.deepEqual(items.map((item) => item.status), ['queued', 'processed'])
})

test('consumed false backend delta produces zero frontend status mutations', () => {
  const delta = {
    processed_item_id: 'A',
    processed_items: [{ id: 'A' }, { id: 'B' }],
    new_status: 'processed',
    consumed: false
  }
  const items = queueItems(['A', 'B'], 'pending')
  assert.deepEqual(processedItemIdsFromDelta(delta), [])
  assert.equal(applyProcessedIds(items, delta), 0)
  assert.deepEqual(items.map((item) => item.status), ['pending', 'pending'])
})

test('auto queue counts only complete groups', () => {
  assert.equal(completeExecutionGroupCount(7, 3), 2)
  assert.equal(calculateAutoQueueExtraExecutions(7, 3, 1), 1)
})

test('auto queue count one preserves released arithmetic', () => {
  assert.equal(completeExecutionGroupCount(7, 1), 7)
  assert.equal(calculateAutoQueueExtraExecutions(7, 1, 1), 6)
})

test('auto queue respects an already requested batch count', () => {
  assert.equal(calculateAutoQueueExtraExecutions(12, 3, 2), 2)
  assert.equal(calculateAutoQueueExtraExecutions(6, 3, 2), 0)
  assert.equal(calculateAutoQueueExtraExecutions(5, 3, 2), 0)
})

test('incomplete groups are never encoded as complete reservations', () => {
  const items = queueItems(['A', 'B'])
  const group = selectExecutionGroup(items, 3)
  assert.deepEqual(group.map((item) => item.id), ['A', 'B'])
  const payload = group.length === normalizeImagesPerExecution(3)
    ? makeQueueReservationPayload(group)
    : null
  assert.equal(payload, null)
})

test('clear queued semantics release every member because group state is per item', () => {
  const items = queueItems(['A', 'B', 'C', 'D'])
  reserveAndQueue(items, 3, false, 10)
  for (const item of items) if (item.status === 'queued') item.status = 'pending'
  assert.deepEqual(items.map((item) => item.status), ['pending', 'pending', 'pending', 'pending'])
})

test('scrollbar-only viewport width changes do not trigger resize reanchoring', () => {
  assert.equal(shouldReanchorGalleryResize(620, 620, 603, 618), false)
})

test('real widget resize still triggers identity reanchoring', () => {
  assert.equal(shouldReanchorGalleryResize(620, 760, 603, 743), true)
})
