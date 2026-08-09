import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateGalleryMetrics, calculateVisibleCardRange } from '../web/image_conveyor_math.mjs'

test('responsive metrics add columns as width grows', () => {
  const medium = calculateGalleryMetrics(520, 172, 10)
  const wide = calculateGalleryMetrics(1040, 172, 10)
  assert.equal(medium.columns, 2)
  assert.ok(wide.columns > medium.columns)
  assert.ok(medium.mediaHeight / medium.cardHeight >= 0.68)
})

test('ten thousand items keep a bounded live-card range', () => {
  const metrics = calculateGalleryMetrics(720, 172, 10)
  const range = calculateVisibleCardRange(
    10_000,
    metrics.columns,
    metrics.rowStride,
    10,
    250_000,
    700,
    2
  )
  assert.ok(range.end - range.start <= 40)
  assert.ok(range.start > 0)
  assert.ok(range.end < 10_000)
})

test('range clamps scroll after filtering to a smaller collection', () => {
  const metrics = calculateGalleryMetrics(520, 172, 10)
  const range = calculateVisibleCardRange(3, metrics.columns, metrics.rowStride, 10, 999_999, 700, 2)
  assert.equal(range.scrollTop, 0)
  assert.deepEqual([range.start, range.end], [0, 3])
})
