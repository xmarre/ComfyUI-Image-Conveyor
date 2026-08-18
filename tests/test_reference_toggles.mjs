import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyMainOutputToggleToReservation,
  applyReferenceToggleMaskToReservation,
  calculateReferenceToggleRect,
  filterReferenceOutputSlotsByToggleMask,
  inputRequiredFromNodeDef,
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

test('object-info input contracts distinguish required and optional sockets', () => {
  const h3Definition = {
    input: {
      required: {
        model: ['MODEL', {}],
        positive: ['CONDITIONING', {}]
      },
      optional: {
        first_frame: ['IMAGE', {}],
        reference_image_1: ['IMAGE', {}]
      }
    }
  }

  assert.equal(inputRequiredFromNodeDef(h3Definition, 'model'), true)
  assert.equal(inputRequiredFromNodeDef(h3Definition, 'first_frame'), false)
  assert.equal(inputRequiredFromNodeDef(h3Definition, 'reference_image_1'), false)
  assert.equal(inputRequiredFromNodeDef(h3Definition, 'missing'), null)
  assert.equal(inputRequiredFromNodeDef(null, 'first_frame'), null)
})

test('disabled main pruning propagates through required preprocessing and stops at optional Continuum first_frame', () => {
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
    '210': {
      inputs: { samples: ['200', 0], vae: ['301', 0] },
      class_type: 'VAEDecode'
    },
    '220': {
      inputs: { images: ['210', 0] },
      class_type: 'VideoCombine'
    },
    '300': { inputs: {}, class_type: 'ModelLoader' },
    '301': { inputs: {}, class_type: 'VAELoader' }
  }
  const nodeDefs = {
    ImageScaleToTotalPixelsX: {
      input: {
        required: { image: ['IMAGE', {}], megapixels: ['FLOAT', {}] },
        optional: {}
      }
    },
    H3ContinuumSamplerProduction: {
      input: {
        required: { model: ['MODEL', {}] },
        optional: {
          first_frame: ['IMAGE', {}],
          reference_image_1: ['IMAGE', {}]
        }
      }
    }
  }
  const resolve = (nodeId, inputName) => {
    const classType = prompt[String(nodeId)]?.class_type
    return inputRequiredFromNodeDef(nodeDefs[classType], inputName)
  }

  pruneDisabledOutputBranches(
    prompt,
    [{ nodeId: '164', outputIndexes: [0, 1] }],
    resolve
  )

  // Required preprocessing becomes unreachable instead of being deleted from
  // the serialized prompt. The optional first_frame boundary is severed.
  assert.ok(prompt['123'])
  assert.equal(Object.hasOwn(prompt['123'].inputs, 'image'), false)
  assert.equal(Object.hasOwn(prompt['200'].inputs, 'first_frame'), false)
  assert.deepEqual(prompt['200'].inputs.reference_image_1, ['164', 6])
  assert.deepEqual(prompt['200'].inputs.model, ['300', 0])
  assert.ok(prompt['200'])
  assert.ok(prompt['210'])
  assert.ok(prompt['220'])
})

test('disabled main pruning keeps required image and mask consumers serialized but unreachable', () => {
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
    (nodeId) => nodeId === '2' || nodeId === '3'
  )

  assert.ok(prompt['2'])
  assert.ok(prompt['3'])
  assert.deepEqual(prompt['2'].inputs, {})
  assert.deepEqual(prompt['3'].inputs, {})
  assert.deepEqual(prompt['4'].inputs, { keep: 1 })
})

test('pruning never deletes terminal nodes even through an all-required chain', () => {
  const prompt = {
    '1': { inputs: {}, class_type: 'ImageConveyor' },
    '2': { inputs: { image: ['1', 0] }, class_type: 'RequiredA' },
    '3': { inputs: { image: ['2', 0] }, class_type: 'RequiredB' },
    '4': { inputs: { images: ['3', 0] }, class_type: 'OutputNode' }
  }

  pruneDisabledOutputBranches(
    prompt,
    [{ nodeId: '1', outputIndexes: [0] }],
    () => true
  )

  assert.deepEqual(Object.keys(prompt).sort(), ['1', '2', '3', '4'])
  assert.deepEqual(prompt['2'].inputs, {})
  assert.deepEqual(prompt['3'].inputs, {})
  assert.deepEqual(prompt['4'].inputs, {})
})

test('unknown prompt input contracts remove only the disabled link and preserve the consumer', () => {
  const prompt = {
    '1': { inputs: {}, class_type: 'ImageConveyor' },
    '2': { inputs: { mystery: ['1', 0], keep: 7 }, class_type: 'UnknownNode' }
  }
  pruneDisabledOutputBranches(prompt, [{ nodeId: '1', outputIndexes: [0] }])
  assert.ok(prompt['2'])
  assert.deepEqual(prompt['2'].inputs, { keep: 7 })
})

test('unknown first-frame contract cannot erase a ref2va output branch', () => {
  const prompt = {
    '1': { inputs: {}, class_type: 'ImageConveyor' },
    '2': {
      inputs: {
        first_frame: ['1', 0],
        reference_image_1: ['1', 6],
        reference_image_2: ['1', 7],
        reference_image_3: ['1', 8],
        model: ['10', 0]
      },
      class_type: 'H3ContinuumSamplerProduction'
    },
    '3': {
      inputs: { samples: ['2', 0], vae: ['11', 0] },
      class_type: 'VAEDecode'
    },
    '4': {
      inputs: { images: ['3', 0] },
      class_type: 'VideoCombine'
    },
    '10': { inputs: {}, class_type: 'ModelLoader' },
    '11': { inputs: {}, class_type: 'VAELoader' }
  }

  pruneDisabledOutputBranches(
    prompt,
    [{ nodeId: '1', outputIndexes: [0, 1] }],
    () => null
  )

  assert.ok(prompt['2'])
  assert.equal(Object.hasOwn(prompt['2'].inputs, 'first_frame'), false)
  assert.deepEqual(prompt['2'].inputs.reference_image_1, ['1', 6])
  assert.deepEqual(prompt['2'].inputs.reference_image_2, ['1', 7])
  assert.deepEqual(prompt['2'].inputs.reference_image_3, ['1', 8])
  assert.ok(prompt['3'])
  assert.ok(prompt['4'])
})

test('toggle geometry stays between the shelf and output label and hit testing is exact', () => {
  const rect = calculateReferenceToggleRect(390, 455, 210)
  assert.deepEqual(rect, { x: 422, y: 203, width: 26, height: 14 })
  assert.equal(referenceToggleHit([{ index: 3, ...rect }], 435, 210), 3)
  assert.equal(referenceToggleHit([{ index: 3, ...rect }], 455, 210), null)
  assert.equal(calculateReferenceToggleRect(430, 450, 210), null)
})
