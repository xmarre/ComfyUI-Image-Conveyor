# Image Conveyor v1.3.0

Adds a persistent eight-slot reference workflow and reusable character presets while preserving the existing Conveyor and queue-group behavior.

## Persistent Reference Shelf

- Adds eight fixed reference slots above the browser, exposed as `ref_image_1` through `ref_image_8`.
- Keeps `image` as the advancing main Conveyor image.
- In **Persistent references** mode, exactly one Conveyor item is reserved and consumed per execution regardless of the stored **Images per execution** value.
- Snapshots the connected reference outputs when a prompt is queued and loads only connected, populated slots.
- Keeps connected empty slots inactive (`None`) without shifting references, so all nine image connections remain safe with a partially populated shelf.
- Supports drag/drop assignment from Conveyor, Input Folder, local-folder tabs, and the operating system without adding reference-only imports to the queue.
- Supports left-drag insertion sorting across populated and sparse shelf slots.

## Character presets and safety

- Adds global character presets with New, Load, Save, Save as, Rename, Duplicate, and Delete operations.
- Stores presets as locked, atomically replaced JSON under the ComfyUI user directory.
- Keeps detached workflow snapshots authoritative, allowing workflows to survive renamed, changed, missing, or deleted global presets.
- Restricts reference paths to supported images inside the ComfyUI input directory.
- Relinks open shelves and saved presets during exact-duplicate cleanup before removing redundant files.
- Preserves files on transient preset-store I/O failures and quarantines malformed preset data safely.

## Image browsing and interaction

- Adds one shared right-click image menu to the Reference Shelf, Conveyor, Input Folder, and local-folder tabs.
- Adds a screen-fitted original-file preview with concise image properties, path copying, and context-specific actions.
- Adds Left/Right Arrow navigation through the populated shelf or the current filtered and sorted browser view.
- Keeps preview navigation independent from queue selection, consumption, ordering, and scrolling.
- Restores native ComfyUI shortcuts after ComfyUI-Manager closes, including the Manager registry-search lifecycle.
- Version-locks the frontend helper-module import to prevent mixed cached JavaScript versions from disabling the node UI.

## Compatibility

- Queue execution group mode retains the v1.2 behavior for ordered groups of 1 through 9 images.
- Existing output indices 0 through 13 are unchanged. The original six outputs remain in slots 0 through 5.
- State schema version 2 migrates legacy single-image nodes to Persistent references and multi-image nodes to Queue execution group deterministically.
- `ImageConveyor` and the legacy `SequentialBatchImageLoader` alias remain available.
- After updating from v1.2 or an earlier PR build, reload the frontend and recreate existing Image Conveyor nodes so ComfyUI rebuilds the new output labels and widget layout. Preserve the old node's embedded queue before replacing it.

## Validation

- 90 Python tests pass.
- 28 gallery and shortcut JavaScript tests pass.
- 20 queue-group JavaScript tests pass.
- 17 Reference Shelf JavaScript tests pass.
- JavaScript syntax checks, Python compilation, cache-version checks, and whitespace checks pass.
- Live ComfyUI testing confirmed the shelf, presets, image menus, preview navigation, restored shortcuts, and a nine-connection workflow with five populated references.
