# ComfyUI Image Conveyor

A visual, sequential image queue for ComfyUI with an integrated input-folder browser, persistent reference shelf, character presets, and queue-aware image outputs.

<img width="709" height="1210" alt="Screenshot 2026-08-12 132520" src="https://github.com/user-attachments/assets/39f3827f-a12e-4392-b55e-f49b8317ec13" />

## What it does

Image Conveyor keeps a visible image queue directly inside the workflow. It can be used as both an execution queue and an image browser/library without serializing large folder listings into the workflow.

New nodes default to **Persistent references** mode:

- **Conveyor** is the ordered queue of pending / queued / processed images.
- **Input Folder** browses the current ComfyUI `input/` directory recursively.
- Up to eight persistent images can live in the **Reference Shelf** and feed `ref_image_1` through `ref_image_8`.
- `image` is the main queue-driven output.
- `last_frame` is a second independent queue-driven output for workflows that need a dedicated last frame.
- Main, Last Frame, and every reference output can be enabled or disabled independently without deleting their saved wires or assignments.

Additional local folders can be opened as removable browser tabs. The gallery is virtualized and designed to remain responsive with very large collections.

## Reference Shelf

The shelf contains eight persistent reference slots above the browser.

- **Ref 1** through **Ref 8** map exactly to `ref_image_1` through `ref_image_8`.
- References are not queue items. They have no pending/queued/processed state and are never consumed.
- Empty reference slots remain inactive (`None`).
- Only populated slots whose matching output is both **connected and enabled** are validated, hashed, and decoded for a queued prompt.
- You can safely leave eight reference outputs connected while only some shelf slots are populated.
- Drag populated shelf slots to reorder them.
- Drag Conveyor cards, Input Folder cards, local-folder cards, or external images directly onto shelf slots.
- Right-click shelf/browser images for preview, image properties, path copying, and context-specific actions.
- Left/Right Arrow navigates through populated shelf slots or the current filtered/sorted browser view while preview is open.

Reference assignments are stored in workflow state as input-relative paths. Thumbnail data, image bytes, folder listings, and arbitrary absolute paths are not serialized into the workflow.

## Character presets

The Reference Shelf supports global named character presets with exactly eight reference slots each.

Available actions include **New**, **Save**, **Save as…**, **Rename**, **Duplicate**, and **Delete**.

### Immediate loading

Selecting a character preset loads its saved Reference Shelf immediately. You do not need to select it and then press **Load** separately.

### Live generation state

Reference Shelf changes are live node state. The next queued generation reads the current `state_json.reference_slots` directly; it does **not** read the saved preset record at execution time.

That means:

1. select a character preset;
2. replace/reorder/clear one or more reference slots;
3. queue a generation;
4. the generation uses those newly changed slots immediately.

You do **not** need to press Save before queueing.

### Autosave

When a named preset is active, changes to its Reference Shelf now autosave automatically.

- adding/replacing a slot autosaves;
- clearing a slot autosaves;
- reordering slots autosaves;
- legitimate path relinking autosaves;
- rapid edits are serialized/coalesced so older writes cannot finish after newer ones;
- switching presets does not itself become a write;
- queue-state changes, redraws, workflow loading, and unrelated node-state changes do not trigger autosave;
- generation never waits for autosave because execution already uses the live slot state.

The manual **Save** action remains available as a fallback and is still needed to create/name a preset when no named preset is active.

### Character files and shared references

Character references use stable canonical files. If an image already belongs to a managed character folder, another preset can reference that same canonical file without physically moving it back and forth between character folders.

Whole-character-library migration is not run automatically during node installation, rendering, preset switching, queue transitions, or ordinary Refresh. Physical materialization remains limited to explicit user actions that actually require it.

## Output controls

Compact switches can enable/disable:

- main `image`;
- `last_frame`;
- `ref_image_1` through `ref_image_8`.

Disabled outputs keep their editor wires and saved state. Image Conveyor only alters the serialized API prompt for that queued execution.

When disabling a queue-driven image branch, downstream nodes whose **required** inputs can no longer be satisfied are pruned recursively from the submitted API prompt. Propagation stops at optional/unknown boundaries, so optional conditioning inputs such as H3 `first_frame` can disappear while independent enabled reference branches remain intact.

The visible workflow graph is never rewritten by this pruning.

## Queue behavior

Each Conveyor item has one of three states:

- `pending`
- `queued`
- `processed`

**Additional outputs** selects one of two execution modes.

### Persistent references

This is the default for newly created nodes.

Queue consumption is determined by the queue-driven outputs that are both **connected and enabled**:

- `image` only: one queue image is reserved/consumed;
- `last_frame` only: one queue image is reserved/consumed and main-image metadata remains neutral;
- `image` + `last_frame`: two ordered queue images are reserved/consumed (`image` first, `last_frame` second);
- neither queue-driven output active: zero Conveyor images are required, allowing reference-only execution.

Reference outputs come from the fixed Reference Shelf and do not affect queue counts.

Queue-role and reference-output topology is frozen into each queued prompt. Later live UI changes therefore cannot silently reinterpret an already-reserved prompt.

### Queue execution group

This preserves the multi-image group behavior.

**Images per execution** can be set from `1` through `9`:

- each prompt reserves that many consecutive queue entries;
- consuming mode advances by complete groups;
- **Don't consume** leaves the selected group reusable;
- incomplete groups fail validation instead of repeating/filling images;
- already queued reservations remain frozen even if the live Conveyor is reordered later.

In queue-group mode, `image` is queue image #1, `ref_image_1` onward expose subsequent grouped images, and `last_frame` is an additional alias of grouped image #2 when present.

### Queue controls

The node also supports:

- **Auto queue all pending**;
- **Don't consume**;
- **Catch canvas drops**;
- move selected images to the front of the unreserved pending queue;
- mark pending / processed;
- clear queued reservations;
- remove processed entries;
- manual reordering and queue sorting;
- Delete/Entf for selected Conveyor items;
- **Jump to next pending**.

## Browsing and adding images

Images can be added through:

- **Add images**;
- image/folder drag-and-drop directly onto the node;
- recursive folder drag-and-drop;
- image paste while the node is focused/hovered;
- optional canvas-wide drop capture;
- **Add** / **Add selected** from Input Folder;
- **Add** / **Add selected** from local folder tabs.

**Add folders** opens local folders as browser tabs without importing their contents. Nested directories appear as folder cards and can be opened in their own tabs.

Local-folder tabs are runtime-only and are not serialized into workflow JSON.

## Gallery and large-list navigation

The thumbnail-first gallery provides:

- responsive Small / Medium / Large thumbnails;
- virtualization by logical rows;
- filename/path search;
- queue status filters;
- recursive Input Folder filtering;
- name/date sorting;
- click, Ctrl/Cmd, Shift-range, and drag-box selection;
- edge autoscroll while selecting/dragging;
- mouse-wheel scrolling while dragging selected images;
- middle-click gallery autoscroll with a visible anchor;
- keyboard navigation with arrows, Home, End, PageUp, PageDown, Space, Enter, and Escape;
- original-image preview with Left/Right navigation;
- per-view scroll memory.

Input Folder and local-folder browsing datasets stay runtime-only, so even very large collections do not inflate workflow JSON.

## Exact duplicate resolution

External imports are resolved by exact file contents using SHA-256.

- byte-identical files reuse one physical canonical file;
- same-size but different-byte files remain separate;
- re-encoded/similar images remain separate;
- repeated logical queue entries may intentionally reference the same physical file.

A persistent SQLite cache under ComfyUI's user cache directory stores file metadata/digests so large input folders do not need to be rehashed on every operation.

**Clean exact duplicates** can remove redundant files under the legacy `input/image_conveyor/` folder after preview/confirmation. Queued files are protected, live references/presets are relinked before deletion, files are revalidated before removal, and changed files are skipped.

## Performance behavior

- Only visible/near-visible cards exist in the live virtualized gallery window.
- Thumbnails use bounded cached WebP previews; original files load only for explicit preview/execution.
- High-speed scrolling defers unnecessary thumbnail decodes.
- Input enumeration uses lightweight filesystem metadata in a worker thread.
- Opening/navigating a local folder tab performs no server upload or content hashing.
- Scrolling, searching, filtering, tab changes, and thumbnail-size changes do not serialize workflow state.
- Persistent-reference execution hashes/loads only active connected references and the queue roles required by that prompt.

## Outputs

Output indices are stable and backward-compatible:

| Slot | Output | Meaning |
| ---: | --- | --- |
| 0 | `image` | Main queue-driven image (when connected + enabled) |
| 1 | `mask` | Mask for the main `image` |
| 2 | `path` | Annotated path for the main `image` |
| 3 | `index` | Conveyor index for the main `image` |
| 4 | `remaining_pending` | Pending queue entries remaining under current consume mode |
| 5 | `source_path` | Best-effort source hint for the main `image` |
| 6 | `ref_image_1` | Shelf Ref 1 / queue-group image #2 |
| 7 | `ref_image_2` | Shelf Ref 2 / queue-group image #3 |
| 8 | `ref_image_3` | Shelf Ref 3 / queue-group image #4 |
| 9 | `ref_image_4` | Shelf Ref 4 / queue-group image #5 |
| 10 | `ref_image_5` | Shelf Ref 5 / queue-group image #6 |
| 11 | `ref_image_6` | Shelf Ref 6 / queue-group image #7 |
| 12 | `ref_image_7` | Shelf Ref 7 / queue-group image #8 |
| 13 | `ref_image_8` | Shelf Ref 8 / queue-group image #9 |
| 14 | `last_frame` | Dedicated queue-driven Last Frame output / queue-group image #2 alias |

`last_frame` was appended at slot 14, so all previously existing output indices remain unchanged.

## MiniMax H3 examples

For Ref2VA-style usage, connect:

```text
Image Conveyor.image       -> H3 ref_image_0
Image Conveyor.ref_image_1 -> H3 ref_image_1
Image Conveyor.ref_image_2 -> H3 ref_image_2
...
```

For First/Last Frame workflows, connect the dedicated `last_frame` output to the consumer's `last_frame` input instead of repurposing a Reference Shelf output.

Output switches make it possible to run reference-only, first-frame-only, last-frame-only, or combined workflows while retaining the same visible workflow wiring.

## Compatibility / upgrades

The original output indices remain stable. `last_frame` is append-only at slot 14, and current frontend migration adds it to older saved Image Conveyor nodes without renumbering existing sockets.

After updating, restart ComfyUI and hard-refresh/reload the frontend so both Python backend and browser extension code are current.

The node keeps the `ImageConveyor` class and legacy `SequentialBatchImageLoader` alias.

## Install

### ComfyUI Manager

Search for **ComfyUI Image Conveyor** in ComfyUI Manager, install/update it, restart ComfyUI, and reload the frontend.

### Manual

Clone or extract the repository into:

```text
ComfyUI/custom_nodes/ComfyUI-Image-Conveyor
```

Then restart ComfyUI and reload the frontend.
