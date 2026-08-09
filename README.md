# ComfyUI Image Conveyor

A sequential, visual image queue for ComfyUI with an integrated input-folder browser.

## What it does

Image Conveyor keeps a visible queue inside the graph and loads one image per prompt execution. The node has two independent browser tabs:

- **Conveyor** is the ordered execution queue. Items retain their pending, queued, and processed states.
- **Input Folder** browses the current ComfyUI `input/` directory recursively and adds existing images to the queue without uploading, copying, renaming, or serializing the folder listing into the workflow.

Both tabs use a responsive, thumbnail-first gallery. Each tab remembers its own search, filter, sort, selection, keyboard focus, thumbnail size, and scroll position while the node is open.

## Adding images

Images can be added through:

- the **Add images** picker;
- image or folder drag/drop directly onto the node;
- recursive folder drag/drop with relative folders preserved;
- image paste while the node is focused or hovered;
- optional canvas-wide drop capture;
- **Add** / **Add selected** from the Input Folder tab.

The first four paths import an external file into ComfyUI input storage. Individual files are stored directly in the input root; dropped folders preserve their own input-relative directory structure. The Input Folder path creates a queue reference to a file that already exists there.

## Exact duplicate resolution

External imports are resolved by exact file contents using SHA-256:

- byte-identical files reuse one existing physical file even when their incoming names or source folders differ;
- files with the same size and different bytes remain separate;
- re-encoded or merely similar images remain separate;
- existing duplicates are reused without creating another file;
- repeated queue entries may intentionally reference the same physical input file.

Canonical selection is deterministic: an identical intended target is preferred, followed by an ordinary input path and then a legacy path under `input/image_conveyor/`, with stable relative-path ordering inside each category. New imports no longer create the `image_conveyor` subfolder. Existing unique files there remain valid and are not moved automatically.

The resolver keeps a persistent SQLite cache under ComfyUI's user cache directory. Input listing records path, size, and modification time without decoding or hashing image contents. Each import batch performs one fresh metadata reconciliation, then each incoming file is streamed and hashed once; only same-size existing candidates whose cached digest is missing or stale are hashed. Simultaneous identical imports are serialized by digest so they produce one physical file.

**Clean exact duplicates** is available under **Queue options and bulk tools**. It previews byte-identical redundant files under the legacy `input/image_conveyor/` folder, shows the retained path and reclaimable size, and requires confirmation before deletion. Queued Conveyor paths are protected, open-node references are changed to the retained file before deletion, and the server hashes both sides again immediately before each deletion. Files changed since the preview are skipped; unique files and duplicates outside the legacy folder remain untouched; empty legacy directories are pruned. Run cleanup with no generation active. A saved workflow that is not open can still contain a deleted legacy path; the confirmation calls out that limitation explicitly.

## Gallery and large-list navigation

The main browser provides:

- responsive columns and Small / Medium / Large thumbnails;
- filename/path search;
- pending, queued, and processed Conveyor filters;
- recursive folder filtering in Input Folder;
- name/date sorting;
- visible multi-selection and contextual bulk actions;
- a larger full-resolution preview on double-click or Enter;
- arrow-key navigation, Home, End, PageUp, PageDown, Space selection, and Escape to close preview;
- **Jump to next pending**;
- drag reorder in unfiltered manual Conveyor order.

Search and filters change the browser presentation only. Applying a Conveyor sort retains the established behavior of changing the actual queue order.

## Performance behavior

- The gallery is virtualized by logical rows. Its live card count tracks the viewport plus a small overscan, rather than the total collection size.
- Only visible and near-visible cards request cached, bounded WebP thumbnails. Full-resolution images load only for explicit preview.
- Input Folder enumeration and the one-per-import-batch reconciliation use lightweight `os.scandir()` metadata in a worker thread and a short-lived snapshot cache.
- Folder browsing performs no content hashing and no filesystem writes.
- Tab changes, scrolling, searching, filtering, focus, and thumbnail-size changes do not serialize `state_json`.
- The Input Folder dataset is runtime-only and never enlarges workflow JSON.
- Queue mutations still commit the compatible version-1 queue schema.

The backend exposes input-only routes for recursive listing, exact upload resolution, managed duplicate cleanup, and thumbnails. Relative paths are containment-checked against ComfyUI's actual input directory; traversal, absolute paths, and symlink escapes are rejected.

## Queue behavior

Each Conveyor item has one of three states:

- `pending`
- `queued`
- `processed`

Queued prompt runs reserve pending items in order. Successful execution marks the selected item processed. If a prompt fails before the node executes, its item may remain queued; **Clear queued** releases those reservations.

Available queue controls include:

- mark selected pending or processed;
- delete selected queue entries;
- clear queued reservations;
- remove processed entries;
- apply queue sorting;
- enable **Auto queue all pending**;
- enable **Don't consume**;
- enable **Catch canvas drops**;
- preview and clean exact duplicates from the legacy managed input folder.

Deleting a Conveyor card removes the queue entry. The Input Folder tab is a non-destructive source picker and does not delete files.

## Canvas-wide drop capture

Enable **Catch canvas drops** to route external image/folder drops from the graph canvas to a conveyor:

1. A drop directly on a Conveyor widget uses that node.
2. If exactly one enabled Conveyor is selected, it receives the canvas drop.
3. If the pointer is over an enabled Conveyor, that node receives it.
4. If exactly one Conveyor in the graph has capture enabled, it receives the drop.
5. With multiple ambiguous enabled nodes, ComfyUI's normal canvas handling remains active. Select the intended Conveyor first.

JSON and workflow drops are left to ComfyUI.

## Outputs

The node exposes:

- `image`
- `mask`
- `path`
- `index`
- `remaining_pending`
- `source_path`

`path` is the annotated ComfyUI input path actually loaded. `source_path` is an optional best-effort source hint. Absolute native paths are reduced to filename-only before persistence so exported workflows do not leak arbitrary local paths.

## Compatibility

The node keeps the existing `ImageConveyor` class, the legacy `SequentialBatchImageLoader` alias, outputs, queue item shape, version-1 state normalization, and prompt reservation/execution delta behavior. Existing workflows load without recreating the node.

The frontend uses ComfyUI's custom widget + DOMWidget integration and remains VueNodes-compatible.

## Installation

### ComfyUI-Manager

Install **ComfyUI Image Conveyor** through ComfyUI-Manager, then restart ComfyUI.

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/xmarre/ComfyUI-Image-Conveyor.git
```

Restart ComfyUI after installation or update.

## Development checks

```bash
python -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/test_gallery_math.mjs
node --check web/image_conveyor.js
```

The Python suite covers duplicate resolution, stale metadata, canonical selection, managed duplicate cleanup and revalidation, concurrent uploads, index recovery, recursive listing, thumbnails, path containment, and queue compatibility. The JavaScript tests verify responsive gallery geometry, drag lifecycle behavior, tab scroll restoration, high-speed card reuse, and bounded virtualization for a 10,000-item collection.
