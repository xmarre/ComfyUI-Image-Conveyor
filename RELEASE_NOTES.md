# Image Conveyor v1.7.1

This hotfix fixes character folders sometimes appearing empty on their first open after restarting ComfyUI/the frontend even though the images are present on disk.

## Character Folder first-open fix

The character browser is backed by Image Conveyor's shared Input Folder file index. Character-folder metadata can become available before that file index has been initialized, especially immediately after startup. Opening **Folder** in that state previously built the character view against an empty `ctx.icx.allFiles`, so valid character members were filtered out. Visiting **Input Folder** initialized the missing index, which is why switching to Input and back made the images appear.

v1.7.1 makes the dependency explicit:

- opening a character Folder now waits for the shared Input Folder index when it has not initialized yet;
- an already-running initial Input load is reused instead of aborted/restarted;
- if no load has started, Image Conveyor invokes its existing Input Folder refresh path without switching the visible tab;
- the completed Input dataset is synchronized into the library layer before the existing character-folder handler creates/switches the view;
- repeated Folder clicks while initialization is pending are coalesced;
- an already-created character view is forced to rebuild from the initialized index;
- a failed Input-index initialization reports an error instead of showing a false empty character folder.

## Performance and safety

- The fix is on-demand; it does **not** eagerly enumerate the Input Folder during every workflow/node startup.
- Once the shared Input Folder index is initialized, subsequent character-folder opens use the existing immediate path and perform no extra scan.
- The readiness path performs no character migration, materialization, or character filesystem mutation.
- The v1.7.0 character migration/autosave safety rules remain unchanged.

## Validation

GitHub Actions covers the new readiness state machine and lifecycle ordering in addition to the complete existing suite:

- Python tests;
- frontend pure-function/policy tests;
- JavaScript syntax checks;
- Python syntax checks;
- whitespace validation.

The regression tests specifically verify that an idle uninitialized index starts one refresh, an in-flight load is waited on, a completed load is used immediately, failed initialization terminates instead of looping, the shared index is synchronized before delegation to the existing Folder handler, and the readiness path contains no character migration/materialization endpoint.

## Upgrade notes

Restart ComfyUI and hard-refresh/reload the frontend after updating so the new frontend readiness module is loaded.
