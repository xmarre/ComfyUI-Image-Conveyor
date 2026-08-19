# Image Conveyor v1.7.0

This release hardens the output-toggle/runtime path introduced in v1.6.0 and completes the character-preset workflow with stable shared references, immediate preset loading, and automatic Reference Shelf persistence.

## Disabled-output runtime and prompt pruning

- Main `image` and `last_frame` toggle state is now backend-authoritative over queued role snapshots.
- A stale queued `image + last_frame` reservation can no longer leak a disabled role back into execution.
- When only one of those roles remains enabled, the correct positional queue member is preserved.
- Disabling both queue-driven outputs requires no Conveyor image and supports reference-only execution.
- Internally inconsistent stale reservations fail explicitly instead of guessing.
- Legacy queued prompts and queue-group behavior remain compatible.

Serialized API-prompt pruning is also stricter and safer:

- exact disabled output links are removed;
- a consumer whose removed input is proven **required** is removed from the submitted prompt;
- unavailability propagates through all used downstream outputs of that removed node;
- propagation stops at optional or unknown input boundaries, removing only the unavailable link there;
- terminal/output nodes whose required dependency disappeared are removed as well;
- dangling links are swept after propagation;
- the visible ComfyUI workflow graph and saved wires are not mutated.

This fixes the live failure mode where disabling Image Conveyor's main image left required image preprocessing / video-output nodes serialized and caused errors such as `Required input is missing: image/images`, while preserving valid independent reference-only H3 branches.

## Character preset stability

Character references now use stable physical canonical files.

- If an image already lives under a managed character folder, another character preset can share that canonical path logically without physically moving it into a second character folder.
- Mixed shared + newly materialized reference batches preserve source order.
- Queued/protected file semantics remain intact.
- Repeated explicit character migration is idempotent for shared references.

The unsafe automatic whole-character-library migration path has been removed from normal runtime lifecycle. Node installation, drawing, preset switching, queue transitions, and Refresh no longer launch background character migration/materialization. Explicit Reference Shelf drag/drop still performs the file operation requested by the user.

This removes the Image Conveyor-specific background migration trigger observed in the reported process-level crash. The fatal stack showed Image Conveyor inside character migration, but does not by itself prove that Python `pathlib` was the native SIGSEGV source.

## Character preset loading and autosave

- Selecting a character preset now loads its Reference Shelf immediately again.
- Preset auto-load is independent of the batch-drag extension lifecycle.
- Reference Shelf edits are live node state and already apply to the next queued generation without pressing Save.
- When a named preset is active, adding/replacing, clearing, reordering, or relinking reference slots now autosaves automatically.
- Autosave only fires while the same named preset remains active and the normalized slot set actually changed.
- Loading/switching presets, workflow loading, redraws, queue-state changes, and unrelated node-state updates do not become writes.
- Writes are serialized/coalesced per preset so rapid edits cannot complete out of order.
- Switching from preset A to B does not discard a pending A edit.
- Failed writes use bounded retries and cannot stall another preset's pending save.
- Autosave only uses the reference-preset persistence endpoint; it never invokes character migration/materialization.
- Queue execution never waits for autosave because execution reads the live `state_json.reference_slots` snapshot directly.

The manual Save action remains available as a fallback and for creating a preset when no named preset is active.

## Folder/reference UI behavior

- Assigning a shared/reused reference no longer refreshes the entire source library when no file actually moved.
- When a real materialization does require a refresh, the active stable view and scroll position are preserved.
- Visible views use the live scroll position; off-screen/non-measurable views fall back to their saved per-view position.
- Character/folder views therefore no longer jump to the top simply because an image was assigned to a Reference Shelf slot.

## README and documentation

The README has been rewritten around the current behavior, including:

- dedicated `last_frame` output and stable slot 14;
- connected + enabled queue-role semantics;
- output switches and serialized branch pruning;
- Reference Shelf connection-aware execution;
- immediate character-preset loading;
- live Reference Shelf generation semantics;
- character preset autosave;
- shared canonical character references;
- current compatibility/upgrade instructions.

## Validation

PR #38 and PR #39 were each validated independently. Before merging #39, the merged #38 `main` commit was integrated into #39 and the complete combined branch was tested again.

The final combined suite passed:

- Python unit/integration tests;
- frontend Node.js tests;
- JavaScript syntax checks;
- Python syntax checks;
- whitespace validation.

Regression coverage includes stale queue-role reservations, image/last-frame toggle authority, required/optional/unknown pruning boundaries, exact failing image-only branch topology, shared character canonical paths, migration idempotency, protected references, scroll preservation, preset auto-load lifecycle independence, and autosave trigger isolation.

## Upgrade notes

Restart ComfyUI and hard-refresh/reload the browser frontend after updating so the backend runtime shim and frontend extensions are both current.

Existing output indices remain stable. `last_frame` remains appended at output slot 14; existing output wiring is not renumbered.

## Packaging

- Version bumped to `1.7.0` for the Comfy Registry publish.
- GitHub release creation remains gated on the successful push-to-`main` test workflow.
- The release workflow packages the exact tested commit as `ComfyUI-Image-Conveyor-v1.7.0.zip` and publishes `SHA256SUMS` alongside it.
- `.comfyignore` remains tracked in the repository/package and excludes development-only `.github/` and `tests/` content from Comfy Registry packaging.
