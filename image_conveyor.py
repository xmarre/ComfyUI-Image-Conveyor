import hashlib
import json
import math
from typing import Any, Dict, List, Optional, Tuple

import folder_paths
import nodes


_STATE_VERSION = 1
_MAX_IMAGES_PER_EXECUTION = 9


def _deep_copy_json(value: Any) -> Any:
    return json.loads(json.dumps(value))


def _normalize_images_per_execution(value: Any) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return 1
    if not math.isfinite(number):
        return 1
    return max(1, min(_MAX_IMAGES_PER_EXECUTION, int(number)))


def _default_state() -> Dict[str, Any]:
    return {
        "version": _STATE_VERSION,
        "items": [],
        "auto_queue": False,
        "dont_consume": False,
        "catch_canvas_drops": False,
        "images_per_execution": 1,
    }


def _default_ui_state() -> Dict[str, Any]:
    """
    Return the default persisted UI state used by the node.

    The returned state contains the schema version and the UI-specific fields tracked across sessions:
    - `version`: schema version forced to the module `_STATE_VERSION`.
    - `selected_ids`: list of selected item IDs (empty by default).
    - `source_paths`: mapping of `{item_id: path}` that can override an item's stored `source_path` at runtime.

    Returns:
        ui_state (Dict[str, Any]): Default UI state with keys `version`, `selected_ids`, and `source_paths`.
    """
    return {
        "version": _STATE_VERSION,
        "selected_ids": [],
        "source_paths": {},
    }


def _safe_json_load(raw: Any, fallback: Any) -> Any:
    if not isinstance(raw, str) or not raw.strip():
        return _deep_copy_json(fallback)
    try:
        value = json.loads(raw)
    except Exception:
        return _deep_copy_json(fallback)
    return value


def _normalize_item(item: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None

    item_id = str(item.get("id", "")).strip()
    annotated = str(item.get("annotated", "")).strip()
    if not item_id or not annotated:
        return None

    status = str(item.get("status", "pending")).strip().lower()
    if status not in {"pending", "queued", "processed"}:
        status = "pending"

    return {
        "id": item_id,
        "annotated": annotated,
        "filename": str(item.get("filename", "")).strip(),
        "subfolder": str(item.get("subfolder", "")).strip(),
        "source_path": str(item.get("source_path", "")).strip(),
        "type": str(item.get("type", "input")).strip() or "input",
        "status": status,
        "added_at": int(item.get("added_at", 0) or 0),
        "last_queued_at": int(item.get("last_queued_at", 0) or 0),
        "last_processed_at": int(item.get("last_processed_at", 0) or 0),
    }


def _normalize_state(raw: Any) -> Dict[str, Any]:
    state = _safe_json_load(raw, _default_state())
    items_raw = state.get("items", []) if isinstance(state, dict) else []
    items: List[Dict[str, Any]] = []
    if isinstance(items_raw, list):
        for item in items_raw:
            normalized = _normalize_item(item)
            if normalized is not None:
                items.append(normalized)
    return {
        "version": _STATE_VERSION,
        "items": items,
        "auto_queue": bool(state.get("auto_queue", False)) if isinstance(state, dict) else False,
        "dont_consume": bool(state.get("dont_consume", False)) if isinstance(state, dict) else False,
        "catch_canvas_drops": bool(state.get("catch_canvas_drops", False)) if isinstance(state, dict) else False,
        "images_per_execution": _normalize_images_per_execution(
            state.get("images_per_execution", 1) if isinstance(state, dict) else 1
        ),
    }


def _normalize_ui_state(raw: Any) -> Dict[str, Any]:
    """
    Normalize a raw UI state payload into the expected runtime UI state structure.

    Parameters:
        raw (Any): Raw UI state value, typically a JSON string or already-parsed object.

    Returns:
        Dict[str, Any]: Normalized UI state with keys:
            - `version` (int): Schema version (set to the module `_STATE_VERSION`).
            - `selected_ids` (List[str]): List of non-empty trimmed item IDs.
            - `source_paths` (Dict[str, str]): Mapping of item ID to non-empty trimmed source path.
    """
    ui_state = _safe_json_load(raw, _default_ui_state())
    selected_ids_raw = ui_state.get("selected_ids", []) if isinstance(ui_state, dict) else []
    source_paths_raw = ui_state.get("source_paths", {}) if isinstance(ui_state, dict) else {}
    selected_ids: List[str] = []
    if isinstance(selected_ids_raw, list):
        selected_ids = [str(value) for value in selected_ids_raw if str(value).strip()]

    source_paths: Dict[str, str] = {}
    if isinstance(source_paths_raw, dict):
        for key, value in source_paths_raw.items():
            item_id = str(key).strip()
            path = str(value).strip()
            if item_id and path:
                source_paths[item_id] = path

    return {
        "version": _STATE_VERSION,
        "selected_ids": selected_ids,
        "source_paths": source_paths,
    }


def _normalize_queue_member(value: Any) -> Optional[Dict[str, str]]:
    if not isinstance(value, dict):
        return None
    item_id = str(value.get("id", "")).strip()
    annotated = str(value.get("annotated", "")).strip()
    if not item_id or not annotated:
        return None
    return {"id": item_id, "annotated": annotated}


def _parse_queue_item(raw: Any) -> Optional[Dict[str, Any]]:
    """Parse a legacy single-item or new ordered group prompt reservation."""
    payload = _safe_json_load(raw, {})
    if not isinstance(payload, dict):
        return None

    if "items" in payload:
        raw_items = payload.get("items")
        if not isinstance(raw_items, list) or not raw_items:
            raise RuntimeError("Image Conveyor: queued image group reservation is invalid.")

        items: List[Dict[str, str]] = []
        seen_ids = set()
        for raw_item in raw_items:
            member = _normalize_queue_member(raw_item)
            if member is None or member["id"] in seen_ids:
                raise RuntimeError("Image Conveyor: queued image group reservation is invalid.")
            seen_ids.add(member["id"])
            items.append(member)

        first = items[0]
        top_level = _normalize_queue_member(payload)
        if top_level is not None and top_level != first:
            raise RuntimeError("Image Conveyor: queued image group reservation is inconsistent.")
        return {
            "id": first["id"],
            "annotated": first["annotated"],
            "items": items,
            "grouped": True,
        }

    item = _normalize_queue_member(payload)
    if item is None:
        return None
    return {
        "id": item["id"],
        "annotated": item["annotated"],
        "grouped": False,
    }


def _get_runtime_source_path(ui_state: Dict[str, Any], item: Dict[str, Any]) -> str:
    """Resolve the runtime source path, preferring the UI-only source-path override."""
    source_paths = ui_state.get("source_paths", {}) if isinstance(ui_state, dict) else {}
    if isinstance(source_paths, dict):
        source_path = str(source_paths.get(item["id"], "")).strip()
        if source_path:
            return source_path
    return str(item.get("source_path", "")).strip()


def _find_item_by_id(state: Dict[str, Any], item_id: str) -> Tuple[int, Optional[Dict[str, Any]]]:
    """Locate a queue item by its logical queue-entry ID."""
    for index, item in enumerate(state["items"]):
        if item["id"] == item_id:
            return index, item
    return -1, None


def _insufficient_group_error(requested: int, available: int) -> RuntimeError:
    return RuntimeError(
        f"Image Conveyor: {requested} images per execution requested, "
        f"but only {available} eligible queue images are available."
    )


def _select_group(
    state: Dict[str, Any],
    queue_item_json: Any,
    *,
    allow_processed: bool = False,
) -> List[Tuple[int, Dict[str, Any]]]:
    """Resolve one complete ordered execution group from reservation or queue state."""
    count = _normalize_images_per_execution(state.get("images_per_execution", 1))
    reservation = _parse_queue_item(queue_item_json)

    if reservation is not None and reservation.get("grouped"):
        reserved_items = reservation["items"]
        if len(reserved_items) != count:
            raise RuntimeError(
                f"Image Conveyor: queued image group contains {len(reserved_items)} images, "
                f"but this prompt requests {count}."
            )

        selected: List[Tuple[int, Dict[str, Any]]] = []
        for reserved in reserved_items:
            index, item = _find_item_by_id(state, reserved["id"])
            if item is None:
                raise RuntimeError(
                    f"Image Conveyor: reserved queue image '{reserved['id']}' is no longer present."
                )
            if item["annotated"] != reserved["annotated"]:
                raise RuntimeError(
                    f"Image Conveyor: reserved queue image '{reserved['id']}' changed after it was queued."
                )
            selected.append((index, item))
        return selected

    if reservation is not None:
        if count != 1:
            raise RuntimeError(
                "Image Conveyor: a legacy single-image reservation cannot satisfy "
                f"{count} images per execution. Queue this prompt again."
            )

        index, item = _find_item_by_id(state, reservation["id"])
        if item is not None:
            return [(index, item)]
        for idx, candidate in enumerate(state["items"]):
            if candidate["annotated"] == reservation["annotated"]:
                return [(idx, candidate)]

    eligible = [
        (idx, item)
        for idx, item in enumerate(state["items"])
        if item["status"] in {"pending", "queued"}
    ]
    if eligible:
        if len(eligible) < count:
            raise _insufficient_group_error(count, len(eligible))
        return eligible[:count]

    if allow_processed and state["items"]:
        if len(state["items"]) < count:
            raise _insufficient_group_error(count, len(state["items"]))
        return list(enumerate(state["items"][:count]))

    if count > 1:
        raise _insufficient_group_error(count, 0)
    raise RuntimeError(
        "Image Conveyor: no pending or queued images are available. "
        "Add images or reset items back to pending."
    )


def _select_item(
    state: Dict[str, Any],
    queue_item_json: Any,
    *,
    allow_processed: bool = False,
) -> Tuple[int, Dict[str, Any]]:
    """Compatibility wrapper preserving the released single-item selection helper."""
    single_state = dict(state)
    single_state["images_per_execution"] = 1
    return _select_group(single_state, queue_item_json, allow_processed=allow_processed)[0]


def _unresolved_change_hash(state: Dict[str, Any], reason: str) -> str:
    """Return a stable cache sentinel while input validation reports the real error."""
    identity = f"unresolved|images_per_execution={state['images_per_execution']}|{reason}"
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


class ImageConveyor:
    CATEGORY = "image"
    FUNCTION = "load_next"
    HAS_INTERMEDIATE_OUTPUT = True
    RETURN_TYPES = (
        "IMAGE",
        "MASK",
        "STRING",
        "INT",
        "INT",
        "STRING",
        "IMAGE",
        "IMAGE",
        "IMAGE",
        "IMAGE",
        "IMAGE",
        "IMAGE",
        "IMAGE",
        "IMAGE",
    )
    RETURN_NAMES = (
        "image",
        "mask",
        "path",
        "index",
        "remaining_pending",
        "source_path",
        "image_2",
        "image_3",
        "image_4",
        "image_5",
        "image_6",
        "image_7",
        "image_8",
        "image_9",
    )
    SEARCH_ALIASES = [
        "image conveyor",
        "comfyui image conveyor",
        "batch image loader",
        "sequential image loader",
        "image queue",
        "load multiple images",
        "drag and drop images",
        "vue batch image loader",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "state_json": (
                    "STRING",
                    {
                        "default": json.dumps(_default_state(), separators=(",", ":")),
                        "multiline": True,
                    },
                ),
                "ui_state_json": (
                    "STRING",
                    {
                        "default": json.dumps(_default_ui_state(), separators=(",", ":")),
                        "multiline": False,
                    },
                ),
                "queue_item_json": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                    },
                ),
            }
        }

    @classmethod
    def IS_CHANGED(cls, state_json: Any, ui_state_json: Any = "", queue_item_json: Any = ""):
        del ui_state_json
        state = _normalize_state(state_json)
        if not state["items"]:
            empty_identity = f"{state_json}|images_per_execution={state['images_per_execution']}"
            return hashlib.sha256(empty_identity.encode("utf-8")).hexdigest()

        try:
            selected = _select_group(
                state, queue_item_json, allow_processed=state["dont_consume"]
            )
        except RuntimeError as exc:
            return _unresolved_change_hash(state, f"selection|{exc}")

        hasher = hashlib.sha256()
        hasher.update(b"dont_consume=1" if state["dont_consume"] else b"dont_consume=0")
        hasher.update(f"|images_per_execution={state['images_per_execution']}".encode("utf-8"))
        for slot, (index, item) in enumerate(selected, start=1):
            hasher.update(f"|slot={slot}|index={index}|".encode("utf-8"))
            hasher.update(item["id"].encode("utf-8"))
            hasher.update(b"|")
            hasher.update(item["annotated"].encode("utf-8"))
            try:
                path = folder_paths.get_annotated_filepath(item["annotated"])
                with open(path, "rb") as handle:
                    while True:
                        chunk = handle.read(1024 * 1024)
                        if not chunk:
                            break
                        hasher.update(chunk)
            except FileNotFoundError:
                return _unresolved_change_hash(
                    state,
                    f"missing|slot={slot}|index={index}|id={item['id']}|annotated={item['annotated']}",
                )
        return hasher.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, state_json: Any, ui_state_json: Any = "", queue_item_json: Any = ""):
        del ui_state_json
        state = _normalize_state(state_json)
        if not state["items"]:
            return "Image Conveyor: no images have been added to the node."

        try:
            selected = _select_group(
                state, queue_item_json, allow_processed=state["dont_consume"]
            )
        except RuntimeError as exc:
            return str(exc)

        for _index, item in selected:
            if not folder_paths.exists_annotated_filepath(item["annotated"]):
                return f"Image Conveyor: missing file '{item['annotated']}'."

        return True

    def load_next(self, state_json: Any, ui_state_json: Any = "", queue_item_json: Any = ""):
        state = _normalize_state(state_json)
        ui_state = _normalize_ui_state(ui_state_json)
        dont_consume = state["dont_consume"]
        selected = _select_group(
            state, queue_item_json, allow_processed=dont_consume
        )

        loader = nodes.LoadImage()
        loaded_images: List[Any] = []
        first_mask = None
        for slot, (_index, item) in enumerate(selected):
            image, mask = loader.load_image(item["annotated"])
            loaded_images.append(image)
            if slot == 0:
                first_mask = mask

        first_index, first_item = selected[0]
        annotated = first_item["annotated"]
        source_path = _get_runtime_source_path(ui_state, first_item)
        selected_ids = {item["id"] for _index, item in selected}
        remaining_pending = sum(
            1
            for item in state["items"]
            if item["status"] == "pending"
            and (dont_consume or item["id"] not in selected_ids)
        )

        processed_items = [
            {"id": item["id"], "annotated": item["annotated"]}
            for _index, item in selected
        ]
        delta = {
            "version": _STATE_VERSION,
            "processed_item_id": first_item["id"],
            "processed_annotated": annotated,
            "processed_items": processed_items,
            "new_status": "processed",
            "consumed": not dont_consume,
        }

        additional_images = loaded_images[1:] + [None] * (
            _MAX_IMAGES_PER_EXECUTION - len(loaded_images)
        )
        return {
            "result": (
                loaded_images[0],
                first_mask,
                annotated,
                first_index + 1,
                remaining_pending,
                source_path,
                *additional_images,
            ),
            "ui": {
                "batch_image_loader_delta": [json.dumps(delta, separators=(",", ":"))],
            },
        }


NODE_CLASS_MAPPINGS = {
    "ImageConveyor": ImageConveyor,
    "SequentialBatchImageLoader": ImageConveyor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageConveyor": "Image Conveyor",
    "SequentialBatchImageLoader": "Image Conveyor",
}
