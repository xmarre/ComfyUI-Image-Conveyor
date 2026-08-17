import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyReferenceToggleMaskToReservation,
  calculateReferenceToggleRect,
  filterReferenceOutputSlotsByToggleMask,
  normalizeReferenceToggleMask,
  referenceToggleHit,
  toggleReferenceToggleMask
} from '../web/image_conveyor_reference_toggles_math.mjs'

test('reference toggles default enabled and only explicit false disables a slot', () => {
  assert.deepEqual(normalizeReferenceToggleMask(undefined), Array(8).fill(true))
  assert.deepEqual(
    normalizeReferenceToggleMask([false, true, null, 0, '', false]),
    [false, true, true, true, true, false, true, true]
  )
})

test('toggling preserves the fixed eight-slot shape', () => {
  assert.deepEqual(
    toggleReferenceToggleMask(undefined, 2),
    [true, true, false, true, true, true, true, true]
  )
  assert.deepEqual(toggleReferenceToggleMask([false], -1), [false, true, true, true, true, true, true, true])
})

test('queue snapshot filtering removes only valid disabled reference slots', () => {
  const mask = [true, false, true, true, false, true, true, false]
  assert.deepEqual(filterReferenceOutputSlotsByToggleMask([1, 2, 5, 8], mask), [1])

  // Preserve malformed entries so backend validation remains authoritative instead of hiding corruption.
  assert.deepEqual(
    filterReferenceOutputSlotsByToggleMask([1, '2', 9, 2], mask),
    [1, '2', 9]
  )
  assert.equal(filterReferenceOutputSlotsByToggleMask(null, mask), null)
})

test('reservation masking preserves unrelated payload fields', () => {
  const payload = { id: 'A', annotated: 'A.png [input]', reference_output_slots: [1, 2, 8] }
  assert.deepEqual(applyReferenceToggleMaskToReservation(payload, [true, false, true, true, true, true, true, false]), {
    id: 'A', annotated: 'A.png [input]', reference_output_slots: [1]
  })
  assert.equal(applyReferenceToggleMaskToReservation(null, [false]), null)
  assert.deepEqual(applyReferenceToggleMaskToReservation({ id: 'A' }, [false]), { id: 'A' })
})

test('toggle geometry stays between the shelf and output label and hit testing is exact', () => {
  const rect = calculateReferenceToggleRect(390, 455, 210)
  assert.deepEqual(rect, { x: 422, y: 203, width: 26, height: 14 })
  assert.equal(referenceToggleHit([{ index: 3, ...rect }], 435, 210), 3)
  assert.equal(referenceToggleHit([{ index: 3, ...rect }], 455, 210), null)
  assert.equal(calculateReferenceToggleRect(430, 450, 210), null)
})
