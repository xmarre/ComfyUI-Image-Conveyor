# Image Conveyor v1.7.4

This hotfix restores ComfyUI global shortcuts such as **Ctrl+S / Cmd+S** with current `ComfyUI_frontend` behavior while preserving the Image Conveyor preview lightbox as a real modal when it is actually open.

## Root cause

Image Conveyor keeps its full-resolution preview lightbox mounted in the document while it is closed. The element was historically initialized with both:

```html
role="dialog" aria-modal="true" hidden
```

Current ComfyUI frontend modal detection treats `[role="dialog"][aria-modal="true"]` as an active modal for global keybinding gating. A hidden Image Conveyor preview could therefore make ComfyUI believe that a modal was permanently open. In that state, shortcuts such as `Ctrl+S` / `Cmd+S` were prevented instead of reaching the normal ComfyUI workflow-save command.

The Image Conveyor keyboard coordinator was not consuming the save shortcut itself; the failure came from the hidden preview being advertised as an active ARIA modal.

## Fix

v1.7.4 synchronizes the preview's ARIA modal state with its native `hidden` state:

- when the preview is closed/hidden, `aria-modal` is removed;
- when the preview becomes visible, `aria-modal="true"` is restored;
- a `MutationObserver` watches only the preview's `hidden` attribute;
- the observer is installed as soon as the core Image Conveyor context exists, independently of drag-specific initialization;
- the observer is disconnected when the node is removed.

This keeps the intended contract explicit: a closed preview is not exposed to ComfyUI as an active modal, while an open preview still gates global shortcuts normally.

## Performance and scope

The fix adds no draw-frame, scroll-frame, polling, filesystem, or API work. The observer is scoped to one attribute on one lightbox element per Image Conveyor node and only runs when that preview opens or closes.

No queue behavior, workflow state, output topology, image processing, reference handling, or backend execution is changed.

## Validation

Regression coverage verifies that:

- character preset auto-load remains independent of drag-specific readiness;
- a hidden preview removes `aria-modal`;
- a visible preview restores `aria-modal="true"`;
- the observer watches only the `hidden` attribute;
- Python tests, frontend pure-function tests, JavaScript syntax checks, Python syntax checks, and whitespace validation pass.

The affected setup has also been tested manually: `Ctrl+S` works again after the preview has been closed, while the preview retains its intended modal behavior when open.

A corresponding frontend hardening change was proposed upstream in `Comfy-Org/ComfyUI_frontend#16056`, but the Image Conveyor-side fix remains correct independently because its ARIA state should accurately represent whether the preview is actually modal.

## Upgrade notes

Restart ComfyUI and hard-refresh/reload the frontend after updating so the updated Image Conveyor frontend module is loaded.
