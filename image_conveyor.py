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
        "dont_consume": False,
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


def _parse_queue_item(raw: Any) -> Optional[Dict[str, Any]]:
    """
    Parse a queue payload and extract normalized `id` and `annotated` fields.
    
    Parameters:
    	raw (Any): JSON string or object representing a queue payload containing `id` and `annotated`.
    
    Returns:
    	result (Optional[Dict[str, str]]): A dict with keys `"id"` and `"annotated"` containing trimmed, non-empty string values when both are present; `None` if the payload is invalid or required fields are missing.
    """
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


def _get_runtime_source_path(ui_state: Dict[str, Any], item: Dict[str, Any]) -> str:
    """
    Resolve the runtime source path for an item, preferring a UI-provided override when present.
    
    Parameters:
        ui_state (dict): UI state that may contain a `source_paths` mapping of item IDs to source path overrides.
        item (dict): Item dictionary containing at least an `"id"` key and an optional `"source_path"` fallback.
    
    Returns:
        str: The trimmed source path from `ui_state["source_paths"][item["id"]]` if non-empty, otherwise the trimmed `item["source_path"]` (or an empty string if neither is set).
    """
    source_paths = ui_state.get("source_paths", {}) if isinstance(ui_state, dict) else {}
    if isinstance(source_paths, dict):
        source_path = str(source_paths.get(item["id"], "")).strip()
        if source_path:
            return source_path
    return str(item.get("source_path", "")).strip()


def _find_item_by_id(state: Dict[str, Any], item_id: str) -> Tuple[int, Optional[Dict[str, Any]]]:
    """
    Locate an item in the given state by its `id` and return its index and the item.
    
    Parameters:
    	state (Dict[str, Any]): Normalized state dictionary containing an "items" list of item dicts.
    	item_id (str): The `id` value to search for.
    
    Returns:
    	tuple: A pair `(index, item)` where `index` is the zero-based index of the matching item or `-1` if not found, and `item` is the matching item dictionary or `None` if not found.
    """
    for index, item in enumerate(state["items"]):
        if item["id"] == item_id:
            return index, item
    return -1, None


def _select_item(
    state: Dict[str, Any],
    queue_item_json: Any,
    *,
    allow_processed: bool = False,
) -> Tuple[int, Dict[str, Any]]:
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

    if allow_processed and state["items"]:
        return 0, state["items"][0]

    raise RuntimeError(
        "Image Conveyor: no pending or queued images are available. "
        "Add images or reset items back to pending."
    )


class ImageConveyor:
    CATEGORY = "image"
    FUNCTION = "load_next"
    HAS_INTERMEDIATE_OUTPUT = True
    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "INT", "INT", "STRING")
    RETURN_NAMES = (
        "image",
        "mask",
        "path",
        "index",
        "remaining_pending",
        "source_path",
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
            return hashlib.sha256(str(state_json).encode("utf-8")).hexdigest()

        index, item = _select_item(
            state, queue_item_json, allow_processed=state["dont_consume"]
        )
        path = folder_paths.get_annotated_filepath(item["annotated"])

        hasher = hashlib.sha256()
        hasher.update(b"dont_consume=1" if state["dont_consume"] else b"dont_consume=0")
        hasher.update(str(index).encode("utf-8"))
        hasher.update(item["id"].encode("utf-8"))
        hasher.update(item["annotated"].encode("utf-8"))
        with open(path, "rb") as handle:
            hasher.update(handle.read())
        return hasher.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, state_json: Any, ui_state_json: Any = "", queue_item_json: Any = ""):
        """
        Validate that a selectable image item exists in the provided state and that its annotated file exists.
        
        Parameters:
        	state_json (Any): Serialized node state or raw state structure to validate.
        	queue_item_json (Any): Optional queue payload used to select a specific item (e.g., `{"id": "...", "annotated": "..."}`).
        
        Returns:
        	True on successful validation.
        	str: An error message when validation fails. Possible messages:
        		"Image Conveyor: no images have been added to the node." — when the state contains no items.
        		Contents of the selection error (from `_select_item`) — when item selection fails.
        		"Image Conveyor: missing file '<path>'." — when the selected item's annotated file is not found.
        """
        del ui_state_json
        state = _normalize_state(state_json)
        if not state["items"]:
            return "Image Conveyor: no images have been added to the node."

        try:
            _index, item = _select_item(
                state, queue_item_json, allow_processed=state["dont_consume"]
            )
        except RuntimeError as exc:
            return str(exc)

        if not folder_paths.exists_annotated_filepath(item["annotated"]):
            return f"Image Conveyor: missing file '{item['annotated']}'."

        return True

    def load_next(self, state_json: Any, ui_state_json: Any = "", queue_item_json: Any = ""):
        """
        Load the next selected image, compute remaining pending count, and produce a UI state delta.
        
        Parameters:
            state_json (Any): Serialized node state (will be normalized) containing the list of items.
            ui_state_json (Any): Serialized UI state (will be normalized); used to resolve the runtime source path for the selected item.
            queue_item_json (Any): Optional queue payload that can influence which item is selected.
        
        Returns:
            dict: A mapping with two keys:
                - "result": A tuple containing:
                    - image: The loaded image object.
                    - mask: The loaded mask object (may be None).
                    - annotated (str): The resolved annotated file path that was loaded.
                    - index (int): 1-based index of the selected item within the state list.
                    - remaining_pending (int): Number of other items in the state whose status is "pending".
                    - source_path (str): The resolved runtime source path for the selected item (prefers UI override).
                - "ui": A dict with key "batch_image_loader_delta" whose value is a single-item list containing a JSON string of the delta object with fields:
                    - version: State schema version.
                    - processed_item_id: ID of the processed item.
                    - processed_annotated: Annotated path of the processed item.
                    - new_status: The new status applied ("processed").
        """
        state = _normalize_state(state_json)
        ui_state = _normalize_ui_state(ui_state_json)
        dont_consume = state["dont_consume"]
        index, item = _select_item(
            state, queue_item_json, allow_processed=dont_consume
        )

        annotated = item["annotated"]
        source_path = _get_runtime_source_path(ui_state, item)
        image, mask = nodes.LoadImage().load_image(annotated)

        remaining_pending = 0
        for idx, candidate in enumerate(state["items"]):
            if not dont_consume and idx == index:
                continue
            if candidate["status"] == "pending":
                remaining_pending += 1

        delta = {
            "version": _STATE_VERSION,
            "processed_item_id": item["id"],
            "processed_annotated": annotated,
            "new_status": "processed",
            "consumed": not dont_consume,
        }

        return {
            "result": (
                image,
                mask,
                annotated,
                index + 1,
                remaining_pending,
                source_path,
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
