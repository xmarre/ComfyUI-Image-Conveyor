# ComfyUI Image Conveyor

A sequential, visual image queue for ComfyUI with an integrated input-folder browser.

## What it does

Image Conveyor keeps a visible queue inside the graph and loads one image per prompt execution. The node starts with two permanent browser tabs:

- **Conveyor** is the ordered execution queue. Items retain their pending, queued, and processed states.
- **Input Folder** browses the current ComfyUI `input/` directory recursively and adds existing images to the queue without uploading, copying, renaming, or serializing the folder listing into the workflow.

Selected local folders can be opened as additional, removable tabs. Every tab uses the responsive, thumbnail-first gallery and remembers its own search, filter, sort, selection, keyboard focus, thumbnail size, and scroll position while the node is open.

## Browsing local folders as tabs

**Add folders** opens local folders as browser tabs without importing their images. You can also drag one or more folders onto the tab strip. Nested directories appear as folder cards; clicking one opens that directory in another tab.

Folder tabs compress automatically as the strip fills. Inactive removable tabs keep their close button while there is enough room; it disappears below the safe-width cutoff so a compressed tab remains easy to select. The active removable tab always keeps its close button. **Conveyor** and **Input Folder** cannot be closed.

The tab strip and main gallery are separate drop targets:

- dropping folders on the tab strip opens them for browsing;
- dropping the same folders elsewhere on the node keeps the established behavior and imports their supported images into the Conveyor recursively.

The directory picker requests multiple folders and accepts every top-level folder returned by the browser. Some Chromium/platform picker combinations allow only one directory per dialog; use **Add folders** again or multi-folder drag/drop in that case.

Local folder access is runtime-only. The folder contents and tabs are not serialized into the workflow and must be selected again after reloading the page. Closing the last tab belonging to a selected folder releases its browser file references and cached preview URLs. Adding a local image or selection to the Conveyor sends those files through the normal input upload and exact-deduplication pipeline.

## Adding images

Images can be added through:

- the **Add images** picker;
- image or folder drag/drop directly onto the node;
- recursive folder drag/drop with relative folders preserved;
- image paste while the node is focused or hovered;
- optional canvas-wide drop capture;
- **Add** / **Add selected** from the Input Folder tab;
- **Add** / **Add selected** from a local folder tab.

Picker, drop, paste, canvas-capture, and local-folder-tab additions import external files into ComfyUI input storage. Individual files are stored directly in the input root; dropped or selected folders preserve their own input-relative directory structure. The Input Folder path creates a queue reference to a file that already exists there.

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
- clickable nested-directory cards in local folder tabs;
- name/date sorting;
- direct click selection, Ctrl/Cmd toggling, Shift range selection, and contextual bulk actions;
- anchored drag-box selection from the gallery background or the gaps between cards, with edge auto-scroll;
- a larger full-resolution preview on double-click or Enter;
- arrow-key navigation, Home, End, PageUp, PageDown, Space selection, and Escape to close preview;
- **Jump to next pending**;
- drag reorder in unfiltered manual Conveyor order.

Search and filters change the browser presentation only. Applying a Conveyor sort retains the established behavior of changing the actual queue order.

## Performance behavior

- The gallery is virtualized by logical rows. Its live card count tracks the viewport plus a small overscan, rather than the total collection size.
- Only visible and near-visible cards request cached, bounded WebP thumbnails. Full-resolution images load only for explicit preview.
- Local folder tabs create browser object URLs lazily for visible cards, cap the URL cache, and defer new decodes during high-speed scrolling.
- Input Folder enumeration and the one-per-import-batch reconciliation use lightweight `os.scandir()` metadata in a worker thread and a short-lived snapshot cache.
- Opening and navigating a local folder tab performs no upload, content hashing, or server-side filesystem write.
- Tab changes, scrolling, searching, filtering, focus, and thumbnail-size changes do not serialize `state_json`.
- Input Folder and local-folder browsing datasets are runtime-only and never enlarge workflow JSON.
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

The Python suite covers duplicate resolution, stale metadata, canonical selection, managed duplicate cleanup and revalidation, concurrent uploads, index recovery, recursive listing, thumbnails, path containment, and queue compatibility. The JavaScript tests verify responsive gallery geometry, drag lifecycle behavior, fixed and removable tab state, directory-picker grouping, high-speed card reuse, and bounded virtualization for a 10,000-item collection.
