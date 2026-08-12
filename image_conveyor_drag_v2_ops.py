import asyncio
import json
import logging
import os
import stat as stat_module
import threading
import uuid
from contextlib import ExitStack
from pathlib import PurePosixPath
from typing import Any, Dict, List, Sequence

from .image_conveyor_drag_ops import _parent_path, _regular_existing_target, _same_file_contents
from .image_conveyor_library_ops import (
    CHARACTER_FOLDER_ROOT,
    InvalidLibraryOperation,
    _invalidate_library_snapshot,
    _normalize_path_batch,
    _normalize_protected_paths,
    _normalize_subfolder,
    _registry_for_service,
    _regular_input_file,
    _validate_directory,
    move_input_files,
)
from .image_conveyor_server import (
    InvalidInputPath,
    InvalidPreset,
    InvalidUpload,
    get_service,
    stable_file_digest,
)


LOGGER = logging.getLogger(__name__)
_DRAG_ROUTES_REGISTERED = False
_DRAG_ROUTES_MARKER = "_image_conveyor_drag_v2_routes_registered"
_RELOCATION_LOCK = threading.Lock()
_RELOCATION_SEQUENCE = 0
_RELOCATION_HISTORY: List[Dict[str, Any]] = []
_RELOCATION_HISTORY_LIMIT = 2048


def _record_relocations(mappings: Sequence[Dict[str, str]]) -> int:
    global _RELOCATION_SEQUENCE
    normalized = []
    for entry in mappings or ():
        if not isinstance(entry, dict):
            continue
        old_path = str(entry.get("relative_path") or "")
        keep_path = str(entry.get("keep_path") or "")
        if old_path and keep_path and old_path != keep_path:
            normalized.append({"relative_path": old_path, "keep_path": keep_path})
    with _RELOCATION_LOCK:
        for mapping in normalized:
            _RELOCATION_SEQUENCE += 1
            _RELOCATION_HISTORY.append({"sequence": _RELOCATION_SEQUENCE, **mapping})
        if len(_RELOCATION_HISTORY) > _RELOCATION_HISTORY_LIMIT:
            del _RELOCATION_HISTORY[:-_RELOCATION_HISTORY_LIMIT]
        return _RELOCATION_SEQUENCE


def relocation_history(after: int = 0) -> Dict[str, Any]:
    try:
        after = max(0, int(after))
    except (TypeError, ValueError):
        after = 0
    with _RELOCATION_LOCK:
        moved = [dict(entry) for entry in _RELOCATION_HISTORY if entry["sequence"] > after]
        return {"sequence": _RELOCATION_SEQUENCE, "moved": moved}


def _normalize_preset_id(value: Any) -> str:
    try:
        return str(uuid.UUID(str(value or "").strip()))
    except (ValueError, AttributeError) as exc:
        raise InvalidLibraryOperation("The character preset ID is invalid.") from exc


def _protected_set(values: Any) -> set:
    if isinstance(values, set):
        values = tuple(values)
    return _normalize_protected_paths(values)


def _validate_unchanged(path: str, expected: os.stat_result, label: str) -> None:
    current = os.lstat(path)
    if (
        stat_module.S_ISLNK(current.st_mode)
        or not stat_module.S_ISREG(current.st_mode)
        or (current.st_dev, current.st_ino) != (expected.st_dev, expected.st_ino)
        or current.st_size != expected.st_size
        or current.st_mtime_ns != expected.st_mtime_ns
    ):
        raise InvalidLibraryOperation(f"The file changed during relocation: {label}")


def _collapse_identical_source(service, source_relative: str, target_relative: str) -> Dict[str, str]:
    """Remove one physical duplicate while preserving exact metadata on rollback."""
    if source_relative == target_relative:
        return {"relative_path": source_relative, "keep_path": target_relative}
    source, source_expected = _regular_input_file(service.input_root, source_relative)
    target, target_expected = _regular_input_file(service.input_root, target_relative)
    if not _same_file_contents(source, target):
        raise InvalidLibraryOperation("The existing destination is not byte-identical to the source.")

    registry = _registry_for_service(service)
    store = service.preset_store
    source_parent = _parent_path(source_relative)
    target_parent = _parent_path(target_relative)
    lock_keys = {
        source_relative.casefold(),
        target_relative.casefold(),
        f"dir:{source_parent.casefold()}",
        f"dir:{target_parent.casefold()}",
    }
    staged = os.path.join(os.path.dirname(source), f".image-conveyor-dedupe-{uuid.uuid4().hex}.tmp")
    mapping = {"relative_path": source_relative, "keep_path": target_relative}

    with ExitStack() as locks:
        for key in sorted(lock_keys):
            locks.enter_context(service._key_lock(service._destination_locks, key))
        _validate_unchanged(source, source_expected, source_relative)
        _validate_unchanged(target, target_expected, target_relative)
        if not _same_file_contents(source, target):
            raise InvalidLibraryOperation("The destination changed while the duplicate was being collapsed.")

        with registry._lock, store._lock:
            registry_before = registry._load_unlocked()
            store_before = store._load_unlocked()
            if getattr(store, "_recovery_pending", False):
                raise InvalidPreset(
                    "Preset storage was malformed; character relocation is blocked until presets are repaired or saved again."
                )
            os.rename(source, staged)
            try:
                registry.relink_paths([mapping])
                store.relink_paths([mapping])
                os.unlink(staged)
            except Exception:
                rollback_errors = []
                try:
                    registry._write_unlocked(registry_before)
                except Exception as exc:
                    rollback_errors.append(f"character registry: {exc}")
                try:
                    store._write_unlocked(store_before)
                except Exception as exc:
                    rollback_errors.append(f"reference presets: {exc}")
                try:
                    if os.path.exists(staged) and not os.path.exists(source):
                        os.rename(staged, source)
                except Exception as exc:
                    rollback_errors.append(f"file restore: {exc}")
                if rollback_errors:
                    LOGGER.critical(
                        "Image Conveyor duplicate-collapse rollback was incomplete for '%s': %s",
                        source_relative,
                        "; ".join(rollback_errors),
                    )
                raise

    _invalidate_library_snapshot(service)
    return mapping


def _digest(path: str, cache: Dict[str, str]) -> str:
    cached = cache.get(path)
    if cached is not None:
        return cached
    stable = stable_file_digest(path)
    value = stable[0] if stable else ""
    cache[path] = value
    return value


def _scan_destination(service, destination_folder: str) -> Dict[int, List[Dict[str, Any]]]:
    destination_directory = _validate_directory(service.input_root, destination_folder)
    try:
        entries = list(os.scandir(destination_directory))
    except FileNotFoundError:
        return {}
    except OSError:
        return {}

    by_size: Dict[int, List[Dict[str, Any]]] = {}
    for entry in entries:
        try:
            if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                continue
            info = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        relative = f"{destination_folder}/{entry.name}" if destination_folder else entry.name
        by_size.setdefault(int(info.st_size), []).append(
            {"name": entry.name, "relative": relative, "absolute": entry.path}
        )
    for candidates in by_size.values():
        candidates.sort(key=lambda item: (item["name"].casefold(), item["name"]))
    return by_size


def _find_identical_destination(
    service,
    source_relative: str,
    destination_folder: str,
    destination_by_size: Dict[int, List[Dict[str, Any]]],
    digest_cache: Dict[str, str],
) -> str:
    source, source_stat = _regular_input_file(service.input_root, source_relative)
    source_digest = _digest(source, digest_cache)
    if not source_digest:
        return ""
    filename = PurePosixPath(source_relative).name
    candidates = []
    for entry in destination_by_size.get(int(source_stat.st_size), []):
        if entry["relative"] == source_relative:
            continue
        candidates.append((entry["name"] != filename, entry["name"].casefold(), entry["name"], entry))
    for _different_name, _folded, _name, entry in sorted(candidates):
        if _digest(entry["absolute"], digest_cache) != source_digest:
            continue
        if _same_file_contents(source, entry["absolute"]):
            return entry["relative"]
    return ""


def relocate_input_files(
    service,
    relative_paths: Sequence[Any],
    destination_subfolder: Any,
    protected_paths=(),
) -> Dict[str, Any]:
    """Move canonical Input images and collapse byte-identical destination or batch duplicates."""
    paths = _normalize_path_batch(relative_paths)
    destination_folder = _normalize_subfolder(destination_subfolder)
    protected = _protected_set(protected_paths)
    destination_by_size = _scan_destination(service, destination_folder)
    digest_cache: Dict[str, str] = {}
    results: Dict[str, Dict[str, Any]] = {}
    mappings: List[Dict[str, str]] = []
    skipped = [
        {"relative_path": path, "reason": "The file is reserved by a queued Conveyor item."}
        for path in paths
        if path in protected
    ]
    move_candidates = []
    duplicate_of: Dict[str, str] = {}
    pending_by_digest: Dict[tuple, str] = {}
    source_absolutes: Dict[str, str] = {}
    deduplicated = 0

    for relative_path in paths:
        if relative_path in protected:
            continue
        try:
            source, source_stat = _regular_input_file(service.input_root, relative_path)
        except FileNotFoundError:
            skipped.append(
                {"relative_path": relative_path, "reason": "The file disappeared before the relocation."}
            )
            continue
        source_absolutes[relative_path] = source
        if _parent_path(relative_path) == destination_folder:
            results[relative_path] = {
                "source_path": relative_path,
                "relative_path": relative_path,
                "moved": False,
                "reused": True,
                "deduplicated": False,
            }
            continue

        identical_target = _find_identical_destination(
            service,
            relative_path,
            destination_folder,
            destination_by_size,
            digest_cache,
        )
        if identical_target:
            try:
                mapping = _collapse_identical_source(service, relative_path, identical_target)
            except (FileNotFoundError, OSError, InvalidLibraryOperation, InvalidInputPath, InvalidPreset) as exc:
                skipped.append({"relative_path": relative_path, "reason": str(exc)})
                continue
            mappings.append(mapping)
            deduplicated += 1
            results[relative_path] = {
                "source_path": relative_path,
                "relative_path": identical_target,
                "moved": True,
                "reused": True,
                "deduplicated": True,
            }
            continue

        source_digest = _digest(source, digest_cache)
        batch_key = (int(source_stat.st_size), source_digest) if source_digest else None
        representative = pending_by_digest.get(batch_key) if batch_key else None
        if representative:
            representative_absolute = source_absolutes.get(representative, "")
            if representative_absolute and _same_file_contents(source, representative_absolute):
                duplicate_of[relative_path] = representative
                continue
        if batch_key:
            pending_by_digest[batch_key] = relative_path
        move_candidates.append(relative_path)

    moved_by_source: Dict[str, str] = {}
    if move_candidates:
        move_result = move_input_files(
            service,
            move_candidates,
            destination_folder,
            protected_paths=(),
            collision_safe=True,
        )
        skipped.extend(move_result.get("skipped", []))
        moved_by_source = {
            entry["relative_path"]: entry["keep_path"]
            for entry in move_result.get("moved", [])
        }
        for old_path in move_candidates:
            new_path = moved_by_source.get(old_path)
            if not new_path:
                continue
            mapping = {"relative_path": old_path, "keep_path": new_path}
            mappings.append(mapping)
            results[old_path] = {
                "source_path": old_path,
                "relative_path": new_path,
                "moved": True,
                "reused": False,
                "deduplicated": False,
            }

    for duplicate_path, representative in duplicate_of.items():
        canonical = moved_by_source.get(representative)
        if not canonical:
            fallback = move_input_files(
                service,
                [duplicate_path],
                destination_folder,
                protected_paths=(),
                collision_safe=True,
            )
            skipped.extend(fallback.get("skipped", []))
            fallback_mapping = next(iter(fallback.get("moved", [])), None)
            if not fallback_mapping:
                continue
            canonical = fallback_mapping["keep_path"]
            mapping = {"relative_path": duplicate_path, "keep_path": canonical}
            mappings.append(mapping)
            results[duplicate_path] = {
                "source_path": duplicate_path,
                "relative_path": canonical,
                "moved": True,
                "reused": False,
                "deduplicated": False,
            }
            continue
        try:
            mapping = _collapse_identical_source(service, duplicate_path, canonical)
        except (FileNotFoundError, OSError, InvalidLibraryOperation, InvalidInputPath, InvalidPreset) as exc:
            skipped.append({"relative_path": duplicate_path, "reason": str(exc)})
            continue
        mappings.append(mapping)
        deduplicated += 1
        results[duplicate_path] = {
            "source_path": duplicate_path,
            "relative_path": canonical,
            "moved": True,
            "reused": True,
            "deduplicated": True,
        }

    _record_relocations(mappings)
    return {
        "files": [results[path] for path in paths if path in results],
        "moved": mappings,
        "skipped": skipped,
        "deduplicated": deduplicated,
    }


def _slot_path(slot: Any) -> str:
    if not isinstance(slot, dict):
        return ""
    annotated = str(slot.get("annotated") or "")
    return annotated[:-len(" [input]")] if annotated.endswith(" [input]") else ""


def materialize_character_files(
    service,
    preset_id: Any,
    relative_paths: Sequence[Any],
    protected_paths=(),
) -> Dict[str, Any]:
    """Move character references into the character's physical folder without creating a copy."""
    registry = _registry_for_service(service)
    presets = service.preset_store.list()
    characters = registry.ensure_for_presets(presets)
    normalized_id = _normalize_preset_id(preset_id)
    character = next((entry for entry in characters if entry["preset_id"] == normalized_id), None)
    if character is None:
        raise InvalidLibraryOperation("Character folder not found. Refresh character presets and try again.")

    result = relocate_input_files(service, relative_paths, character["folder"], protected_paths)
    final_paths = [entry["relative_path"] for entry in result["files"] if entry.get("relative_path")]
    membership_warning = ""
    if final_paths:
        try:
            registry.add_members(normalized_id, final_paths)
        except Exception as exc:
            membership_warning = str(exc)
            LOGGER.exception("Image Conveyor moved character files but could not refresh membership metadata.")
    try:
        refreshed = next(
            entry
            for entry in registry.ensure_for_presets(service.preset_store.list())
            if entry["preset_id"] == normalized_id
        )
        members = list(refreshed.get("members", []))
    except Exception:
        members = list(final_paths)
    return {
        "preset_id": normalized_id,
        "folder": character["folder"],
        "files": result["files"],
        "moved": result["moved"],
        "skipped": result["skipped"],
        "deduplicated": result["deduplicated"],
        "members": members,
        "membership_warning": membership_warning,
    }


def _record_character_folder(relative_path: str) -> str:
    parts = str(relative_path or "").split("/")
    if len(parts) < 3 or parts[0] != CHARACTER_FOLDER_ROOT:
        return ""
    return f"{parts[0]}/{parts[1]}"


def _collapse_orphan_character_duplicates(
    service,
    characters,
    protected_paths=(),
) -> Dict[str, List[Dict[str, str]]]:
    """Repair copy-era duplicates without touching currently queued canonical sources."""
    protected = _protected_set(protected_paths)
    records, _version, _scanned_at = service.list_files(force=True)
    character_targets: Dict[str, List[Any]] = {}
    outside_by_size: Dict[int, List[Any]] = {}
    for record in records:
        character_folder = _record_character_folder(record.relative_path)
        if character_folder:
            character_targets.setdefault(character_folder, []).append(record)
        else:
            outside_by_size.setdefault(int(record.size), []).append(record)

    digest_cache: Dict[str, str] = {}
    removed = set()
    deferred = set()
    mappings: List[Dict[str, str]] = []
    skipped: List[Dict[str, str]] = []
    for character in characters:
        for target_record in character_targets.get(character["folder"], []):
            target_relative = target_record.relative_path
            target_absolute = os.path.join(service.input_root, *target_relative.split("/"))
            if not _regular_existing_target(target_absolute):
                continue
            target_digest = _digest(target_absolute, digest_cache)
            if not target_digest:
                continue
            for candidate in outside_by_size.get(int(target_record.size), []):
                source_relative = candidate.relative_path
                if source_relative in removed or source_relative in deferred:
                    continue
                source_absolute = os.path.join(service.input_root, *source_relative.split("/"))
                if not _regular_existing_target(source_absolute):
                    continue
                if _digest(source_absolute, digest_cache) != target_digest:
                    continue
                if not _same_file_contents(source_absolute, target_absolute):
                    continue
                if source_relative in protected:
                    deferred.add(source_relative)
                    skipped.append(
                        {
                            "relative_path": source_relative,
                            "reason": "The file is reserved by a queued Conveyor item.",
                        }
                    )
                    continue
                try:
                    mapping = _collapse_identical_source(service, source_relative, target_relative)
                except (FileNotFoundError, OSError, InvalidLibraryOperation, InvalidInputPath, InvalidPreset) as exc:
                    LOGGER.warning(
                        "Image Conveyor could not collapse legacy character duplicate '%s': %s",
                        source_relative,
                        exc,
                    )
                    continue
                removed.add(source_relative)
                mappings.append(mapping)
    _record_relocations(mappings)
    return {"moved": mappings, "skipped": skipped}


def migrate_character_libraries(service, protected_paths=()) -> Dict[str, Any]:
    """Retroactively move saved character members/reference slots and remove copy-era duplicates."""
    protected = _protected_set(protected_paths)
    protected_sequence = tuple(protected)
    registry = _registry_for_service(service)
    presets = service.preset_store.list()
    characters = registry.ensure_for_presets(presets)
    presets_by_id = {preset["id"]: preset for preset in presets}
    all_moved, all_skipped = [], []
    migrated_files = deduplicated = 0

    for character in characters:
        preset = presets_by_id.get(character["preset_id"])
        candidates, seen = [], set()
        paths = list(character.get("members", [])) + [
            _slot_path(slot)
            for slot in (preset or {}).get("slots", [])
        ]
        for path in paths:
            path = str(path or "")
            if not path or path in seen:
                continue
            seen.add(path)
            if path == character["folder"] or path.startswith(f"{character['folder']}/"):
                continue
            try:
                _regular_input_file(service.input_root, path)
            except FileNotFoundError:
                continue
            candidates.append(path)
        if not candidates:
            continue
        result = materialize_character_files(
            service,
            character["preset_id"],
            candidates,
            protected_sequence,
        )
        migrated_files += len(result["files"])
        deduplicated += int(result.get("deduplicated", 0) or 0)
        all_moved.extend(result.get("moved", []))
        all_skipped.extend(result.get("skipped", []))

    refreshed = registry.ensure_for_presets(service.preset_store.list())
    orphan_result = _collapse_orphan_character_duplicates(service, refreshed, protected_sequence)
    orphan_mappings = orphan_result["moved"]
    all_moved.extend(orphan_mappings)
    all_skipped.extend(orphan_result["skipped"])
    deduplicated += len(orphan_mappings)
    migrated_files += len(orphan_mappings)
    return {
        "migrated_files": migrated_files,
        "deduplicated": deduplicated,
        "moved": all_moved,
        "skipped": all_skipped,
        "characters": registry.ensure_for_presets(service.preset_store.list()),
    }


def register_drag_routes() -> None:
    global _DRAG_ROUTES_REGISTERED
    if _DRAG_ROUTES_REGISTERED:
        return
    import folder_paths
    import server as server_module
    from aiohttp import web
    from server import PromptServer

    if getattr(server_module, _DRAG_ROUTES_MARKER, False):
        _DRAG_ROUTES_REGISTERED = True
        return
    routes = PromptServer.instance.routes

    async def relocation_response(request, *, character_id=None):
        service = get_service(folder_paths)
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise InvalidLibraryOperation("The relocation request is malformed.")
            if character_id is None:
                result = await asyncio.to_thread(
                    relocate_input_files,
                    service,
                    payload.get("relative_paths"),
                    payload.get("destination_subfolder", ""),
                    payload.get("protected_paths", ()),
                )
            else:
                result = await asyncio.to_thread(
                    materialize_character_files,
                    service,
                    character_id,
                    payload.get("relative_paths"),
                    payload.get("protected_paths", ()),
                )
            return web.json_response(result)
        except web.HTTPBadRequest as exc:
            return web.json_response({"error": exc.reason or "A JSON request body is required."}, status=400)
        except FileNotFoundError:
            return web.json_response({"error": "A selected input image no longer exists."}, status=409)
        except (
            InvalidLibraryOperation,
            InvalidUpload,
            InvalidInputPath,
            InvalidPreset,
            json.JSONDecodeError,
            ValueError,
        ) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception:
            LOGGER.exception("Image Conveyor failed to relocate input files.")
            return web.json_response({"error": "Unable to relocate the selected input files."}, status=500)

    @routes.post("/image-conveyor/input-files/copy")
    async def image_conveyor_copy_input_files(request):
        # Compatibility URL: semantics are canonical relocation, never physical copying.
        return await relocation_response(request)

    @routes.post("/image-conveyor/character-folders/{preset_id}/materialize")
    async def image_conveyor_materialize_character_files(request):
        return await relocation_response(request, character_id=request.match_info["preset_id"])

    @routes.post("/image-conveyor/character-folders/migrate")
    async def image_conveyor_migrate_character_files(request):
        service = get_service(folder_paths)
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise InvalidLibraryOperation("The character migration request is malformed.")
            result = await asyncio.to_thread(
                migrate_character_libraries,
                service,
                payload.get("protected_paths", ()),
            )
            return web.json_response(result)
        except web.HTTPBadRequest as exc:
            return web.json_response({"error": exc.reason or "A JSON request body is required."}, status=400)
        except (
            InvalidLibraryOperation,
            InvalidUpload,
            InvalidInputPath,
            InvalidPreset,
            json.JSONDecodeError,
            ValueError,
        ) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception:
            LOGGER.exception("Image Conveyor failed to migrate character libraries.")
            return web.json_response({"error": "Unable to migrate existing character libraries."}, status=500)

    @routes.get("/image-conveyor/relocations")
    async def image_conveyor_relocations(request):
        return web.json_response(relocation_history(request.query.get("after", "0")))

    setattr(server_module, _DRAG_ROUTES_MARKER, True)
    _DRAG_ROUTES_REGISTERED = True
