import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../web/image_conveyor.js', import.meta.url), 'utf8')

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `Missing ${name} implementation`)
  const match = source.slice(start).match(/^function [\s\S]*?^\}/m)
  assert.ok(match, `Unable to extract ${name} implementation`)
  return match[0]
}

// Exercise the production formatter without initializing the ComfyUI browser extension.
const { imagePropertyLines } = runInNewContext(
  `${extractFunction('formatByteCount')}\n${extractFunction('imagePropertyLines')}\n({ imagePropertyLines })`,
  { getInputRelativePath: (item) => item?.relative_path || '' }
)

test('image properties display decimal megapixels alongside existing metadata', () => {
  const lines = Array.from(imagePropertyLines({
    width: 1008,
    height: 1512,
    format: 'JPEG',
    size: 119100,
    mtime_ms: 0,
    relative_path: 'references/portrait.jpg'
  }, {}))
  assert.deepEqual(lines, [
    '1008 × 1512 · 1.52 MP · JPEG · 116.3 KiB',
    'references/portrait.jpg'
  ])
})

test('local image metadata and multi-frame images use the same MP formatting', () => {
  const lines = Array.from(imagePropertyLines({
    width: 512,
    height: 512,
    format: 'PNG',
    frames: 3
  }, {
    relative_path: 'local/image.png',
    localFile: { size: 1024, lastModified: 0 }
  }))
  assert.deepEqual(lines, [
    '512 × 512 · 0.26 MP · PNG · 1.00 KiB · 3 frames',
    'local/image.png'
  ])
})

test('missing or invalid dimensions never display a fabricated MP value', () => {
  for (const dimensions of [
    { width: 0, height: 1512 },
    { height: 1512 },
    { width: 1e308, height: 1e308 }
  ]) {
    const lines = Array.from(imagePropertyLines({
      ...dimensions,
      format: 'JPEG',
      size: 100,
      mtime_ms: 0
    }, {}))
    assert.deepEqual(lines, ['JPEG · 100 B'])
  }
})
