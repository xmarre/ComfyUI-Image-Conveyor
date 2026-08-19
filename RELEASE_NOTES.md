# Image Conveyor v1.7.2

This hotfix fixes a second character-folder synchronization bug exposed by freshly created character presets: reference images could be assigned correctly, physically exist in the character folder, and appear in the Reference Shelf while the character **Folder** browser still showed an empty/stale collection.

## Root cause

The character browser depends on two independent frontend data sources:

1. the shared Input Folder file index (`ctx.icx.allFiles`), which supplies the actual image records rendered by the gallery;
2. character membership metadata, which is required for canonical images shared across character presets even when they physically live in another managed character folder.

The existing materialization path refreshed the Input libraries only when the backend returned a non-empty `moved` list. That is insufficient for local/external reference drops: those files are uploaded directly into the target character folder before materialization. Materialization then correctly reports `moved=[]` because the files are already in their destination, but the frontend Input index can still be the pre-upload snapshot. The resulting reference paths are valid and the files are present on disk, yet the character browser cannot resolve them and appears empty.

Character membership can also change without a physical move, such as when another character shares an existing canonical file. That left the browser's private character metadata cache stale independently of the Input index.

## Fix

v1.7.2 adds explicit post-materialization synchronization:

- after a successful character reference drop, Image Conveyor checks whether the normal materialization path already started an Input refresh;
- when it did not, the live reference-slot paths are compared against the current shared Input index;
- an Input refresh is started only when a live reference path is actually missing from that index;
- if another Input refresh was already running before the drop, Image Conveyor waits for it to finish and only performs another refresh if the completed index is still missing the newly assigned reference path;
- fallback refreshes preserve the current character/library scroll position rather than jumping the view to the top;
- successful character materialization invalidates the private character metadata cache so the existing library layer performs one authoritative registry sync;
- the visible character collection is also reconciled immediately from authoritative membership metadata plus physical files inside the managed character folder;
- explicit **Folder** opens repeat that lightweight metadata reconciliation so a stale private membership cache cannot leave the view empty.

## Performance and safety

- No unconditional full Input Folder scan was added.
- If the existing materialization path already triggered a refresh, v1.7.2 does not start another one.
- If all live reference paths are already indexed, no Input rescan is performed.
- Character metadata synchronization is a small registry request and does not enumerate the whole Input tree.
- The synchronization layer does not call whole-character migration or bulk materialization endpoints and performs no additional filesystem mutation.
- Existing scroll-restoration behavior is preserved when the fallback Input refresh is needed.

## Validation

GitHub Actions covers the new synchronization logic in addition to the complete existing suite. Regression tests verify:

- newly uploaded character references missing from an old Input index trigger synchronization;
- already indexed/shared canonical references avoid unnecessary Input rescans;
- character collections combine physical folder contents with authoritative shared membership;
- missing registry members are omitted when the underlying file no longer exists;
- an in-flight Input refresh is allowed to complete before deciding whether another refresh is necessary;
- fallback refreshes preserve active library scroll state;
- successful materialization invalidates the private character metadata cache;
- the synchronization module never invokes migration or materialization endpoints itself;
- JavaScript/Python syntax and whitespace validation continue to pass.

## Upgrade notes

Restart ComfyUI and hard-refresh/reload the frontend after updating so the new frontend synchronization module is loaded.
