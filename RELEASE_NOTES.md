# Image Conveyor v1.5.0

This release adds direct queue-priority controls and fixes scrolling/navigation interactions inside the gallery.

## Queue priority and context actions

- Added **Move to front of pending queue** to the Conveyor image context menu.
- Right-clicking a selected image applies the action to the active selection; right-clicking outside the selection remains single-image scoped.
- Selected pending images move together to the first unreserved pending boundary while preserving their relative order.
- Selected processed images are re-queued as pending and moved to the same boundary, so they actually become upcoming work again.
- Already queued images remain untouched because their ComfyUI executions are already reserved.
- Priority moves return the Conveyor to manual ordering so a previous display sort cannot hide the actual execution order.
- Existing **Mark pending**, **Mark processed**, and **Remove from Conveyor** context actions now follow the same selection-aware behavior.

## Dragging and scrolling

- Internal image-card dragging now uses a pointer-driven compatibility layer instead of entering the browser's native HTML drag session.
- Mouse-wheel scrolling therefore remains available while one or more selected images are being dragged.
- Existing drag/drop behavior is retained for Conveyor reordering, multi-selection reordering, folder cards, tab hover/open, Input Folder moves, character folders, Conveyor drops, and Reference Shelf drops.
- External files dragged from the operating system continue to use native browser drag-and-drop.
- Edge autoscroll has a wider adaptive activation region, a smooth speed ramp, calibrated maximum speed, stale-drag cleanup, and stops cleanly outside active edges or at scroll limits.
- Ordinary gallery wheel input is owned by the gallery so it does not leak to the surrounding ComfyUI canvas.
- Middle-click inside the gallery now starts a consistent built-in vertical autoscroll mode instead of depending on browser-native middle-click behavior that may be intercepted by ComfyUI canvas panning.
- The middle-click mode shows an `↕` anchor at the activation point; moving above or below the anchor controls continuous scroll direction and speed. Another click, normal wheel input, Escape, focus loss, or node removal cancels it.
- Middle-button canvas panning outside the gallery remains untouched.

## Validation

- Complete GitHub Actions suite passes on the feature PR: Python tests, frontend pure-function tests, JavaScript syntax checks, Python compilation, and whitespace validation.
- CodeRabbit completed review successfully with no actionable inline review comments remaining before release preparation.
- Live ComfyUI testing confirmed **Move to front of pending queue** works for the intended queue cases.
- Live ComfyUI testing confirmed mouse-wheel scrolling works while selected images are actively dragged.
- Pure-function coverage now also checks the middle-click autoscroll dead zone, direction, acceleration ramp, and viewport-scaled speed clamps.

## Packaging

- Version bumped to `1.5.0` for the Comfy Registry publish.
- The release workflow builds `ComfyUI-Image-Conveyor-v1.5.0.zip` plus `SHA256SUMS` from the tested `main` commit.
- The tracked `.comfyignore` remains included in the source/release tree so Registry packaging excludes development-only `.github/` and `tests/` content as intended.
