import assert from 'node:assert/strict'
import test from 'node:test'

import {
  serializeToggleQueueSnapshot,
  serializeToggleRuntimeState
} from '../web/image_conveyor_toggle_state_math.mjs'

test('toggle runtime state is embedded in backend-visible state_json', () => {
  const raw = JSON.stringify({
    version: 2,
    output_mode: 'persistent_refs',
    items: [{ id: 'A' }]
  })
  const next = JSON.parse(serializeToggleRuntimeState(
    raw,
    [false, true, false, true, true, true, true, false],
    false
  ))

  assert.deepEqual(next.reference_output_enabled, [
    false, true, false, true, true, true, true, false
  ])
  assert.equal(next.main_output_enabled, false)
  assert.deepEqual(next.items, [{ id: 'A' }])
})

test('toggle runtime state changes when only the visual switch state changes', () => {
  const raw = JSON.stringify({ version: 2, output_mode: 'persistent_refs' })
  const enabled = serializeToggleRuntimeState(raw, Array(8).fill(true), true)
  const disabled = serializeToggleRuntimeState(raw, [false, ...Array(7).fill(true)], true)
  assert.notEqual(enabled, disabled)
})

test('malformed state is left unchanged instead of inventing a backend state', () => {
  assert.equal(serializeToggleRuntimeState('{bad', [false], false), '{bad')
})

test('persistent references emit an explicit filtered topology without a main reservation', () => {
  const next = JSON.parse(serializeToggleQueueSnapshot(
    '',
    'persistent_refs',
    [1, 2, 3, 4],
    [false, true, false, true, true, true, true, true],
    true
  ))

  assert.deepEqual(next.reference_output_slots, [2, 4])
  assert.equal(next.main_output_enabled, true)
  assert.equal(Object.hasOwn(next, 'id'), false)
})

test('disabled main output strips reservation but preserves filtered reference topology', () => {
  const raw = JSON.stringify({
    id: 'A',
    annotated: 'a.png [input]',
    reference_output_slots: [1, 2, 3]
  })
  const next = JSON.parse(serializeToggleQueueSnapshot(
    raw,
    'persistent_refs',
    [1, 2, 3],
    [true, false, true, true, true, true, true, true],
    false
  ))

  assert.deepEqual(next.reference_output_slots, [1, 3])
  assert.equal(next.main_output_enabled, false)
  assert.equal(Object.hasOwn(next, 'id'), false)
  assert.equal(Object.hasOwn(next, 'annotated'), false)
})

test('main reservation survives while disabled references are removed from its snapshot', () => {
  const raw = JSON.stringify({ id: 'A', annotated: 'a.png [input]' })
  const next = JSON.parse(serializeToggleQueueSnapshot(
    raw,
    'persistent_refs',
    [1, 2, 3],
    [false, true, true, true, true, true, true, true],
    true
  ))

  assert.equal(next.id, 'A')
  assert.equal(next.annotated, 'a.png [input]')
  assert.deepEqual(next.reference_output_slots, [2, 3])
  assert.equal(next.main_output_enabled, true)
})

test('queue-group mode is untouched by persistent-reference toggle serialization', () => {
  const raw = JSON.stringify({ id: 'A', annotated: 'a.png [input]' })
  assert.equal(
    serializeToggleQueueSnapshot(raw, 'queue_group', [1], [false], false),
    raw
  )
})
