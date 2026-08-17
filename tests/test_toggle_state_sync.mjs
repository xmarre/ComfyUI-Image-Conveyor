import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeQueueOutputSlots,
  serializeToggleQueueSnapshot,
  serializeToggleRuntimeState
} from '../web/image_conveyor_toggle_state_math.mjs'

test('toggle runtime state embeds reference, main, and last-frame switches', () => {
  const raw = JSON.stringify({
    version: 2,
    output_mode: 'persistent_refs',
    items: [{ id: 'A' }]
  })
  const next = JSON.parse(serializeToggleRuntimeState(
    raw,
    [false, true, false, true, true, true, true, false],
    false,
    8,
    false
  ))

  assert.deepEqual(next.reference_output_enabled, [
    false, true, false, true, true, true, true, false
  ])
  assert.equal(next.main_output_enabled, false)
  assert.equal(next.last_frame_output_enabled, false)
  assert.deepEqual(next.items, [{ id: 'A' }])
})

test('queue-output roles normalize to image and last_frame only', () => {
  assert.deepEqual(normalizeQueueOutputSlots([1, 0, 1, -1, 2, true]), [0, 1])
})

test('toggle runtime state changes when only the visual switch state changes', () => {
  const raw = JSON.stringify({ version: 2, output_mode: 'persistent_refs' })
  const enabled = serializeToggleRuntimeState(raw, Array(8).fill(true), true, 8, true)
  const disabled = serializeToggleRuntimeState(raw, Array(8).fill(true), true, 8, false)
  assert.notEqual(enabled, disabled)
})

test('malformed state is left unchanged instead of inventing a backend state', () => {
  assert.equal(serializeToggleRuntimeState('{bad', [false], false), '{bad')
})

test('reference-only emits explicit empty queue topology and filtered references', () => {
  const next = JSON.parse(serializeToggleQueueSnapshot(
    '',
    'persistent_refs',
    [1, 2, 3, 4],
    [false, true, false, true, true, true, true, true],
    false,
    8,
    [],
    false
  ))

  assert.deepEqual(next.reference_output_slots, [2, 4])
  assert.deepEqual(next.queue_output_slots, [])
  assert.equal(next.main_output_enabled, false)
  assert.equal(next.last_frame_output_enabled, false)
  assert.equal(Object.hasOwn(next, 'id'), false)
})

test('image-only keeps one reservation and emits queue role 0', () => {
  const raw = JSON.stringify({ id: 'A', annotated: 'a.png [input]' })
  const next = JSON.parse(serializeToggleQueueSnapshot(
    raw,
    'persistent_refs',
    [1, 2],
    [true, false, true, true, true, true, true, true],
    true,
    8,
    [0],
    true
  ))

  assert.equal(next.id, 'A')
  assert.deepEqual(next.queue_output_slots, [0])
  assert.deepEqual(next.reference_output_slots, [1])
})

test('last-frame-only keeps its reservation even though main is disabled', () => {
  const raw = JSON.stringify({ id: 'A', annotated: 'a.png [input]' })
  const next = JSON.parse(serializeToggleQueueSnapshot(
    raw,
    'persistent_refs',
    [],
    Array(8).fill(true),
    false,
    8,
    [1],
    true
  ))

  assert.equal(next.id, 'A')
  assert.equal(next.annotated, 'a.png [input]')
  assert.deepEqual(next.queue_output_slots, [1])
  assert.equal(next.main_output_enabled, false)
  assert.equal(next.last_frame_output_enabled, true)
})

test('image plus last_frame preserves a two-member reservation', () => {
  const raw = JSON.stringify({
    id: 'A',
    annotated: 'a.png [input]',
    items: [
      { id: 'A', annotated: 'a.png [input]' },
      { id: 'B', annotated: 'b.png [input]' }
    ]
  })
  const next = JSON.parse(serializeToggleQueueSnapshot(
    raw,
    'persistent_refs',
    [],
    Array(8).fill(true),
    true,
    8,
    [0, 1],
    true
  ))

  assert.deepEqual(next.queue_output_slots, [0, 1])
  assert.equal(next.items.length, 2)
})

test('disabled last_frame filters role 1 out of a connected queue topology', () => {
  const raw = JSON.stringify({ id: 'A', annotated: 'a.png [input]' })
  const next = JSON.parse(serializeToggleQueueSnapshot(
    raw,
    'persistent_refs',
    [],
    Array(8).fill(true),
    true,
    8,
    [0, 1],
    false
  ))
  assert.deepEqual(next.queue_output_slots, [0])
})

test('queue-group mode is untouched by persistent-reference toggle serialization', () => {
  const raw = JSON.stringify({ id: 'A', annotated: 'a.png [input]' })
  assert.equal(
    serializeToggleQueueSnapshot(raw, 'queue_group', [1], [false], false, 8, [1], true),
    raw
  )
})
