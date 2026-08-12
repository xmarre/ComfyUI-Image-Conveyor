# Image Conveyor v1.4.1

This patch release fixes multi-selection handling for the image-library context menu.

## Fix

- Right-clicking a selected image and choosing **Add to Conveyor** now adds the complete active selection instead of only the card that opened the menu.
- Right-clicking an image that is not part of the active selection remains scoped to that one image.
- Single-selection behavior is unchanged.
- The context-menu action now reuses the existing canonical bulk-add path, preserving Input Folder references, local-folder imports, ordering, deduplication, and queue mutation behavior.

## Validation

- Complete GitHub Actions suite passes on the PR head: Python tests, frontend pure-function tests, JavaScript syntax checks, Python compilation, and whitespace validation.
- Live ComfyUI testing confirmed multi-select → right-click → **Add to Conveyor** adds the full selected set correctly.
