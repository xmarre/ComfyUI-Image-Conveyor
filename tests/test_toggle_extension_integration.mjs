import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const loadedToggleSource = await readFile(
  new URL('../web/image_conveyor_reference_toggles.js', import.meta.url),
  'utf8'
)
const referenceSidecar = await readFile(
  new URL('../web/image_conveyor_reference_branch_pruning.js', import.meta.url),
  'utf8'
)
const stateSidecar = await readFile(
  new URL('../web/image_conveyor_toggle_state_sync.js', import.meta.url),
  'utf8'
)

test('the visible toggle extension owns backend state sync and all disabled-output pruning', () => {
  assert.match(loadedToggleSource, /const REFERENCE_STATE_KEY = 'reference_output_enabled'/)
  assert.match(loadedToggleSource, /const MAIN_STATE_KEY = 'main_output_enabled'/)
  assert.match(loadedToggleSource, /function syncToggleRuntimeState\(node\)/)
  assert.match(loadedToggleSource, /function disabledPromptOutputs\(graph\)/)
  assert.match(loadedToggleSource, /outputIndexes\.push\(referenceOutputIndex\(node, slot\)\)/)
  assert.match(loadedToggleSource, /for \(const node of conveyorNodes\(graph\)\) syncToggleRuntimeState\(node\)/)
  assert.match(loadedToggleSource, /pruneDisabledOutputBranches\(/)
})

test('old sidecar extension files cannot install duplicate queue or graph wrappers', () => {
  assert.doesNotMatch(referenceSidecar, /registerExtension|graphToPrompt/)
  assert.doesNotMatch(stateSidecar, /registerExtension|beforeQueued/)
})
