import assert from 'node:assert/strict'
import test from 'node:test'

import { disabledReferenceOutputIndexes } from '../web/image_conveyor_reference_branch_pruning_math.mjs'
import {
  inputRequiredFromNodeDef,
  pruneDisabledOutputBranches
} from '../web/image_conveyor_reference_toggles_math.mjs'

test('disabled reference output indexes follow the eight-slot toggle mask', () => {
  assert.deepEqual(
    disabledReferenceOutputIndexes(
      [false, true, false, true, true, true, true, false],
      [6, 7, 8, 9, 10, 11, 12, 13]
    ),
    [6, 8, 13]
  )
})

test('disabled direct reference link is omitted while Continuum first frame remains active', () => {
  const prompt = {
    '164': { inputs: {}, class_type: 'ImageConveyor' },
    '219': { inputs: {}, class_type: 'LoadImage' },
    '214': {
      inputs: {
        first_frame: ['219', 0],
        reference_image_1: ['164', 6],
        reference_image_2: ['164', 7],
        model: ['300', 0]
      },
      class_type: 'H3ContinuumSamplerTimelineVideo'
    },
    '300': { inputs: {}, class_type: 'ModelLoader' }
  }
  const nodeDefs = {
    H3ContinuumSamplerTimelineVideo: {
      input: {
        required: { model: ['MODEL', {}] },
        optional: {
          first_frame: ['IMAGE', {}],
          reference_image_1: ['IMAGE', {}],
          reference_image_2: ['IMAGE', {}]
        }
      }
    }
  }
  const required = (nodeId, inputName) => {
    const classType = prompt[String(nodeId)]?.class_type
    return inputRequiredFromNodeDef(nodeDefs[classType], inputName)
  }

  pruneDisabledOutputBranches(
    prompt,
    [{ nodeId: '164', outputIndexes: [6] }],
    required
  )

  assert.deepEqual(prompt['214'].inputs.first_frame, ['219', 0])
  assert.equal(Object.hasOwn(prompt['214'].inputs, 'reference_image_1'), false)
  assert.deepEqual(prompt['214'].inputs.reference_image_2, ['164', 7])
  assert.deepEqual(prompt['214'].inputs.model, ['300', 0])
  assert.ok(prompt['214'])
})

test('disabled reference branch propagates through required transforms and stops at Continuum optional input', () => {
  const prompt = {
    '164': { inputs: {}, class_type: 'ImageConveyor' },
    '123': {
      inputs: { image: ['164', 6], megapixels: 0.7 },
      class_type: 'ImageScaleToTotalPixelsX'
    },
    '219': { inputs: {}, class_type: 'LoadImage' },
    '214': {
      inputs: {
        first_frame: ['219', 0],
        reference_image_1: ['123', 0],
        model: ['300', 0]
      },
      class_type: 'H3ContinuumSamplerTimelineVideo'
    },
    '300': { inputs: {}, class_type: 'ModelLoader' }
  }
  const nodeDefs = {
    ImageScaleToTotalPixelsX: {
      input: {
        required: { image: ['IMAGE', {}], megapixels: ['FLOAT', {}] },
        optional: {}
      }
    },
    H3ContinuumSamplerTimelineVideo: {
      input: {
        required: { model: ['MODEL', {}] },
        optional: {
          first_frame: ['IMAGE', {}],
          reference_image_1: ['IMAGE', {}]
        }
      }
    }
  }
  const required = (nodeId, inputName) => {
    const classType = prompt[String(nodeId)]?.class_type
    return inputRequiredFromNodeDef(nodeDefs[classType], inputName)
  }

  pruneDisabledOutputBranches(
    prompt,
    [{ nodeId: '164', outputIndexes: [6] }],
    required
  )

  // Required transforms remain serialized but are disconnected and therefore
  // unreachable. The optional Continuum reference boundary is severed without
  // deleting the sampler or any terminal/output path.
  assert.ok(prompt['123'])
  assert.equal(Object.hasOwn(prompt['123'].inputs, 'image'), false)
  assert.deepEqual(prompt['123'].inputs.megapixels, 0.7)
  assert.equal(Object.hasOwn(prompt['214'].inputs, 'reference_image_1'), false)
  assert.deepEqual(prompt['214'].inputs.first_frame, ['219', 0])
  assert.deepEqual(prompt['214'].inputs.model, ['300', 0])
  assert.ok(prompt['214'])
})
