import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../web/media_resolution_status.js', import.meta.url), 'utf8')
const extensions = []
runInNewContext(source.replace(/^import \{ app \} from .*\n/, ''), {
  app: { registerExtension: (extension) => extensions.push(extension) }
})

test('status extension installs only on the media router and preserves existing hooks', () => {
  assert.equal(extensions.length, 1)
  const extension = extensions[0]
  const other = { type: 'ImageConveyor' }
  extension.nodeCreated(other)
  assert.equal(other.onExecuted, undefined)

  let previousExecutions = 0
  let previousDraws = 0
  const node = {
    type: 'ImageConveyorMediaResolution',
    size: [420, 500],
    widgets: [{ last_y: 455, height: 20 }],
    computeSize: () => [420, 495],
    setSize(next) { this.size = next },
    setDirtyCanvas() {},
    onExecuted() { previousExecutions += 1 },
    onDrawForeground() { previousDraws += 1 }
  }
  extension.nodeCreated(node)
  extension.nodeCreated(node)
  node.onExecuted({ text: ['MP capped: 1 / 1', 'Ref 1: 1.80 → 1.49 MP (native 1.52)'] })
  assert.equal(previousExecutions, 1)
  assert.deepEqual(Array.from(node.__imageConveyorMpStatus), [
    'MP capped: 1 / 1', 'Ref 1: 1.80 → 1.49 MP (native 1.52)'
  ])
  assert.ok(node.size[1] >= 495 + 4 + 2 * 17 + 8)

  const texts = []
  const ctx = {
    save() {}, restore() {},
    fillText(...args) { texts.push(args) }
  }
  node.onDrawForeground(ctx)
  assert.equal(previousDraws, 1)
  assert.equal(texts.length, 2)
  assert.equal(texts[1][0], 'Ref 1: 1.80 → 1.49 MP (native 1.52)')

  // A cached/executed result must replace prior warnings instead of retaining stale caps.
  node.onExecuted({ text: ['MP capped: 0 / 1'] })
  assert.deepEqual(Array.from(node.__imageConveyorMpStatus), ['MP capped: 0 / 1'])
  node.flags = { collapsed: true }
  node.onDrawForeground(ctx)
  assert.equal(texts.length, 2)
})
