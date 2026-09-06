# Image Conveyor v1.7.3

This hotfix fixes browser-dependent output switches disappearing beside the Reference Shelf, most visibly in Microsoft Edge.

Affected controls could include the main `image` switch, `ref_image_1` through `ref_image_8`, and `last_frame`. The workflow state and outputs were still present; the frontend layout was deciding that there was not enough room to render the switch or create its hitbox.

## Root cause

Image Conveyor positioned each switch between the Reference Shelf and its output label. The shelf gutter was derived from rendered label widths, while the toggle code independently measured the label and required at least 18 px of usable space.

For the widest label, the previous geometry could leave only about 5 px after the existing clearances, causing `calculateReferenceToggleRect()` to return `null`.

There was also a second browser-sensitive assumption: the shelf-side measurement and the toggle measurement were not guaranteed to use the same canvas font state. Current ComfyUI invokes node `onDrawForeground` before assigning the normal connection-slot font, while the toggle renderers explicitly use `node.innerFontStyle`. Browser/font differences could therefore change which controls crossed the cutoff.

## Fix

v1.7.3 gives the output controls an explicit reserved lane:

- output labels are measured with `node.innerFontStyle`, matching the toggle renderers;
- the widest current output label establishes the normal output gutter;
- a fixed 28 px control lane is reserved on top of that gutter;
- the cached Reference Shelf layout is invalidated and redrawn once when the label/font key changes;
- the existing `<18 px` collision guard remains intact, so switches are not allowed to overlap the shelf or their labels;
- generic Reference Shelf geometry and workflow/backend behavior are unchanged.

The measurement is cached by output-label set and font style, so the fix does not add repeated per-frame label measurement after the layout stabilizes.

## Validation

Regression coverage verifies:

- representative output-label widths from 52 to 110 px keep the full preferred 26 px switch;
- the switch retains the existing 7 px clearances from both the shelf and label;
- a deliberately mismatched foreground-font measurement reproduces the previous failure;
- measuring with the same `node.innerFontStyle` used by the toggles restores the control;
- shelf invalidation/redraw and stable-key caching are preserved;
- Python tests, frontend pure-function tests, JavaScript syntax checks, Python syntax checks, and whitespace validation pass.

The original affected Edge setup was also tested manually and the missing reference switches are visible and usable again.

## Upgrade notes

Restart ComfyUI and hard-refresh/reload the frontend after updating so the new frontend extension is loaded.
