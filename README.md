# ComfyUI Image Conveyor

A sequential drag-and-drop image queue node for ComfyUI.

<img width="538" height="728" alt="image" src="https://github.com/user-attachments/assets/5dc146c5-1971-493f-8311-12d93b867a05" />

## What it does

- Drag and drop any number of images into the node
- Drag and drop folders onto the node to enqueue supported images recursively
- Shows the queued images directly in the node UI with thumbnails
- Processes one image per prompt execution in queue order
- If you queue multiple prompt runs, the next pending items are reserved and then processed sequentially
- Optional **Auto queue all pending** mode can expand a single queue action into one queued prompt per pending image
- Marks processed items automatically when the loader node executes successfully
- Lets you manually reset items to pending, force them to processed, delete them, reorder them, and sort them

## Why this exists

This node is for **sequential in-graph image queueing**.

The main use case is dropping in a set of images, keeping the queue visible directly on the node, and consuming them **one prompt execution at a time** without relying on an external folder iterator workflow.

Existing batch image loaders generally solve a different problem. Many are oriented around folder iteration, one-shot batch loading, or less explicit queue state. Image Conveyor is meant to give you a **visible in-graph queue**, **clear item state**, **manual intervention when needed**, and **predictable sequential consumption across queued prompt runs**.

## Queue / state behavior

Each item has a status:

- `pending`
- `queued`
- `processed`

This makes it easy to distinguish between items that are still waiting, items already reserved by queued prompt runs, and items that are done.

If a prompt reserves an image but fails before the loader node executes, that item can remain `queued`. There is a **Clear queued** action to release those reservations.

## Frontend integration

This package is **VueNodes-compatible** with the ComfyUI frontend.

Implementation detail:

- it uses the frontend's supported **custom widget + DOMWidget** path
- in VueNodes mode, the frontend renders that widget through its Vue-side `WidgetDOM` bridge

So this is not a compiled custom `.vue` SFC shipped by the extension, and not a brittle ad-hoc canvas-only hack. It is wired into the supported frontend rendering path.

## Features

- click to add images, or drag/drop images and folders
- thumbnail list directly in-node
- per-item status: `pending`, `queued`, `processed`
- per-item quick actions: pending, done, delete
- bulk actions:
  - select all / clear selection
  - set selected pending
  - set selected processed
  - delete selected
  - clear queued
  - remove processed
- manual drag-and-drop reorder
- sorting:
  - manual order
  - name ascending / descending
  - newest / oldest
  - status
- optional **Auto queue all pending** toggle in the node UI

## Outputs

The node exposes:

- `image`
- `mask`
- `path`
- `index`
- `remaining_pending`
- `source_path`

So it can be used both as a simple sequential loader and as part of queue-driven workflows that need metadata and queue state.

`path` is the ComfyUI-side annotated input path that the node actually loads.
`source_path` is an optional best-effort hint for the original dropped path when the runtime exposes one
(for example a folder-relative path during directory drops, or a native path in runtimes that explicitly provide it).

## Installation

### Option 1: ComfyUI-Manager

Install **ComfyUI Image Conveyor** through **ComfyUI-Manager**, then restart ComfyUI.

### Option 2: Manual install

Clone this repository into `ComfyUI/custom_nodes/`:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/xmarre/ComfyUI-Image-Conveyor.git
