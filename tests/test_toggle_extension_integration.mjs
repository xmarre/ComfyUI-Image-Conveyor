import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const loadedToggleSource = await readFile(
  new URL('../web/image_conveyor_reference_toggles.js', import.meta.url),
  'utf8'
)
const lastFrameToggleSource = await readFile(
  new URL('../web/image_conveyor_last_frame_toggle.js', import.meta.url),
  'utf8'
)
const referenceSidecar = await readFile(
  new URL('../web/image_conveyor_reference_branch_pruning.js', import.meta.url),
  'utf8'
)
const stateGuard = await readFile(
  new URL('../web/image_conveyor_toggle_state_sync.js', import.meta.url),
  'utf8'
)

test('reference/main toggle extension owns direct state sync and reference pruning', () => {
  assert.match(loadedToggleSource, /const REFERENCE_STATE_KEY = 'reference_output_enabled'/)
  assert.match(loadedToggleSource, /const MAIN_STATE_KEY = 'main_output_enabled'/)
  assert.match(loadedToggleSource, /function syncToggleRuntimeState\(node\)/)
  assert.match(loadedToggleSource, /function disabledPromptOutputs\(graph\)/)
  assert.match(loadedToggleSource, /outputIndexes\.push\(referenceOutputIndex\(node, slot\)\)/)
  assert.match(loadedToggleSource, /pruneDisabledOutputBranches\(/)
})

test('dedicated last-frame extension owns its switch and independent prompt pruning', () => {
  assert.match(lastFrameToggleSource, /LAST_FRAME_PROPERTY_KEY = 'image_conveyor_last_frame_enabled'/)
  assert.match(lastFrameToggleSource, /function currentLastFrameEnabled\(node\)/)
  assert.match(lastFrameToggleSource, /function lastFrameOutputIndex\(node\)/)
  assert.match(lastFrameToggleSource, /function disabledLastFrameOutputs\(graph\)/)
  assert.match(lastFrameToggleSource, /pruneDisabledOutputBranches\(/)
  assert.match(lastFrameToggleSource, /outputIndexByName\(node, 'last_frame'/)
})

test('reference pruning sidecar cannot install a duplicate graph wrapper', () => {
  assert.doesNotMatch(referenceSidecar, /registerExtension|graphToPrompt/)
})

test('widget guard owns exact persistent reservations independent of wrapper order', () => {
  assert.match(stateGuard, /ToggleStateWidgetGuard/)
  assert.match(stateGuard, /LAST_FRAME_PROPERTY_KEY = 'image_conveyor_last_frame_enabled'/)
  assert.match(stateGuard, /function connectedQueueSlots\(node\)/)
  assert.match(stateGuard, /outputConnected\(node, 'last_frame'/)
  assert.match(stateGuard, /selectExecutionGroup\(/)
  assert.match(stateGuard, /makeQueueReservationPayload\(/)
  assert.match(stateGuard, /function buildPersistentQueueValue\(node, stateWidget\)/)
  assert.match(stateGuard, /function authoritativeQueueValue\(node, stateWidget, raw\)/)
  assert.match(stateGuard, /replacePersistentReservation\(/)
  assert.match(stateGuard, /queueWidget\.beforeQueued = function/)
  assert.match(stateGuard, /wrapSerializer\([\s\S]*queueWidget,[\s\S]*authoritativeQueueValue/)
  assert.match(stateGuard, /queueWidget\.afterQueued = function/)
  assert.match(stateGuard, /serializeToggleQueueSnapshot\(/)
  assert.doesNotMatch(stateGuard, /graphToPrompt/)
})
