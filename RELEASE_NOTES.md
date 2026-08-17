# Image Conveyor v1.6.0

This release adds first-class output controls for persistent-reference workflows, including a dedicated queue-driven `last_frame` output that can be wired directly to consumers such as MiniMax H3 Continuum without misusing a reference output.

## Main, last-frame, and reference output controls

- Added compact enable/disable switches for the main `image` output, the new `last_frame` output, and all eight `ref_image_1` through `ref_image_8` outputs.
- Disabled reference outputs keep their Reference Shelf assignments and editor wires intact while producing no active reference at execution time.
- Disabled main/last-frame branches are removed only from the queued API prompt; the visible workflow graph and saved links remain unchanged.
- Required downstream transform branches are pruned recursively until an optional input boundary is reached, preventing disabled image paths from crashing required image-processing nodes before reaching an optional consumer.
- Required/optional input classification uses ComfyUI's `/object_info` node definitions rather than frontend-only metadata.

## Dedicated `last_frame` queue output

`last_frame` is now a real Conveyor queue role rather than a repurposed Reference Shelf slot.

In **Persistent references** mode the queued execution snapshots the active queue roles explicitly:

- main `image` only: reserve/consume one queue image;
- `last_frame` only: reserve/consume one queue image and keep main image metadata neutral;
- main `image` + `last_frame`: reserve/consume two ordered queue images, with the first mapped to `image` and the second to `last_frame`;
- neither queue output active: reserve/consume zero queue images, allowing reference-only execution.

Reservation count follows **connected + enabled** queue outputs, so an enabled but unconnected `last_frame` socket does not consume an extra image.

The backend applies the same queue-role snapshot in validation, cache identity, selection, decoding, output mapping, pending-count handling, and consumption. Image-only and last-frame-only executions therefore cannot collide in cache identity.

## Saved-workflow compatibility

- Existing output indices 0 through 13 are preserved exactly.
- `ref_image_1` through `ref_image_8` remain at their existing numeric output slots.
- `last_frame` is appended as output slot 14 rather than inserted before the reference outputs.
- Older saved workflows that restore only the original 14 outputs receive an append-only frontend migration that adds `last_frame` at slot 14 without rebuilding, renumbering, or reconnecting existing sockets.
- Legacy queued prompts without the new queue-role snapshot retain the released main-image-only behavior.

## Queue and reference correctness

- Persistent queued prompts now carry independent `queue_output_slots` and `reference_output_slots` topology snapshots.
- Reference topology is serialized explicitly even when no main Conveyor reservation exists, preventing legacy "all references active" fallback from resurrecting a disabled reference.
- The authoritative persistent reservation is reconstructed at queue time, final widget serialization, and immediately before queued members are marked, eliminating frontend extension-wrapper ordering races.
- Reference toggle state is also embedded in backend-visible state so ordinary Conveyor state normalization cannot silently erase execution state.
- Queue-group mode keeps its released 1-through-9 behavior and existing reference-output mapping; `last_frame` additionally exposes the second grouped image when present without sacrificing an existing output.

## Validation

- Complete GitHub Actions coverage passes for Python tests, frontend pure-function tests, JavaScript syntax, Python syntax, and whitespace validation.
- Regression coverage includes reference-only, image-only, last-frame-only, and image+last-frame persistent execution; exact 0/1/2-image reservation counts; insufficient two-image handling; main-metadata neutrality in last-frame-only mode; cache-role separation; disabled-reference filtering; prompt-branch pruning; wrapper-order-independent queue serialization; queue-group compatibility; and append-only migration of older saved nodes.
- Live ComfyUI testing confirmed the original disabled-reference workflow no longer leaks reference tensors into First/Last Frame executions.
- Live ComfyUI testing confirmed the dedicated Conveyor `last_frame` output works when wired to the consumer's `last_frame` input.

## Upgrade notes

Because this release changes both backend output definitions and frontend node behavior, restart ComfyUI and hard-refresh the browser after updating. Existing Conveyor nodes should gain the appended `last_frame` output automatically; node recreation is not required.

## Packaging

- Version bumped to `1.6.0` for the Comfy Registry publish.
- The release workflow packages the exact tested `main` commit as `ComfyUI-Image-Conveyor-v1.6.0.zip` and publishes `SHA256SUMS` alongside it.
- GitHub release creation is gated on the successful push-to-`main` test workflow, and the Comfy Registry publish is triggered by the versioned `pyproject.toml` change on `main`.
