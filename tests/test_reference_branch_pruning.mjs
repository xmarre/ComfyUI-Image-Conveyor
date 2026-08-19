import assert from 'node:assert/strict'
import test from 'node:test'

import { disabledReferenceOutputIndexes } from '../web/image_conveyor_reference_branch_pruning_math.mjs'
import {
  inputRequiredFromNodeDef,
  pruneDisabledOutputBranches
} from '../web/image_conveyor_reference_toggles_math.mjs'

function requirementResolver(prompt, nodeDefs) {
  return (nodeId, inputName) => {
    const classType = prompt[String(nodeId)]?.class_type
    return inputRequiredFromNodeDef(nodeDefs[classType], inputName)
  }
}

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

  pruneDisabledOutputBranches(
    prompt,
    [{ nodeId: '164', outputIndexes: [6] }],
    requirementResolver(prompt, nodeDefs)
  )

  assert.deepEqual(prompt['214'].inputs.first_frame, ['219', 0])
  assert.equal(Object.hasOwn(prompt['214'].inputs, 'reference_image_1'), false)
  assert.deepEqual(prompt['214'].inputs.reference_image_2, ['164', 7])
  assert.deepEqual(prompt['214'].inputs.model, ['300', 0])
  assert.ok(prompt['214'])
})

test('required transform is removed while propagation stops at Continuum optional input', () => {
  const prompt = {
    '164': { inputs: {}, class_type: 'ImageConveyor' },
    '123': {
      inputs: { image: ['164', 0], megapixels: 0.7 },
      class_type: 'ImageScaleToTotalPixelsX'
    },
    '214': {
      inputs: {
        first_frame: ['123', 0],
        reference_image_1: ['164', 6],
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

  pruneDisabledOutputBranches(
    prompt,
    [{ nodeId: '164', outputIndexes: [0] }],
    requirementResolver(prompt, nodeDefs)
  )

  assert.equal(Object.hasOwn(prompt, '123'), false)
  assert.equal(Object.hasOwn(prompt['214'].inputs, 'first_frame'), false)
  assert.deepEqual(prompt['214'].inputs.reference_image_1, ['164', 6])
  assert.deepEqual(prompt['214'].inputs.model, ['300', 0])
  assert.ok(prompt['214'])
})

test('disabled main image fully suppresses invalid image-only output targets while ref-only output chain survives', () => {
  const prompt = {
    '164': { inputs: {}, class_type: 'ImageConveyor' },
    '123': {
      inputs: { image: ['164', 0], megapixels: 0.7 },
      class_type: 'ImageScaleToTotalPixelsX'
    },
    '223': {
      inputs: { image: ['164', 0], megapixels: 0.7 },
      class_type: 'ImageScaleToTotalPixelsX'
    },
    '174': {
      inputs: { images: ['123', 0], frame_rate: 24 },
      class_type: 'VHS_VideoCombine'
    },
    '214': {
      inputs: {
        first_frame: ['223', 0],
        reference_image_1: ['164', 6],
        reference_image_2: ['164', 7],
        model: ['300', 0]
      },
      class_type: 'H3ContinuumSamplerTimelineVideo'
    },
    '215': {
      inputs: { samples: ['214', 0], vae: ['301', 0] },
      class_type: 'VAEDecode'
    },
    '216': {
      inputs: { images: ['215', 0], frame_rate: 24 },
      class_type: 'VHS_VideoCombine'
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
    VHS_VideoCombine: {
      input: {
        required: { images: ['IMAGE', {}], frame_rate: ['FLOAT', {}] },
        optional: {}
      }
    },
    H3ContinuumSamplerTimelineVideo: {
      input: {
        required: { model: ['MODEL', {}] },
        optional: {
          first_frame: ['IMAGE', {}],
          reference_image_1: ['IMAGE', {}],
          reference_image_2: ['IMAGE', {}]
        }
      }
    },
    VAEDecode: {
      input: {
        required: { samples: ['LATENT', {}], vae: ['VAE', {}] },
        optional: {}
      }
    }
  }

  pruneDisabledOutputBranches(
    prompt,
    [{ nodeId: '164', outputIndexes: [0, 1] }],
    requirementResolver(prompt, nodeDefs)
  )

  assert.equal(Object.hasOwn(prompt, '123'), false)
  assert.equal(Object.hasOwn(prompt, '223'), false)
  assert.equal(Object.hasOwn(prompt, '174'), false)

  assert.ok(prompt['214'])
  assert.equal(Object.hasOwn(prompt['214'].inputs, 'first_frame'), false)
  assert.deepEqual(prompt['214'].inputs.reference_image_1, ['164', 6])
  assert.deepEqual(prompt['214'].inputs.reference_image_2, ['164', 7])
  assert.ok(prompt['215'])
  assert.deepEqual(prompt['215'].inputs.samples, ['214', 0])
  assert.ok(prompt['216'])
  assert.deepEqual(prompt['216'].inputs.images, ['215', 0])
})

test('required-only chain removes its invalid terminal target', () => {
  const prompt = {
    '164': { inputs: {}, class_type: 'ImageConveyor' },
    '123': {
      inputs: { image: ['164', 0] },
      class_type: 'RequiredTransform'
    },
    '174': {
      inputs: { images: ['123', 0] },
      class_type: 'RequiredOutput'
    }
  }
  const nodeDefs = {
    RequiredTransform: { input: { required: { image: ['IMAGE', {}] }, optional: {} } },
    RequiredOutput: { input: { required: { images: ['IMAGE', {}] }, optional: {} } }
  }

  pruneDisabledOutputBranches(
    prompt,
    [{ nodeId: '164', outputIndexes: [0] }],
    requirementResolver(prompt, nodeDefs)
  )

  assert.equal(Object.hasOwn(prompt, '123'), false)
  assert.equal(Object.hasOwn(prompt, '174'), false)
  assert.ok(prompt['164'])
})

test('unknown input contract removes only the unavailable link and keeps the consumer', () => {
  const prompt = {
    '164': { inputs: {}, class_type: 'ImageConveyor' },
    '500': {
      inputs: { maybe_image: ['164', 0], other: ['501', 0] },
      class_type: 'UnknownNode'
    },
    '501': { inputs: {}, class_type: 'OtherSource' }
  }

  pruneDisabledOutputBranches(
    prompt,
    [{ nodeId: '164', outputIndexes: [0] }],
    () => null
  )

  assert.ok(prompt['500'])
  assert.equal(Object.hasOwn(prompt['500'].inputs, 'maybe_image'), false)
  assert.deepEqual(prompt['500'].inputs.other, ['501', 0])
})
