"""Backend runtime contract for Image Conveyor output toggles.

The UI keeps toggle state in node properties, but ComfyUI may reuse a cached
ImageConveyor result unless the state also participates in the backend-visible
prompt.  This module installs a narrow compatibility layer that makes the
serialized toggle state authoritative for output production while preserving
legacy prompts that predate the fields.
"""

from __future__ import annotations

from typing import Any


REFERENCE_OUTPUT_ENABLED_KEY = "reference_output_enabled"
MAIN_OUTPUT_ENABLED_KEY = "main_output_enabled"
REFERENCE_SLOT_COUNT = 8


def normalize_reference_output_enabled(value: Any, count: int = REFERENCE_SLOT_COUNT) -> tuple[bool, ...]:
    source = value if isinstance(value, list) else []
    return tuple(
        source[index] is not False if index < len(source) else True
        for index in range(max(0, int(count)))
    )


def normalize_main_output_enabled(value: Any) -> bool:
    return value is not False


def install_toggle_runtime(module: Any) -> None:
    """Patch Image Conveyor's module globals once with toggle-aware behavior."""
    if getattr(module, "_IMAGE_CONVEYOR_TOGGLE_RUNTIME_INSTALLED", False):
        return

    original_normalize_state = module._normalize_state
    original_active_reference_slots = module._active_reference_slots
    original_main_output_enabled = module._main_output_enabled

    def normalize_state(raw: Any):
        state = original_normalize_state(raw)
        payload = module._safe_json_load(raw, {})
        if not isinstance(payload, dict):
            payload = {}

        if REFERENCE_OUTPUT_ENABLED_KEY in payload:
            state[REFERENCE_OUTPUT_ENABLED_KEY] = normalize_reference_output_enabled(
                payload.get(REFERENCE_OUTPUT_ENABLED_KEY)
            )
        else:
            # Legacy prompts retain their released behavior until the frontend
            # writes an explicit toggle snapshot before queueing.
            state[REFERENCE_OUTPUT_ENABLED_KEY] = None

        if MAIN_OUTPUT_ENABLED_KEY in payload:
            state[MAIN_OUTPUT_ENABLED_KEY] = normalize_main_output_enabled(
                payload.get(MAIN_OUTPUT_ENABLED_KEY)
            )
        else:
            state[MAIN_OUTPUT_ENABLED_KEY] = None
        return state

    def active_reference_slots(state: dict[str, Any], queue_item_json: Any):
        slots = original_active_reference_slots(state, queue_item_json)
        enabled = state.get(REFERENCE_OUTPUT_ENABLED_KEY)
        if enabled is None:
            return slots
        return tuple(
            slot
            for slot in slots
            if 1 <= int(slot) <= len(enabled) and enabled[int(slot) - 1]
        )

    def main_output_enabled(state: dict[str, Any], queue_item_json: Any) -> bool:
        if state.get("output_mode") != module._OUTPUT_MODE_PERSISTENT:
            return True
        explicit = state.get(MAIN_OUTPUT_ENABLED_KEY)
        if explicit is not None:
            return bool(explicit)
        return original_main_output_enabled(state, queue_item_json)

    module._normalize_state = normalize_state
    module._active_reference_slots = active_reference_slots
    module._main_output_enabled = main_output_enabled
    module._IMAGE_CONVEYOR_TOGGLE_RUNTIME_INSTALLED = True
