import hashlib
import json
from typing import Any, Dict, List, Optional, Tuple

import folder_paths
import nodes


_STATE_VERSION = 1


def _deep_copy_json(value: Any) -> Any:
    return json.loads(json.dumps(value))


def _default_state() -> Dict[str, Any]:
    return {
        "version": _STATE_VERSION,
        "items": [],
        "auto_queue": False,
    }


def _default_ui_state() -> Dict[str, Any]:
    return {
        "version": _STATE_VERSION,
        "selected_ids": [],
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
    }


def _normalize_ui_state(raw: Any) -> Dict[str, Any]:
    ui_state = _safe_json_load(raw, _default_ui_state())
    selected_ids_raw = ui_state.get("selected_ids", []) if isinstance(ui_state, dict) else []
    selected_ids: List[str] = []
    if isinstance(selected_ids_raw, list):
        selected_ids = [str(value) for value in selected_ids_raw if str(value).strip()]
    return {
        "version": _STATE_VERSION,
        "selected_ids": selected_ids,
    }


def _parse_queue_item(raw: Any) -> Optional[Dict[str, Any]]:
    payload = _safe_json_load(raw, {})
    if not isinstance(payload, dict):
        return None

    item_id = str(payload.get("id", "")).strip()
    annotated = str(payload.get("annotated", "")).strip()
    if not item_id or not annotated:
        return None
    return {
        "id": item_id,
        "annotated": annotated,
    }


def _find_item_by_id(state: Dict[str, Any], item_id: str) -> Tuple[int, Optional[Dict[str, Any]]]:
    for index, item in enumerate(state["items"]):
        if item["id"] == item_id:
            return index, item
    return -1, None


def _select_item(state: Dict[str, Any], queue_item_json: Any) -> Tuple[int, Dict[str, Any]]:
    queued_item = _parse_queue_item(queue_item_json)
    if queued_item is not None:
        index, item = _find_item_by_id(state, queued_item["id"])
        if item is not None:
            return index, item
        for idx, candidate in enumerate(state["items"]):
            if candidate["annotated"] == queued_item["annotated"]:
                return idx, candidate

    for idx, item in enumerate(state["items"]):
        if item["status"] in {"pending", "queued"}:
            return idx, item

    raise RuntimeError(
        "Image Conveyor: no pending or queued images are available. "
        "Add images or reset items back to pending."
    )


class ImageConveyor:
    CATEGORY = "image"
    FUNCTION = "load_next"
    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "path", "index", "remaining_pending")
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
            return hashlib.sha256(str(state_json).encode("utf-8")).hexdigest()

        index, item = _select_item(state, queue_item_json)
        path = folder_paths.get_annotated_filepath(item["annotated"])

        hasher = hashlib.sha256()
        hasher.update(str(index).encode("utf-8"))
        hasher.update(item["id"].encode("utf-8"))
        hasher.update(item["annotated"].encode("utf-8"))
        with open(path, "rb") as handle:
            hasher.update(handle.read())
        return hasher.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, state_json: Any, ui_state_json: Any = "", queue_item_json: Any = ""):
        del ui_state_json
        state = _normalize_state(state_json)
        if not state["items"]:
            return "Image Conveyor: no images have been added to the node."

        try:
            _index, item = _select_item(state, queue_item_json)
        except RuntimeError as exc:
            return str(exc)

        if not folder_paths.exists_annotated_filepath(item["annotated"]):
            return f"Image Conveyor: missing file '{item['annotated']}'."

        return True

    def load_next(self, state_json: Any, ui_state_json: Any = "", queue_item_json: Any = ""):
        del ui_state_json
        state = _normalize_state(state_json)
        index, item = _select_item(state, queue_item_json)

        annotated = item["annotated"]
        image, mask = nodes.LoadImage().load_image(annotated)

        remaining_pending = 0
        for idx, candidate in enumerate(state["items"]):
            if idx == index:
                continue
            if candidate["status"] == "pending":
                remaining_pending += 1

        delta = {
            "version": _STATE_VERSION,
            "processed_item_id": item["id"],
            "processed_annotated": annotated,
            "new_status": "processed",
        }

        return {
            "result": (
                image,
                mask,
                annotated,
                index + 1,
                remaining_pending,
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
