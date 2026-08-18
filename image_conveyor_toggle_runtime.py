"""Backend runtime contract for Image Conveyor output toggles.

The UI keeps toggle state in node properties, but ComfyUI may reuse a cached
ImageConveyor result unless the state also participates in the backend-visible
prompt. This module installs a narrow compatibility layer that makes serialized
toggle state authoritative for output production while preserving legacy prompts
that predate the fields.
"""

from __future__ import annotations

import json
from typing import Any


REFERENCE_OUTPUT_ENABLED_KEY = "reference_output_enabled"
MAIN_OUTPUT_ENABLED_KEY = "main_output_enabled"
LAST_FRAME_OUTPUT_ENABLED_KEY = "last_frame_output_enabled"
REFERENCE_SLOT_COUNT = 8


def normalize_reference_output_enabled(
    value: Any, count: int = REFERENCE_SLOT_COUNT
) -> tuple[bool, ...]:
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
    original_connected_queue_output_slots = module._connected_queue_output_slots
    original_select_group = module._select_group

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

        if LAST_FRAME_OUTPUT_ENABLED_KEY in payload:
            state[LAST_FRAME_OUTPUT_ENABLED_KEY] = normalize_main_output_enabled(
                payload.get(LAST_FRAME_OUTPUT_ENABLED_KEY)
            )
        else:
            state[LAST_FRAME_OUTPUT_ENABLED_KEY] = None
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

    def filter_queue_slots(
        state: dict[str, Any], slots: tuple[int, ...]
    ) -> tuple[int, ...]:
        if state.get("output_mode") != module._OUTPUT_MODE_PERSISTENT:
            return slots

        main_enabled = state.get(MAIN_OUTPUT_ENABLED_KEY)
        last_frame_enabled = state.get(LAST_FRAME_OUTPUT_ENABLED_KEY)
        return tuple(
            slot
            for slot in slots
            if not (
                slot == module._QUEUE_SLOT_IMAGE and main_enabled is False
            )
            and not (
                slot == module._QUEUE_SLOT_LAST_FRAME
                and last_frame_enabled is False
            )
        )

    def connected_queue_output_slots(
        state: dict[str, Any], queue_item_json: Any
    ) -> tuple[int, ...]:
        raw_slots = original_connected_queue_output_slots(state, queue_item_json)
        return filter_queue_slots(state, raw_slots)

    def remap_reservation_for_active_slots(
        state: dict[str, Any], queue_item_json: Any
    ) -> Any:
        if state.get("output_mode") != module._OUTPUT_MODE_PERSISTENT:
            return queue_item_json

        raw_slots = original_connected_queue_output_slots(state, queue_item_json)
        active_slots = filter_queue_slots(state, raw_slots)
        if active_slots == raw_slots:
            return queue_item_json

        reservation = module._parse_queue_item(queue_item_json)
        if reservation is None:
            payload = module._safe_json_load(queue_item_json, {})
            if not isinstance(payload, dict):
                return queue_item_json
            payload = dict(payload)
            payload[module._QUEUE_OUTPUT_SLOTS_KEY] = list(active_slots)
            return json.dumps(payload, separators=(",", ":"))

        members = (
            list(reservation["items"])
            if reservation.get("grouped")
            else [{"id": reservation["id"], "annotated": reservation["annotated"]}]
        )
        if len(members) != len(raw_slots):
            raise RuntimeError(
                "Image Conveyor: queued image reservation does not match the "
                "queue output snapshot. Queue this prompt again."
            )

        active_set = set(active_slots)
        active_members = [
            member
            for slot, member in zip(raw_slots, members)
            if slot in active_set
        ]
        payload: dict[str, Any] = {
            module._QUEUE_OUTPUT_SLOTS_KEY: list(active_slots),
        }
        if active_members:
            first = active_members[0]
            payload.update(first)
            if len(active_members) > 1:
                payload["items"] = active_members
        return json.dumps(payload, separators=(",", ":"))

    def select_group(
        state: dict[str, Any],
        queue_item_json: Any,
        *,
        allow_processed: bool = False,
    ):
        return original_select_group(
            state,
            remap_reservation_for_active_slots(state, queue_item_json),
            allow_processed=allow_processed,
        )

    module._normalize_state = normalize_state
    module._active_reference_slots = active_reference_slots
    module._main_output_enabled = main_output_enabled
    module._connected_queue_output_slots = connected_queue_output_slots
    module._select_group = select_group
    module._IMAGE_CONVEYOR_TOGGLE_RUNTIME_INSTALLED = True
