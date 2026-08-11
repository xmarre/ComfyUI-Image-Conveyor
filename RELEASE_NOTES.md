# Image Conveyor v1.4.0

This release turns the Input Folder and persistent reference shelf into a managed image library with real folder operations, batch drag/drop, and canonical per-character storage.

## Managed Input Folder

- Adds hierarchical Input Folder browsing with real folder cards and folder tabs while retaining the flat all-images view.
- Adds physical move and delete operations for selected Input files, with queued files protected from destructive changes.
- Supports dragging selected images into folders, folder tabs, or the Conveyor; multi-selection drag preserves the full selection even outside the virtualized card window.
- Supports hover-opening folder tabs during a drag and dropping directly into the newly opened folder.
- Preserves the active folder and scroll position after move, drop, refresh, and gallery rerender operations.
- Fixes stale folder views after filesystem moves and prevents scrollbar interaction from accidentally marquee-selecting the far-right column.

## Character libraries and canonical files

- Gives every saved character a stable physical folder under `input/image_conveyor_characters/`.
- Makes the character folder the physical source of truth for that character's images; the eight reference slots are the active visible subset of the same library.
- Assigning an existing Input or Conveyor image to an active character relocates the canonical file into that character folder instead of creating another physical copy.
- Reuses a byte-identical file already present in the character folder and removes the redundant source copy.
- Preserves different-content filename collisions with collision-safe naming.
- Relinks open Conveyor items, reference slots, UI source paths, saved presets, and character membership whenever a canonical path changes.
- Automatically migrates character presets and reference slots created by earlier builds into their character folders and collapses legacy byte-identical copies.
- Defers migration of queued files until they are safe to move.

## Drag/drop and reference workflow

- Multi-image Conveyor reordering now moves the selected images as one ordered block.
- Selected Input, folder, and Conveyor images can be moved between managed folders with Conveyor entries kept and relinked.
- Reference-shelf images can be dragged back into the Conveyor and hydrate immediately without requiring a manual refresh or tab switch.
- Reference assignment and character materialization use queued-path protection consistently rather than depending on frontend extension install order.
- Same-batch identical sources collapse onto one canonical destination instead of creating suffixed duplicates.

## Reliability and performance

- Uses one backend owner for the drag/materialization routes, eliminating route-order-dependent behavior.
- Missing files are handled as per-item skips so one disappearing source does not invalidate an otherwise successful batch.
- Relocation synchronization is serialized by generation so later callers cannot receive a stale in-flight snapshot.
- Character migration is no longer triggered by transient queue-status changes during normal canvas rendering.
- Destination and migration duplicate matching use indexed metadata/content hashes to avoid repeated full-file comparisons on large libraries.
- Destination paths are validated before scanning, including symlinked directory components.
- Multi-file uploads perform one authoritative Input snapshot refresh per batch instead of repeatedly rescanning large Input folders.
- Removes synthetic re-entrant `dragend` dispatch from intercepted native drops, reducing the most suspicious PR-specific path related to the reported Chrome `STATUS_ACCESS_VIOLATION` renderer crash.

## Validation

- Complete GitHub Actions suite passes: Python tests, frontend pure-function tests, JavaScript syntax checks, Python compilation, and whitespace validation.
- Live ComfyUI testing confirmed group drag/drop, physical folder moves, character-folder ownership/migration behavior, folder refresh and scroll preservation, and reference-shelf to Conveyor hydration.
