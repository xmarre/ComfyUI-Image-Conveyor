# ComfyUI Image Conveyor

A sequential, visual image queue for ComfyUI with an integrated input-folder browser.

<img width="673" height="1109" alt="2026-08-10 10_39_14-Bilder und 11 weitere Registerkarten – Explorer" src="https://github.com/user-attachments/assets/34cd4dd3-ae28-49c1-9472-cee8a7e5ea57" />

## What it does

Image Conveyor keeps a visible queue inside the graph and returns one ordered Conveyor image per prompt execution. New nodes use **Persistent references** mode: `image` advances through the Conveyor while the eight-slot **Reference Shelf** above the browser remains fixed and feeds `ref_image_1` through `ref_image_8`. The node starts with two permanent browser tabs:

- **Conveyor** is the ordered execution queue. Items retain their pending, queued, and processed states.
- **Input Folder** browses the current ComfyUI `input/` directory recursively and adds existing images to the queue without uploading, copying, renaming, or serializing the folder listing into the workflow.

Selected local folders can be opened as additional, removable tabs. Every tab uses the responsive, thumbnail-first gallery and remembers its own search, filter, sort, selection, keyboard focus, thumbnail size, and scroll position while the node is open.

## Reference Shelf

The otherwise unused canvas area above the Conveyor/Input Folder browser contains eight persistent reference slots. The shelf uses the live pre-widget geometry created by ComfyUI's output stack; it does not increase the node's minimum/default height, move the browser down, or reduce the gallery viewport.

- `image` is always the variable main Conveyor image.
- **Ref 1** through **Ref 8** map exactly to `ref_image_1` through `ref_image_8`.
- Empty slots produce the same inactive `IMAGE` output used by an unused multi-image output.
- References have no pending, queued, or processed state. They are never reserved or consumed and never affect `remaining_pending` or auto-queue counts.
- Left-drag a populated slot to reorder the shelf. Right-click any shelf or browser thumbnail for the shared image menu, including an original-file image preview, image properties, path copying, and context-specific actions. The preview scales down to fit the available screen while retaining the source image detail; use Left/Right Arrow to move through the populated shelf slots or the current browser view. The slot `×` clears only the assignment; it never deletes an image file or queue item.

Assign a reference by dragging an image card onto a slot:

- a Conveyor card is copied without changing its queue position or status;
- an Input Folder card references the existing ComfyUI input file directly;
- a local-folder card is imported through the exact-deduplicating resolver without entering the Conveyor;
- an external OS/file-manager image follows the same reference-only import path.

Shelf state is a fixed eight-entry, input-relative structure in the workflow. It contains no thumbnails, image bytes, hashes, folder listings, or arbitrary absolute paths. A populated slot whose file is missing fails validation with its slot number and annotated path instead of substituting another image.

## Character presets

The shelf header can save and switch global character presets. Each preset has a stable ID, a case-insensitively unique display name, and exactly eight image entries/nulls. **Save**, **New**, **Save as…**, **Rename**, **Duplicate**, and **Delete** are available from the compact shelf controls. A `*` marks local shelf changes relative to the active preset.

Presets are stored as a small versioned JSON document under the ComfyUI user directory using locked atomic replacement. Deleting a preset never deletes image files. Loading a preset copies its current eight slots into workflow state, so workflow execution remains deterministic if that global preset is later changed, renamed, deleted, or unavailable on another installation. The workflow's `reference_slots` are authoritative; the active preset ID is only an editing association.

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

Cleanup also relinks open Reference Shelves and saved character presets before removing a redundant file. Preset relinking is derived from the server-validated cleanup plan and written atomically while the candidate files are locked. If that durable write fails, the affected duplicate is not deleted.

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
- a shared right-click image menu with an original-file preview scaled to the available screen, concise properties, path copying, and context-specific actions;
- Left/Right Arrow navigation inside the preview, scoped to the populated Reference Shelf or the current filtered/sorted browser view;
- arrow-key navigation, Home, End, PageUp, PageDown, Space selection, and Escape to close preview;
- **Jump to next pending**;
- drag reorder in unfiltered manual Conveyor order.

Search and filters change the browser presentation only. Applying a Conveyor sort retains the established behavior of changing the actual queue order.

## Performance behavior

- The gallery is virtualized by logical rows. Its live card count tracks the viewport plus a small overscan, rather than the total collection size.
- Only visible and near-visible cards request cached, bounded WebP thumbnails. Original image files load only for explicit preview and are scaled down to the available screen when needed.
- Local folder tabs create browser object URLs lazily for visible cards, cap the URL cache, and defer new decodes during high-speed scrolling.
- Input Folder enumeration and the one-per-import-batch reconciliation use lightweight `os.scandir()` metadata in a worker thread and a short-lived snapshot cache.
- Opening and navigating a local folder tab performs no upload, content hashing, or server-side filesystem write.
- Tab changes, scrolling, searching, filtering, focus, and thumbnail-size changes do not serialize `state_json`.
- Input Folder and local-folder browsing datasets are runtime-only and never enlarge workflow JSON.
- Queue mutations still commit the compatible version-1 queue schema.
- Multi-image execution loads and hashes only the selected group, with a maximum of nine images. It does not scan image contents across the rest of the Conveyor.
- The Reference Shelf has a fixed cost of eight slots. It does not iterate the Conveyor or Input Folder, request presets during scroll/render frames, serialize on hover/pan/scroll, or load original image files for thumbnails.

The backend exposes input-only routes for recursive listing, exact upload resolution, managed duplicate cleanup, and thumbnails. Relative paths are containment-checked against ComfyUI's actual input directory; traversal, absolute paths, and symlink escapes are rejected.

## Queue behavior

Each Conveyor item has one of three states:

- `pending`
- `queued`
- `processed`

**Additional outputs** selects one of two modes.

### Persistent references

This is the default for newly created nodes. One main Conveyor item is reserved and selected per execution regardless of the stored `images_per_execution` value. Only that item participates in queue status, consumption, `remaining_pending`, and auto-queue arithmetic. `ref_image_1` through `ref_image_8` come from the fixed Reference Shelf.

### Queue execution group

This preserves the multi-image queue-group behavior introduced in v1.2. **Images per execution** controls the size of one ordered execution group:

- `1` is the default and retains the normal single-image queue behavior;
- `2` through `9` reserve that many distinct consecutive queue entries for one prompt execution;
- consuming mode advances by complete groups;
- **Don't consume** leaves the selected group reusable, so an unchanged queue returns the same ordered group again;
- an incomplete group fails validation instead of repeating an image or silently filling missing slots.

Queued prompt runs reserve complete pending groups in Conveyor order. The complete reservation is frozen into the queued prompt, so later live reordering does not change the reference order for that already-queued execution. Successful consuming execution marks every reserved member processed. If a prompt fails before the node executes, its members may remain queued; **Clear queued** releases those individual reservations.

For example, with `A B C D E F`, **Images per execution = 2**, and consuming enabled, three queued prompts reserve `A B`, `C D`, and `E F`. With **Don't consume** enabled, a queue `A B C D` and count `3` returns `A B C` again on the next unchanged execution.

Repeated logical queue entries remain valid. Two different Conveyor entries that both reference the same physical `same.png` file can occupy separate output slots because reservation identity follows the queue-entry IDs.

Available queue controls include:

- mark selected pending or processed;
- delete selected queue entries with the button or the standard `Delete` key (`Entf` on German keyboards);
- clear queued reservations;
- remove processed entries;
- apply queue sorting;
- set **Images per execution** from 1 through 9;
- enable **Auto queue all pending**;
- enable **Don't consume**;
- enable **Catch canvas drops**;
- preview and clean exact duplicates from the legacy managed input folder.

**Auto queue all pending** counts complete execution groups. If seven images are pending and the group size is three, two complete prompts can be queued and the seventh image remains pending until enough images exist for another complete group.

Deleting a Conveyor card removes the queue entry. The Input Folder tab is a non-destructive source picker and does not delete files.

## Image wiring

All image outputs are independent ComfyUI `IMAGE` values. Image Conveyor does not stack, resize, pad, or otherwise force selected references to a common geometry.

For a three-image execution group, wire:

```text
Image Conveyor.image    -> downstream image/reference input 1
Image Conveyor.ref_image_1  -> downstream image/reference input 2
Image Conveyor.ref_image_2  -> downstream image/reference input 3
```

In **Persistent references** mode, `image` is the selected main queue image and `ref_image_1` through `ref_image_8` are shelf slots 1 through 8. In **Queue execution group** mode, `image` is selected queue image #1 and those same additional sockets map to subsequent reserved entries. Outputs above the configured group count are inactive.

MiniMax H3 Ref2VA is one practical use case: connect `image` to `ref_image_0`, then connect Image Conveyor's `ref_image_1`, `ref_image_2`, and so on to the matching MiniMax inputs.

## Canvas-wide drop capture

Enable **Catch canvas drops** to route external image/folder drops from the graph canvas to a conveyor:

1. A drop directly on a Conveyor widget uses that node.
2. If exactly one enabled Conveyor is selected, it receives the canvas drop.
3. If the pointer is over an enabled Conveyor, that node receives it.
4. If exactly one Conveyor in the graph has capture enabled, it receives the drop.
5. With multiple ambiguous enabled nodes, ComfyUI's normal canvas handling remains active. Select the intended Conveyor first.

JSON and workflow drops are left to ComfyUI.

## Outputs

The node exposes these stable output slots:

| Slot | Output | Meaning |
| ---: | --- | --- |
| 0 | `image` | Selected image #1 |
| 1 | `mask` | Mask for selected image #1 |
| 2 | `path` | Annotated ComfyUI path for selected image #1 |
| 3 | `index` | Conveyor index for selected image #1 |
| 4 | `remaining_pending` | Pending queue entries remaining under the current consume mode |
| 5 | `source_path` | Best-effort source hint for selected image #1 |
| 6 | `ref_image_1` | Shelf Ref 1, or selected group image #2 |
| 7 | `ref_image_2` | Shelf Ref 2, or selected group image #3 |
| 8 | `ref_image_3` | Shelf Ref 3, or selected group image #4 |
| 9 | `ref_image_4` | Shelf Ref 4, or selected group image #5 |
| 10 | `ref_image_5` | Shelf Ref 5, or selected group image #6 |
| 11 | `ref_image_6` | Shelf Ref 6, or selected group image #7 |
| 12 | `ref_image_7` | Shelf Ref 7, or selected group image #8 |
| 13 | `ref_image_8` | Shelf Ref 8, or selected group image #9 |

`path` is the annotated ComfyUI input path actually loaded. `source_path` is an optional best-effort source hint. Absolute native paths are reduced to filename-only before persistence so exported workflows do not leak arbitrary local paths.

## Compatibility

After updating from a build without the Reference Shelf or with the older `image_2` … `image_9` socket labels, reload the ComfyUI frontend and recreate existing Image Conveyor nodes so ComfyUI rebuilds their frontend widget and output schema. Save or note the old node's queue before replacing it; recreating a node does not transfer its embedded Conveyor state automatically.

The original six output slots remain at indices `0` through `5` in their existing order. The eight additional `IMAGE` outputs are appended at indices `6` through `13`, so saved links to the original outputs keep their indices.

The node keeps the existing `ImageConveyor` class, the legacy `SequentialBatchImageLoader` alias, legacy single-item queue reservation shape, and legacy singular execution-delta fields. State version 2 adds `output_mode`, a fixed `reference_slots` array, and the optional active preset association.

Migration is deterministic for released workflows that have no `output_mode` field:

- `images_per_execution > 1` becomes **Queue execution group**, preserving existing grouped reservations, output mapping, Don't consume behavior, and auto-queue arithmetic;
- `images_per_execution == 1` becomes **Persistent references** with eight empty slots, which is externally identical because every additional image output was already inactive.

The original six output indices and all eight additional output indices remain unchanged.

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
node --test tests/test_queue_groups.mjs
node --test tests/test_reference_shelf.mjs
node --check web/image_conveyor.js
node --check web/image_conveyor_math.mjs
python -m py_compile __init__.py image_conveyor.py image_conveyor_server.py
git diff --check
```

The Python suite covers queue/group compatibility, persistent-reference selection and output mapping, cache identity, preset CRUD and atomic persistence, preset path validation, duplicate-cleanup relinking, reservation strictness, duplicate resolution, stale metadata, canonical selection, concurrent uploads, index recovery, recursive listing, thumbnails, and path containment. The JavaScript tests additionally cover output-mode migration, fixed slot normalization, reference-only assignment, preset snapshot/dirty behavior, shelf hit geometry, drag-source classification, scrollbar preservation, gallery behavior, and bounded virtualization for a 10,000-item collection.
