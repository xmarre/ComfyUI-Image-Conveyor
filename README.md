# ComfyUI Image Conveyor

A sequential drag-and-drop image queue node for ComfyUI.

## What it does

- Drag and drop any number of images into the node
- Shows the queued images directly in the node UI with thumbnails
- Processes one image per prompt execution in queue order
- If you queue 4 prompt runs, the next 4 pending images are reserved and then processed sequentially
- Marks processed images automatically when the loader node executes successfully
- Lets you manually reset items to pending, force them to processed, delete them, reorder them, and sort them

## Frontend integration

This package is **VueNodes-compatible** with the ComfyUI frontend.

Implementation detail:
- it uses the frontend's supported **custom widget + DOMWidget** path
- in VueNodes mode, the frontend renders that widget through its Vue-side `WidgetDOM` bridge

So this is not a compiled custom `.vue` SFC shipped from the extension, but it is wired into the supported VueNodes rendering path rather than using an ad-hoc nodeCreated-only canvas hack.

## Features

- compatibility alias for old saved workflows (`SequentialBatchImageLoader` still resolves)
- multi-image upload from click or drag/drop
- thumbnail list in-node
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
- outputs:
  - `image`
  - `mask`
  - `path`
  - `index`
  - `remaining_pending`

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.

## Notes

- Uploaded files are stored under `input/image_conveyor/`.
- Deleting an item from the node does **not** delete the file from disk.
- If a prompt reserves an image but fails before this loader node executes, that item can remain `queued`. Use **Clear queued** to release those reservations.
- Empty MIME drag/drop is handled by extension fallback, so common image extensions still upload correctly.
