import asyncio
import json
import logging
import os
import shutil
import stat as stat_module
import tempfile
import threading
import time
import uuid
from contextlib import ExitStack
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .image_conveyor_server import (
    InvalidInputPath,
    InvalidPreset,
    InvalidUpload,
    SUPPORTED_IMAGE_EXTENSIONS,
    get_service,
    normalize_relative_path,
)


LOGGER = logging.getLogger(__name__)
CHARACTER_FOLDER_ROOT = "image_conveyor_characters"
REGISTRY_VERSION = 1
MAX_BATCH_ITEMS = 10000
_COPY_CHUNK_SIZE = 1024 * 1024


class InvalidLibraryOperation(ValueError):
    pass


class CharacterFolderRegistry:
    def __init__(self, path: str, input_root: str):
        self.path = path
        self.input_root = os.path.realpath(input_root)
        self._lock = threading.RLock()

    @staticmethod
    def _empty_document() -> Dict[str, Any]:
        return {"version": REGISTRY_VERSION, "characters": {}}

    @staticmethod
    def _safe_character_name(value: Any) -> str:
        raw = " ".join(str(value or "Character").strip().split()) or "Character"
        cleaned = []
        invalid = set('<>:"/\\|?*')
        for character in raw:
            if ord(character) < 32 or ord(character) == 127 or character in invalid:
                cleaned.append("_")
            else:
                cleaned.append(character)
        name = "".join(cleaned).strip(" .") or "Character"
        return name[:72].rstrip(" .") or "Character"

    @staticmethod
    def _normalize_preset_id(value: Any) -> str:
        try:
            return str(uuid.UUID(str(value or "").strip()))
        except (ValueError, AttributeError) as exc:
            raise InvalidLibraryOperation("The character preset ID is invalid.") from exc

    @staticmethod
    def _normalize_members(value: Any) -> List[str]:
        if value is None:
            return []
        if not isinstance(value, list) or len(value) > MAX_BATCH_ITEMS:
            raise InvalidLibraryOperation("The character library member list is malformed or too large.")
        members: List[str] = []
        seen = set()
        for entry in value:
            relative_path = normalize_relative_path(entry)
            if Path(relative_path).suffix.lower() not in SUPPORTED_IMAGE_EXTENSIONS:
                raise InvalidLibraryOperation("A character library member has an unsupported image extension.")
            if relative_path in seen:
                continue
            seen.add(relative_path)
            members.append(relative_path)
        return members

    @staticmethod
    def _normalize_folder(value: Any) -> str:
        folder = normalize_relative_path(value)
        if folder == CHARACTER_FOLDER_ROOT or not folder.startswith(f"{CHARACTER_FOLDER_ROOT}/"):
            raise InvalidLibraryOperation("Character folders must stay under the Image Conveyor character root.")
        return folder

    def _load_unlocked(self) -> Dict[str, Any]:
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
        except FileNotFoundError:
            return self._empty_document()
        if not isinstance(raw, dict) or raw.get("version") != REGISTRY_VERSION:
            raise InvalidLibraryOperation("The character folder registry has an unsupported format.")
        characters = raw.get("characters")
        if not isinstance(characters, dict):
            raise InvalidLibraryOperation("The character folder registry is malformed.")
        normalized: Dict[str, Dict[str, Any]] = {}
        for preset_id, value in characters.items():
            normalized_id = self._normalize_preset_id(preset_id)
            if not isinstance(value, dict):
                raise InvalidLibraryOperation("The character folder registry is malformed.")
            normalized[normalized_id] = {
                "folder": self._normalize_folder(value.get("folder")),
                "members": self._normalize_members(value.get("members", [])),
            }
        return {"version": REGISTRY_VERSION, "characters": normalized}

    def _write_unlocked(self, document: Dict[str, Any]) -> None:
        parent = os.path.dirname(self.path)
        os.makedirs(parent, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".character-folders-", suffix=".tmp", dir=parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(document, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            try:
                directory_fd = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        finally:
            try:
                os.unlink(temporary)
            except OSError:
                pass

    def _new_folder(self, preset_id: str, name: Any) -> str:
        readable = self._safe_character_name(name)
        return f"{CHARACTER_FOLDER_ROOT}/{readable}--{preset_id[:8]}"

    def ensure_for_presets(self, presets: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
        with self._lock:
            document = self._load_unlocked()
            current_ids = set()
            changed = False
            result = []
            for preset in presets:
                preset_id = self._normalize_preset_id(preset.get("id"))
                current_ids.add(preset_id)
                entry = document["characters"].get(preset_id)
                if entry is None:
                    entry = {
                        "folder": self._new_folder(preset_id, preset.get("name")),
                        "members": [],
                    }
                    document["characters"][preset_id] = entry
                    changed = True
                folder = self._normalize_folder(entry["folder"])
                _ensure_directory(self.input_root, folder)
                result.append({
                    "preset_id": preset_id,
                    "name": str(preset.get("name") or ""),
                    "folder": folder,
                    "members": list(entry.get("members", [])),
                })

            stale = [preset_id for preset_id in document["characters"] if preset_id not in current_ids]
            if stale:
                for preset_id in stale:
                    document["characters"].pop(preset_id, None)
                changed = True
            if changed:
                self._write_unlocked(document)
            return result

    def add_members(self, preset_id: Any, relative_paths: Sequence[Any]) -> Dict[str, Any]:
        normalized_id = self._normalize_preset_id(preset_id)
        paths = _normalize_path_batch(relative_paths)
        with self._lock:
            document = self._load_unlocked()
            entry = document["characters"].get(normalized_id)
            if entry is None:
                raise InvalidLibraryOperation("Character folder not found. Refresh character presets and try again.")
            existing = list(entry.get("members", []))
            seen = set(existing)
            added = 0
            for relative_path in paths:
                _regular_input_file(self.input_root, relative_path)
                if relative_path in seen:
                    continue
                seen.add(relative_path)
                existing.append(relative_path)
                added += 1
            if added:
                entry["members"] = existing
                self._write_unlocked(document)
            return {
                "preset_id": normalized_id,
                "folder": entry["folder"],
                "members": list(entry.get("members", [])),
                "added": added,
            }

    def relink_paths(self, replacements: Sequence[Dict[str, str]]) -> int:
        mapping = {
            normalize_relative_path(entry.get("relative_path")): normalize_relative_path(entry.get("keep_path"))
            for entry in replacements
            if isinstance(entry, dict) and entry.get("relative_path") and entry.get("keep_path")
        }
        if not mapping:
            return 0
        with self._lock:
            document = self._load_unlocked()
            changed = 0
            for entry in document["characters"].values():
                next_members = []
                seen = set()
                for relative_path in entry.get("members", []):
                    replacement = mapping.get(relative_path, relative_path)
                    if replacement in seen:
                        if replacement != relative_path:
                            changed += 1
                        continue
                    seen.add(replacement)
                    next_members.append(replacement)
                    if replacement != relative_path:
                        changed += 1
                entry["members"] = next_members
            if changed:
                self._write_unlocked(document)
            return changed

    def remove_paths(self, relative_paths: Iterable[str]) -> int:
        removed = {normalize_relative_path(path) for path in relative_paths}
        if not removed:
            return 0
        with self._lock:
            document = self._load_unlocked()
            changed = 0
            for entry in document["characters"].values():
                before = list(entry.get("members", []))
                after = [path for path in before if path not in removed]
                changed += len(before) - len(after)
                entry["members"] = after
            if changed:
                self._write_unlocked(document)
            return changed


def _registry_for_service(service) -> CharacterFolderRegistry:
    path = os.path.join(os.path.dirname(service.preset_store.path), "character-folders.json")
    return CharacterFolderRegistry(path, service.input_root)


def _normalize_subfolder(value: Any) -> str:
    return normalize_relative_path(value, allow_empty=True)


def _normalize_path_batch(values: Any) -> List[str]:
    if not isinstance(values, (list, tuple)) or len(values) > MAX_BATCH_ITEMS:
        raise InvalidLibraryOperation("The input file selection is malformed or too large.")
    result = []
    seen = set()
    for value in values:
        relative_path = normalize_relative_path(value)
        if Path(relative_path).suffix.lower() not in SUPPORTED_IMAGE_EXTENSIONS:
            raise InvalidLibraryOperation("The input file selection contains an unsupported image type.")
        if relative_path in seen:
            continue
        seen.add(relative_path)
        result.append(relative_path)
    return result


def _normalize_protected_paths(values: Any) -> set:
    if values is None:
        return set()
    return set(_normalize_path_batch(values))


def _ensure_directory(input_root: str, relative_folder: str) -> str:
    folder = _normalize_subfolder(relative_folder)
    root = os.path.realpath(input_root)
    if not folder:
        return root
    current = root
    for segment in folder.split("/"):
        candidate = os.path.join(current, segment)
        try:
            info = os.lstat(candidate)
        except FileNotFoundError:
            try:
                os.mkdir(candidate)
            except FileExistsError:
                info = os.lstat(candidate)
            else:
                info = os.lstat(candidate)
        if stat_module.S_ISLNK(info.st_mode) or not stat_module.S_ISDIR(info.st_mode):
            raise InvalidInputPath("The destination folder contains a symlink or non-directory component.")
        current = candidate
    try:
        if os.path.commonpath((root, os.path.realpath(current))) != root:
            raise InvalidInputPath("The destination folder escapes the ComfyUI input directory.")
    except ValueError as exc:
        raise InvalidInputPath("The destination folder escapes the ComfyUI input directory.") from exc
    return current


def _regular_input_file(input_root: str, relative_path: str) -> Tuple[str, os.stat_result]:
    relative = normalize_relative_path(relative_path)
    if Path(relative).suffix.lower() not in SUPPORTED_IMAGE_EXTENSIONS:
        raise InvalidLibraryOperation("Only supported image files can be moved or deleted.")
    root = os.path.realpath(input_root)
    lexical = os.path.abspath(os.path.join(root, *relative.split("/")))
    try:
        if os.path.commonpath((root, lexical)) != root:
            raise InvalidInputPath("The input path escapes the ComfyUI input directory.")
    except ValueError as exc:
        raise InvalidInputPath("The input path escapes the ComfyUI input directory.") from exc

    current = root
    parts = relative.split("/")
    for segment in parts[:-1]:
        current = os.path.join(current, segment)
        info = os.lstat(current)
        if stat_module.S_ISLNK(info.st_mode) or not stat_module.S_ISDIR(info.st_mode):
            raise InvalidInputPath("The input path contains a symlink or non-directory component.")
    info = os.lstat(lexical)
    if stat_module.S_ISLNK(info.st_mode) or not stat_module.S_ISREG(info.st_mode):
        raise InvalidLibraryOperation("The selected input path is not a regular image file.")
    return lexical, info


def _collision_safe_path(input_root: str, destination_folder: str, filename: str) -> str:
    base = f"{destination_folder}/{filename}" if destination_folder else filename
    candidate = base
    stem, extension = os.path.splitext(filename)
    counter = 1
    while os.path.lexists(os.path.join(input_root, *candidate.split("/"))):
        renamed = f"{stem} ({counter}){extension}"
        candidate = f"{destination_folder}/{renamed}" if destination_folder else renamed
        counter += 1
    return candidate


def _move_no_replace(source: str, destination: str) -> None:
    parent = os.path.dirname(destination)
    os.makedirs(parent, exist_ok=True)
    try:
        os.link(source, destination)
        try:
            os.unlink(source)
        except Exception:
            try:
                os.unlink(destination)
            except OSError:
                pass
            raise
        return
    except FileExistsError:
        raise
    except OSError:
        pass

    source_stat = os.stat(source, follow_symlinks=False)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(destination, flags, stat_module.S_IMODE(source_stat.st_mode) or 0o666)
    try:
        with os.fdopen(descriptor, "wb") as output, open(source, "rb") as incoming:
            shutil.copyfileobj(incoming, output, _COPY_CHUNK_SIZE)
            output.flush()
            os.fsync(output.fileno())
        try:
            shutil.copystat(source, destination, follow_symlinks=False)
        except OSError:
            pass
        os.unlink(source)
    except Exception:
        try:
            os.unlink(destination)
        except OSError:
            pass
        raise


def _rollback_moves(moves: Sequence[Tuple[str, str]]) -> List[str]:
    failures = []
    for source, destination in reversed(moves):
        try:
            if os.path.exists(destination) and not os.path.exists(source):
                _move_no_replace(destination, source)
        except Exception as exc:
            failures.append(f"{destination} -> {source}: {exc}")
    return failures


def _preset_document_with_cleared_paths(store, document: Dict[str, Any], relative_paths: set) -> Tuple[Dict[str, Any], int]:
    next_document = json.loads(json.dumps(document))
    changed = 0
    now = int(time.time() * 1000)
    for preset in next_document.get("presets", []):
        preset_changed = False
        for index, slot in enumerate(preset.get("slots", [])):
            if not slot:
                continue
            annotated = str(slot.get("annotated") or "")
            if not annotated.endswith(" [input]"):
                continue
            if annotated[:-len(" [input]")] not in relative_paths:
                continue
            preset["slots"][index] = None
            changed += 1
            preset_changed = True
        if preset_changed:
            preset["updated_at"] = now
    next_document["presets"] = store._ordered(next_document.get("presets", []))
    return next_document, changed


def _restore_failed_preset_slots(
    store,
    current_document: Dict[str, Any],
    original_document: Dict[str, Any],
    failed_paths: set,
) -> Dict[str, Any]:
    if not failed_paths:
        return current_document
    original_by_id = {preset.get("id"): preset for preset in original_document.get("presets", [])}
    next_document = json.loads(json.dumps(current_document))
    now = int(time.time() * 1000)
    for preset in next_document.get("presets", []):
        original = original_by_id.get(preset.get("id"))
        if not original:
            continue
        changed = False
        original_slots = original.get("slots", [])
        for index, original_slot in enumerate(original_slots):
            if not original_slot:
                continue
            annotated = str(original_slot.get("annotated") or "")
            if annotated.endswith(" [input]") and annotated[:-len(" [input]")] in failed_paths:
                preset["slots"][index] = original_slot
                changed = True
        if changed:
            preset["updated_at"] = now
    next_document["presets"] = store._ordered(next_document.get("presets", []))
    return next_document


def move_input_files(
    service,
    relative_paths: Sequence[Any],
    destination_subfolder: Any,
    protected_paths: Sequence[Any] = (),
    collision_safe: bool = False,
) -> Dict[str, Any]:
    paths = _normalize_path_batch(relative_paths)
    destination_folder = _normalize_subfolder(destination_subfolder)
    protected = _normalize_protected_paths(protected_paths)
    destination_directory = _ensure_directory(service.input_root, destination_folder)
    del destination_directory

    skipped = []
    candidates = [path for path in paths if path not in protected]
    for path in paths:
        if path in protected:
            skipped.append({"relative_path": path, "reason": "The file is reserved by a queued Conveyor item."})

    moved_records: List[Tuple[str, str]] = []
    mappings: List[Dict[str, str]] = []
    with ExitStack() as locks:
        lock_keys = {f"dir:{destination_folder.casefold()}"}
        lock_keys.update(path.casefold() for path in candidates)
        for key in sorted(lock_keys):
            locks.enter_context(service._key_lock(service._destination_locks, key))

        plan = []
        target_paths = set()
        for relative_path in candidates:
            try:
                source, source_stat = _regular_input_file(service.input_root, relative_path)
            except FileNotFoundError:
                skipped.append({"relative_path": relative_path, "reason": "The file disappeared before the move."})
                continue
            filename = PurePosixPath(relative_path).name
            direct_target = f"{destination_folder}/{filename}" if destination_folder else filename
            if direct_target == relative_path:
                skipped.append({"relative_path": relative_path, "reason": "The file is already in that folder."})
                continue
            target_relative = _collision_safe_path(service.input_root, destination_folder, filename) if collision_safe else direct_target
            target = os.path.abspath(os.path.join(service.input_root, *target_relative.split("/")))
            if target_relative in target_paths:
                if collision_safe:
                    target_relative = _collision_safe_path(service.input_root, destination_folder, filename)
                    target = os.path.abspath(os.path.join(service.input_root, *target_relative.split("/")))
                else:
                    raise InvalidLibraryOperation(f"Multiple selected files would collide at '{target_relative}'.")
            if not collision_safe and os.path.lexists(target):
                raise InvalidLibraryOperation(f"Destination already exists: {target_relative}")
            target_paths.add(target_relative)
            plan.append((relative_path, source, source_stat, target_relative, target))

        try:
            for old_relative, source, source_stat, new_relative, target in plan:
                current = os.lstat(source)
                if (
                    not stat_module.S_ISREG(current.st_mode)
                    or stat_module.S_ISLNK(current.st_mode)
                    or (current.st_dev, current.st_ino) != (source_stat.st_dev, source_stat.st_ino)
                    or current.st_size != source_stat.st_size
                    or current.st_mtime_ns != source_stat.st_mtime_ns
                ):
                    raise InvalidLibraryOperation(f"The file changed during the move: {old_relative}")
                if os.path.lexists(target):
                    if collision_safe:
                        filename = PurePosixPath(old_relative).name
                        new_relative = _collision_safe_path(service.input_root, destination_folder, filename)
                        target = os.path.abspath(os.path.join(service.input_root, *new_relative.split("/")))
                    else:
                        raise InvalidLibraryOperation(f"Destination appeared during the move: {new_relative}")
                _move_no_replace(source, target)
                moved_records.append((source, target))
                mappings.append({"relative_path": old_relative, "keep_path": new_relative})

            presets_relinked = service.preset_store.relink_paths(mappings) if mappings else 0
            registry_relinked = _registry_for_service(service).relink_paths(mappings) if mappings else 0
        except Exception:
            rollback_failures = _rollback_moves(moved_records)
            if rollback_failures:
                LOGGER.critical("Image Conveyor move rollback was incomplete: %s", "; ".join(rollback_failures))
            raise

    if mappings:
        service.invalidate_snapshot()
    return {
        "moved": mappings,
        "skipped": skipped,
        "presets_relinked": presets_relinked if mappings else 0,
        "character_members_relinked": registry_relinked if mappings else 0,
    }


def delete_input_files(
    service,
    relative_paths: Sequence[Any],
    protected_paths: Sequence[Any] = (),
) -> Dict[str, Any]:
    paths = _normalize_path_batch(relative_paths)
    protected = _normalize_protected_paths(protected_paths)
    skipped = []
    candidates = [path for path in paths if path not in protected]
    for path in paths:
        if path in protected:
            skipped.append({"relative_path": path, "reason": "The file is reserved by a queued Conveyor item."})

    staged: List[Tuple[str, str, str, int]] = []
    deleted = []
    store = service.preset_store
    with ExitStack() as locks:
        for key in sorted(path.casefold() for path in candidates):
            locks.enter_context(service._key_lock(service._destination_locks, key))

        validated = []
        for relative_path in candidates:
            try:
                lexical, info = _regular_input_file(service.input_root, relative_path)
            except FileNotFoundError:
                skipped.append({"relative_path": relative_path, "reason": "The file disappeared before deletion."})
                continue
            validated.append((relative_path, lexical, info))

        with store._lock:
            document_before = store._load_unlocked()
            if getattr(store, "_recovery_pending", False):
                raise InvalidPreset(
                    "Preset storage was malformed; physical deletion is blocked until presets are repaired or saved again."
                )
            try:
                for relative_path, lexical, expected in validated:
                    current = os.lstat(lexical)
                    if (
                        not stat_module.S_ISREG(current.st_mode)
                        or stat_module.S_ISLNK(current.st_mode)
                        or (current.st_dev, current.st_ino) != (expected.st_dev, expected.st_ino)
                        or current.st_size != expected.st_size
                        or current.st_mtime_ns != expected.st_mtime_ns
                    ):
                        raise InvalidLibraryOperation(f"The file changed during deletion: {relative_path}")
                    temporary = os.path.join(
                        os.path.dirname(lexical),
                        f".image-conveyor-delete-{uuid.uuid4().hex}.tmp",
                    )
                    os.rename(lexical, temporary)
                    staged.append((relative_path, lexical, temporary, current.st_size))

                cleared_document, presets_cleared = _preset_document_with_cleared_paths(
                    store,
                    document_before,
                    {entry[0] for entry in staged},
                )
                if presets_cleared:
                    store._write_unlocked(cleared_document)
            except Exception:
                rollback_failures = []
                for _relative, lexical, temporary, _size in reversed(staged):
                    try:
                        if os.path.exists(temporary) and not os.path.exists(lexical):
                            os.rename(temporary, lexical)
                    except Exception as exc:
                        rollback_failures.append(f"{temporary} -> {lexical}: {exc}")
                if rollback_failures:
                    LOGGER.critical("Image Conveyor delete staging rollback was incomplete: %s", "; ".join(rollback_failures))
                raise

            failed_paths = set()
            for relative_path, lexical, temporary, size in staged:
                try:
                    os.unlink(temporary)
                    deleted.append({"relative_path": relative_path, "size": size})
                except OSError as exc:
                    try:
                        os.rename(temporary, lexical)
                        failed_paths.add(relative_path)
                        skipped.append({"relative_path": relative_path, "reason": str(exc)})
                    except OSError as restore_exc:
                        skipped.append({
                            "relative_path": relative_path,
                            "reason": f"Delete failed and restore also failed: {restore_exc}",
                        })
                        LOGGER.critical(
                            "Image Conveyor could not restore staged delete '%s' after unlink failure: %s",
                            temporary,
                            restore_exc,
                        )
            if failed_paths and presets_cleared:
                restored_document = _restore_failed_preset_slots(
                    store,
                    cleared_document,
                    document_before,
                    failed_paths,
                )
                store._write_unlocked(restored_document)

    deleted_paths = [entry["relative_path"] for entry in deleted]
    members_removed = _registry_for_service(service).remove_paths(deleted_paths) if deleted_paths else 0
    if deleted_paths:
        service.invalidate_snapshot()
    return {
        "deleted": deleted,
        "skipped": skipped,
        "presets_cleared": presets_cleared if staged else 0,
        "character_members_removed": members_removed,
        "reclaimed_bytes": sum(entry["size"] for entry in deleted),
    }


def list_input_directories(input_root: str) -> List[str]:
    root = os.path.realpath(input_root)
    directories = []
    stack = [(root, "")]
    while stack:
        directory, relative = stack.pop()
        try:
            entries = list(os.scandir(directory))
        except (FileNotFoundError, PermissionError, OSError):
            continue
        entries.sort(key=lambda entry: entry.name.casefold(), reverse=True)
        for entry in entries:
            if entry.name.startswith("."):
                continue
            try:
                if not entry.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            child = f"{relative}/{entry.name}" if relative else entry.name
            child = child.replace("\\", "/")
            directories.append(child)
            stack.append((entry.path, child))
    directories.sort(key=lambda value: (value.casefold(), value))
    return directories


def register_library_routes() -> None:
    import folder_paths
    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/image-conveyor/input-directories")
    async def image_conveyor_input_directories(_request):
        service = get_service(folder_paths)
        try:
            directories = await asyncio.to_thread(list_input_directories, service.input_root)
            return web.json_response({"directories": directories})
        except Exception:
            LOGGER.exception("Image Conveyor failed to enumerate input directories.")
            return web.json_response({"error": "Unable to enumerate input directories."}, status=500)

    @routes.post("/image-conveyor/input-files/move")
    async def image_conveyor_move_input_files(request):
        service = get_service(folder_paths)
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise InvalidLibraryOperation("The move request is malformed.")
            result = await asyncio.to_thread(
                move_input_files,
                service,
                payload.get("relative_paths"),
                payload.get("destination_subfolder", ""),
                payload.get("protected_paths", []),
                bool(payload.get("collision_safe", False)),
            )
            return web.json_response(result)
        except (InvalidLibraryOperation, InvalidUpload, InvalidInputPath, InvalidPreset, json.JSONDecodeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception:
            LOGGER.exception("Image Conveyor failed to move input files.")
            return web.json_response({"error": "Unable to move the selected input files."}, status=500)

    @routes.post("/image-conveyor/input-files/delete")
    async def image_conveyor_delete_input_files(request):
        service = get_service(folder_paths)
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise InvalidLibraryOperation("The delete request is malformed.")
            result = await asyncio.to_thread(
                delete_input_files,
                service,
                payload.get("relative_paths"),
                payload.get("protected_paths", []),
            )
            return web.json_response(result)
        except (InvalidLibraryOperation, InvalidUpload, InvalidInputPath, InvalidPreset, json.JSONDecodeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception:
            LOGGER.exception("Image Conveyor failed to delete input files.")
            return web.json_response({"error": "Unable to delete the selected input files."}, status=500)

    @routes.get("/image-conveyor/character-folders")
    async def image_conveyor_character_folders(_request):
        service = get_service(folder_paths)
        try:
            presets = await asyncio.to_thread(service.preset_store.list)
            registry = _registry_for_service(service)
            characters = await asyncio.to_thread(registry.ensure_for_presets, presets)
            return web.json_response({"characters": characters})
        except (InvalidLibraryOperation, InvalidInputPath, InvalidPreset, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception:
            LOGGER.exception("Image Conveyor failed to prepare character folders.")
            return web.json_response({"error": "Unable to prepare character folders."}, status=500)

    @routes.post("/image-conveyor/character-folders/{preset_id}/members")
    async def image_conveyor_add_character_members(request):
        service = get_service(folder_paths)
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise InvalidLibraryOperation("The character library request is malformed.")
            registry = _registry_for_service(service)
            result = await asyncio.to_thread(
                registry.add_members,
                request.match_info["preset_id"],
                payload.get("relative_paths"),
            )
            return web.json_response(result)
        except FileNotFoundError:
            return web.json_response({"error": "A character library image no longer exists."}, status=409)
        except (InvalidLibraryOperation, InvalidInputPath, InvalidPreset, json.JSONDecodeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception:
            LOGGER.exception("Image Conveyor failed to update character library membership.")
            return web.json_response({"error": "Unable to update the character library."}, status=500)
