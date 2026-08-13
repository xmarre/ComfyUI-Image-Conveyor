import assert from 'node:assert/strict'
import test from 'node:test'

import { middleAutoscrollSpeed } from '../web/image_conveyor_middle_autoscroll_math.mjs'

test('middle autoscroll has a stable dead zone around the anchor', () => {
  assert.equal(middleAutoscrollSpeed(300, 300, 600), 0)
  assert.equal(middleAutoscrollSpeed(314, 300, 600), 0)
  assert.equal(middleAutoscrollSpeed(286, 300, 600), 0)
})

test('middle autoscroll direction follows pointer displacement', () => {
  assert.ok(middleAutoscrollSpeed(220, 300, 600) < 0)
  assert.ok(middleAutoscrollSpeed(380, 300, 600) > 0)
})

test('middle autoscroll speed ramps smoothly and clamps', () => {
  const near = middleAutoscrollSpeed(340, 300, 600)
  const farther = middleAutoscrollSpeed(430, 300, 600)
  const far = middleAutoscrollSpeed(900, 300, 600)
  assert.ok(near > 0)
  assert.ok(farther > near)
  assert.equal(far, 1440)
  assert.equal(middleAutoscrollSpeed(-300, 300, 600), -1440)
})

test('middle autoscroll scales its maximum speed with viewport bounds', () => {
  assert.equal(middleAutoscrollSpeed(1000, 0, 200), 900)
  assert.equal(middleAutoscrollSpeed(1000, 0, 1200), 1800)
  assert.equal(middleAutoscrollSpeed(Number.NaN, 0, 600), 0)
})
