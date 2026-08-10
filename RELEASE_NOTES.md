# Image Conveyor v1.1.0

This release turns Image Conveyor into a scalable image-library workflow while preserving the existing conveyor queue and saved-workflow behavior.

## Input Folder library

- Adds a dedicated **Input Folder** tab alongside the existing **Conveyor** tab.
- Browses the current ComfyUI input directory directly from the node.
- Adds runtime-only local folder tabs, nested folder navigation, and multi-folder drag/drop.
- Keeps browser state such as search, sort, selection, focus, thumbnail size, and scroll position isolated per tab.

## Large-library gallery

- Replaces the full image list with a responsive virtualized thumbnail gallery designed for thousands of items.
- Keeps only the visible cards plus overscan in the DOM.
- Makes thumbnails the primary interaction surface while retaining preview, drag/drop, reordering, clipboard, folder, and canvas-capture actions.
- Adds click, Ctrl/Cmd, Shift-range, marquee, keyboard, and bulk selection workflows.
- Preserves tab scroll/focus state while navigating elsewhere in ComfyUI.
- Fixes marquee selection origin/offset behavior and improves insertion highlighting when dragging between or beside thumbnails.

## Exact duplicate handling

- Adds streamed SHA-256 duplicate detection backed by a lazy SQLite index.
- Reuses an existing input file when imported bytes are identical, including files with different names or requested subfolders.
- Uses atomic, collision-safe writes and serializes conflicting uploads.
- Refreshes metadata per import batch so newly added files are immediately eligible for reuse.
- Adds cleanup support for exact duplicates left in the legacy `input/image_conveyor/` managed folder.

## Reliability and compatibility

- Keeps scans, hashing, image decoding, SQLite work, and thumbnail generation off the server event loop.
- Adds bounded, invalidation-aware WebP thumbnails without storing thumbnail data in workflows.
- Hardens path handling against traversal, absolute paths, unsupported extensions, and symlink escapes.
- Preserves the existing queue schema, node outputs, aliases, reservation lifecycle, processed-item behavior, and saved workflows.
- Keeps ComfyUI native shortcuts authoritative while preserving scoped Conveyor keyboard controls and user key remaps.
- Fixes concurrent-import button state, SQLite connection lifetime, thumbnail decode error classification, and preview focus behavior.

## Validation

- `python -m unittest discover -s tests -v`: 40 passed
- `node --test tests/test_gallery_math.mjs`: 20 passed
- `node --check web/image_conveyor.js`: passed
- `node --check web/image_conveyor_math.mjs`: passed
- `python -m py_compile __init__.py image_conveyor.py image_conveyor_server.py`: passed
- `git diff --check`: passed
- Manual testing in a current ComfyUI frontend confirmed the updated workflow, including the final scrollbar, marquee-selection, drag/drop, and keyboard-routing fixes.
