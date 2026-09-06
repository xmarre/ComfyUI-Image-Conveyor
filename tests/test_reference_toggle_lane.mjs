import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { calculateReferenceShelfLayout } from '../web/image_conveyor_math.mjs'
import {
  referenceOutputGutterFromLabelWidths,
  reserveReferenceToggleGutter
} from '../web/image_conveyor_reference_toggle_lane_math.mjs'
import { calculateReferenceToggleRect } from '../web/image_conveyor_reference_toggles_math.mjs'

const laneSource = readFileSync(
  new URL('../web/image_conveyor_reference_toggle_lane.js', import.meta.url),
  'utf8'
)

function toggleRectFor(labelWidth, outputGutter) {
  const nodeWidth = 520
  const shelf = calculateReferenceShelfLayout(nodeWidth, 290, outputGutter, 30)
  const labelLeft = nodeWidth - 11 - labelWidth
  return {
    shelf,
    rect: calculateReferenceToggleRect(shelf.right, labelLeft, 210),
    labelLeft
  }
}

test('reference toggles get a browser-independent lane beyond their own measured labels', () => {
  for (const labelWidth of [52, 69, 80, 90, 110]) {
    const measuredOutputGutter = referenceOutputGutterFromLabelWidths([labelWidth])
    const reservedOutputGutter = reserveReferenceToggleGutter(measuredOutputGutter)
    const { shelf, rect, labelLeft } = toggleRectFor(labelWidth, reservedOutputGutter)

    assert.ok(rect, `expected a toggle for a ${labelWidth}px output label`)
    assert.equal(rect.width, 26)
    assert.ok(rect.x >= shelf.right + 7)
    assert.ok(rect.x + rect.width <= labelLeft - 7)
  }
})

test('lane measurement uses the toggle font instead of trusting a narrower foreground font', () => {
  const toggleLabelWidth = 110
  const narrowerForegroundWidth = 82

  const staleMeasuredGutter = referenceOutputGutterFromLabelWidths([narrowerForegroundWidth])
  const staleReservedGutter = reserveReferenceToggleGutter(staleMeasuredGutter)
  assert.equal(toggleRectFor(toggleLabelWidth, staleReservedGutter).rect, null)

  const authoritativeMeasuredGutter = referenceOutputGutterFromLabelWidths([toggleLabelWidth])
  const authoritativeReservedGutter = reserveReferenceToggleGutter(authoritativeMeasuredGutter)
  const { rect } = toggleRectFor(toggleLabelWidth, authoritativeReservedGutter)
  assert.ok(rect)
  assert.equal(rect.width, 26)
})

test('output gutter calculation uses the widest finite measured label', () => {
  assert.equal(referenceOutputGutterFromLabelWidths([]), 72)
  assert.equal(referenceOutputGutterFromLabelWidths([20, 90, 50]), 120)
  assert.equal(referenceOutputGutterFromLabelWidths([Number.NaN, 110]), 140)
})

test('toggle lane measures with node.innerFontStyle, invalidates the shelf once, and redraws', () => {
  assert.match(laneSource, /context\.font = fontStyle/)
  assert.match(laneSource, /context\.measureText\(label\)\.width/)
  assert.match(laneSource, /node\?\.innerFontStyle/)
  assert.match(laneSource, /ctx\.referenceOutputGutter = reservedGutter/)
  assert.match(laneSource, /ctx\.referenceShelfLayout = null/)
  assert.match(laneSource, /ext\.gutterKey === gutterKey/)
  assert.match(laneSource, /currentGutter === ext\.reservedGutter/)
  assert.match(laneSource, /node\.setDirtyCanvas\?\.\(true, false\)/)
})
