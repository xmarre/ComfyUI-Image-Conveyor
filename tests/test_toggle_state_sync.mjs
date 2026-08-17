import assert from 'node:assert/strict'
import test from 'node:test'

import {
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
