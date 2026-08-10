# Image Conveyor v1.2.0

Adds deterministic multi-image execution groups while preserving the existing single-image workflow and output indices.

## Multi-image execution groups

- Adds **Images per execution** with a range of 1 through 9; the default remains 1.
- Appends `image_2` through `image_9` after the existing six outputs, so saved links to the original outputs keep their indices.
- Reserves complete ordered image groups at queue time so rapidly queued prompts do not overlap.
- Keeps **Don't consume** reusable: unchanged queues return the same ordered group again.
- Treats repeated queue entries that reference the same physical file as distinct logical images by queue-entry ID.
- Rejects incomplete or stale reservations with readable validation errors instead of repeating/filling images.
- Loads each selected image independently without stacking, resizing, padding, or forcing matching geometry.
- Makes remaining-pending counts, auto-queue arithmetic, backend deltas, and cache identity group-aware.

## Browser and scrolling

- Fixes the remaining Conveyor/Input Folder scroll-position regression caused by scrollbar-induced `clientWidth` changes being mistaken for real node resizes.
- Keeps the independently stored scroll position for each browser tab while preserving identity re-anchoring for genuine node-width changes.

## Compatibility

- State schema remains version 1; workflows without `images_per_execution` normalize to 1.
- Existing output slots 0 through 5 remain unchanged.
- Legacy single-item queue reservations and singular backend delta fields remain supported.
- `ImageConveyor` and the legacy `SequentialBatchImageLoader` alias continue to use the same node class.

## Validation

- 64 Python tests pass.
- 24 gallery/interaction JavaScript tests pass.
- 20 multi-image/group JavaScript tests pass.
- JavaScript syntax checks, Python compilation, and whitespace checks pass.
