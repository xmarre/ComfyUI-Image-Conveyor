import { app } from '../../scripts/app.js'
import { api } from '../../scripts/api.js'
import {
  inputRequiredFromNodeDef,
  normalizeReferenceToggleMask,
  pruneDisabledOutputBranches
} from './image_conveyor_reference_toggles_math.mjs?v=20260817d'
import { disabledReferenceOutputIndexes } from './image_conveyor_reference_branch_pruning_math.mjs?v=20260817a'

const EXTENSION_NAME = 'Comfy.ImageConveyor.ReferenceBranchPruning'
const NODE_CLASSES = new Set(['ImageConveyor', 'SequentialBatchImageLoader'])
const OUTPUT_MODE_PERSISTENT = 'persistent_refs'
const REFERENCE_SLOT_COUNT = 8
const REFERENCE_OUTPUT_START_INDEX = 6
const REFERENCE_PROPERTY_KEY = 'image_conveyor_reference_enabled'
let graphToPromptPatched = false
let promptNodeDefsPromise = null

function getWidget(node, name) {
  return (node.widgets ?? []).find((entry) => entry?.name === name) ?? null
}

function currentMask(node) {
  return normalizeReferenceToggleMask(
    node?.properties?.[REFERENCE_PROPERTY_KEY],
    REFERENCE_SLOT_COUNT
  )
}

function outputMode(node) {
  const cached = node?.__bil?.state?.output_mode
  if (cached) return String(cached)
  const stateWidget = getWidget(node, 'state_json')
  if (typeof stateWidget?.value !== 'string') return ''
  try {
    return String(JSON.parse(stateWidget.value)?.output_mode ?? '')
  } catch {
    return ''
  }
}

function outputIndexByName(node, expectedName, fallback = -1) {
  const outputs = Array.isArray(node?.outputs) ? node.outputs : []
  const namedIndex = outputs.findIndex((output) => (
    String(output?.name ?? '') === expectedName || String(output?.label ?? '') === expectedName
  ))
  if (namedIndex >= 0) return namedIndex
  return fallback >= 0 && fallback < outputs.length ? fallback : -1
}

function referenceOutputIndex(node, slotIndex) {
  return outputIndexByName(
    node,
    `ref_image_${slotIndex + 1}`,
    REFERENCE_OUTPUT_START_INDEX + slotIndex
  )
}

async function getPromptNodeDefs() {
  if (!promptNodeDefsPromise) {
    promptNodeDefsPromise = Promise.resolve(api.getNodeDefs())
      .then((nodeDefs) => {
        if (!nodeDefs || typeof nodeDefs !== 'object' || Array.isArray(nodeDefs)) {
          throw new Error('ComfyUI returned an invalid /object_info node-definition payload')
        }
        return nodeDefs
      })
      .catch((error) => {
        promptNodeDefsPromise = null
        throw error
      })
  }
  return await promptNodeDefsPromise
}

function promptInputRequired(prompt, nodeDefs, nodeId, inputName) {
  const classType = String(prompt?.[String(nodeId)]?.class_type ?? '')
  const contract = inputRequiredFromNodeDef(nodeDefs?.[classType], inputName)
  return contract !== null ? contract : true
}

function disabledReferencePromptOutputs(graph) {
  const nodes = typeof graph?.computeExecutionOrder === 'function'
    ? graph.computeExecutionOrder(false)
    : (Array.isArray(graph?._nodes) ? graph._nodes : [])
  const disabled = []

  for (const node of nodes) {
    const type = String(node?.comfyClass || node?.type || '')
    if (!NODE_CLASSES.has(type) || outputMode(node) !== OUTPUT_MODE_PERSISTENT) continue

    const outputIndexes = Array.from(
      { length: REFERENCE_SLOT_COUNT },
      (_, slot) => referenceOutputIndex(node, slot)
    )
    const disabledIndexes = disabledReferenceOutputIndexes(currentMask(node), outputIndexes)
    if (disabledIndexes.length) {
      disabled.push({ nodeId: String(node.id), outputIndexes: disabledIndexes })
    }
  }

  return disabled
}

function installGraphToPromptFilter() {
  if (graphToPromptPatched || typeof app.graphToPrompt !== 'function') return
  graphToPromptPatched = true
  const previous = app.graphToPrompt

  app.graphToPrompt = async function (...args) {
    const graph = args[0] ?? this.rootGraph ?? app.graph
    const result = await previous.apply(this, args)
    const disabled = disabledReferencePromptOutputs(graph)

    if (disabled.length && result?.output && typeof result.output === 'object') {
      const nodeDefs = await getPromptNodeDefs()
      pruneDisabledOutputBranches(
        result.output,
        disabled,
        (nodeId, inputName) => promptInputRequired(result.output, nodeDefs, nodeId, inputName)
      )
    }

    return result
  }
}

app.registerExtension({
  name: EXTENSION_NAME,
  setup() {
    void getPromptNodeDefs().catch((error) => {
      console.warn('Image Conveyor: unable to pre-load ComfyUI node definitions.', error)
    })
    installGraphToPromptFilter()
  }
})
