import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyMainOutputToggleToReservation,
  applyReferenceToggleMaskToReservation,
  calculateReferenceToggleRect,
  filterReferenceOutputSlotsByToggleMask,
  normalizeMainOutputEnabled,
  normalizeReferenceToggleMask,
  pruneDisabledOutputBranches,
  referenceToggleHit,
  toggleMainOutputEnabled,
  toggleReferenceToggleMask
} from '../web/image_conveyor_reference_toggles_math.mjs'

test('reference toggles default enabled and only explicit false disables a slot', () => {
  assert.deepEqual(normalizeReferenceToggleMask(undefined), Array(8).fill(true))
  assert.deepEqual(
    normalizeReferenceToggleMask([false, true, null, 0, '', false]),
    [false, true, true, true, true, false, true, true]
  )
})

test('main output toggle defaults enabled and round-trips explicit disable', () => {
  assert.equal(normalizeMainOutputEnabled(undefined), true)
  assert.equal(normalizeMainOutputEnabled(null), true)
  assert.equal(normalizeMainOutputEnabled(false), false)
  assert.equal(toggleMainOutputEnabled(undefined), false)
  assert.equal(toggleMainOutputEnabled(false), true)
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

test('disabling main output strips queue reservation members but preserves reference snapshot', () => {
  const payload = {
    id: 'A',
    annotated: 'A.png [input]',
    items: [{ id: 'A', annotated: 'A.png [input]' }],
    reference_output_slots: [1, 4, 8]
  }
  assert.deepEqual(applyMainOutputToggleToReservation(payload, false), {
    main_output_enabled: false,
    reference_output_slots: [1, 4, 8]
  })
  assert.deepEqual(applyMainOutputToggleToReservation(payload, true), {
    ...payload,
    main_output_enabled: true
  })
})

test('disabled main prompt pruning removes a required transform chain at an optional boundary', () => {
  const prompt = {
    '164': { inputs: {}, class_type: 'ImageConveyor' },
    '123': {
      inputs: { image: ['164', 0], megapixels: 0.7 },
      class_type: 'ImageScaleToTotalPixelsX'
    },
    '200': {
      inputs: {
        first_frame: ['123', 0],
        reference_image_1: ['164', 6],
        model: ['300', 0]
      },
      class_type: 'H3ContinuumSamplerProduction'
    },
    '300': { inputs: {}, class_type: 'ModelLoader' }
  }
  const required = new Set(['123:image', '200:model'])

  pruneDisabledOutputBranches(
    prompt,
    [{ nodeId: '164', outputIndexes: [0, 1] }],
    (nodeId, inputName) => required.has(`${nodeId}:${inputName}`)
  )

  assert.equal(prompt['123'], undefined)
  assert.equal(Object.hasOwn(prompt['200'].inputs, 'first_frame'), false)
  assert.deepEqual(prompt['200'].inputs.reference_image_1, ['164', 6])
  assert.deepEqual(prompt['200'].inputs.model, ['300', 0])
  assert.ok(prompt['164'])
  assert.ok(prompt['200'])
})

test('disabled main prompt pruning removes image and mask consumers independently', () => {
  const prompt = {
    '1': { inputs: {}, class_type: 'ImageConveyor' },
    '2': { inputs: { image: ['1', 0] }, class_type: 'RequiredImageNode' },
    '3': { inputs: { mask: ['1', 1] }, class_type: 'RequiredMaskNode' },
    '4': {
      inputs: { optional_image: ['2', 0], optional_mask: ['3', 0], keep: 1 },
      class_type: 'OptionalConsumer'
    }
  }

  pruneDisabledOutputBranches(
    prompt,
    [{ nodeId: 1, outputIndexes: [0, 1] }],
    (nodeId, inputName) => nodeId === '2' || nodeId === '3'
  )

  assert.equal(prompt['2'], undefined)
  assert.equal(prompt['3'], undefined)
  assert.deepEqual(prompt['4'].inputs, { keep: 1 })
})

test('unknown prompt input contracts fail closed as required', () => {
  const prompt = {
    '1': { inputs: {}, class_type: 'ImageConveyor' },
    '2': { inputs: { mystery: ['1', 0] }, class_type: 'UnknownNode' }
  }
  pruneDisabledOutputBranches(prompt, [{ nodeId: '1', outputIndexes: [0] }])
  assert.equal(prompt['2'], undefined)
})

test('toggle geometry stays between the shelf and output label and hit testing is exact', () => {
  const rect = calculateReferenceToggleRect(390, 455, 210)
  assert.deepEqual(rect, { x: 422, y: 203, width: 26, height: 14 })
  assert.equal(referenceToggleHit([{ index: 3, ...rect }], 435, 210), 3)
  assert.equal(referenceToggleHit([{ index: 3, ...rect }], 455, 210), null)
  assert.equal(calculateReferenceToggleRect(430, 450, 210), null)
})
