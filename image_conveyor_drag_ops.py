import asyncio
import json
import logging
import os
import shutil
import stat as stat_module
from contextlib import ExitStack
from pathlib import PurePosixPath
from typing import Any, Callable, Dict, List, Optional, Sequence

from .image_conveyor_library_ops import (
    InvalidLibraryOperation,
    _ensure_directory,
    _normalize_path_batch,
    _normalize_subfolder,
    _registry_for_service,
    _regular_input_file,
)
from .image_conveyor_server import (
    InvalidInputPath,
    InvalidPreset,
    InvalidUpload,
    get_service,
)


LOGGER = logging.getLogger(__name__)
_COPY_CHUNK_SIZE = 1024 * 1024
_DRAG_ROUTES_REGISTERED = False
_DRAG_ROUTES_MARKER = "_image_conveyor_drag_routes_registered"


def _parent_path(relative_path: str) -> str:
    parent = str(PurePosixPath(relative_path).parent)
    return "" if parent == "." else parent


def _same_file_contents(left: str, right: str) -> bool:
    try:
        left_stat = os.stat(left, follow_symlinks=False)
        right_stat = os.stat(right, follow_symlinks=False)
    except OSError:
        return False
    if left_stat.st_size != right_stat.st_size:
        return False
    try:
        with open(left, "rb") as left_handle, open(right, "rb") as right_handle:
            while True:
                left_chunk = left_handle.read(_COPY_CHUNK_SIZE)
                right_chunk = right_handle.read(_COPY_CHUNK_SIZE)
                if left_chunk != right_chunk:
                    return False
                if not left_chunk:
                    return True
    except OSError:
        return False


def _copy_no_replace(source: str, destination: str) -> None:
    source_stat = os.stat(source, follow_symlinks=False)
    descriptor = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        stat_module.S_IMODE(source_stat.st_mode) or 0o666,
    )
    try:
        with os.fdopen(descriptor, "wb") as output, open(source, "rb") as incoming:
            shutil.copyfileobj(incoming, output, _COPY_CHUNK_SIZE)
            output.flush()
            os.fsync(output.fileno())
        try:
            shutil.copystat(source, destination, follow_symlinks=False)
        except OSError:
            pass
    except Exception:
        try:
            os.unlink(destination)
        except OSError:
            pass
        raise


def _next_copy_target(
    input_root: str,
    destination_folder: str,
    filename: str,
    reserved: set,
) -> str:
    stem, extension = os.path.splitext(filename)
    counter = 0
    while True:
        candidate_name = filename if counter == 0 else f"{stem} ({counter}){extension}"
        relative = f"{destination_folder}/{candidate_name}" if destination_folder else candidate_name
        key = relative.casefold()
        absolute = os.path.join(input_root, *relative.split("/"))
        if key not in reserved and not os.path.lexists(absolute):
            reserved.add(key)
            return relative
        counter += 1


def _regular_existing_target(path: str) -> bool:
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return stat_module.S_ISREG(info.st_mode) and not stat_module.S_ISLNK(info.st_mode)


def copy_input_files(
    service,
    relative_paths: Sequence[Any],
    destination_subfolder: Any,
    finalize: Optional[Callable[[List[str]], Any]] = None,
) -> Dict[str, Any]:
    """Copy existing Input images into another Input folder without changing sources."""
    paths = _normalize_path_batch(relative_paths)
    destination_folder = _normalize_subfolder(destination_subfolder)
    if not paths:
        finalized = finalize([]) if finalize is not None else None
        return {"files": [], "copied": 0, "finalized": finalized}

    # Validate every source before destination creation, so a malformed/missing batch cannot
    # leave a new empty folder behind.
    prevalidated = []
    for relative_path in paths:
        source, expected = _regular_input_file(service.input_root, relative_path)
        prevalidated.append((relative_path, source, expected))

    copied_records = []
    result_files = []
    finalized = None
    lock_keys = {f"dir:{destination_folder.casefold()}"}
    for relative_path, _source, _expected in prevalidated:
        lock_keys.add(relative_path.casefold())
        lock_keys.add(f"dir:{_parent_path(relative_path).casefold()}")

    with ExitStack() as locks:
        for key in sorted(lock_keys):
            locks.enter_context(service._key_lock(service._destination_locks, key))

        destination_directory = _ensure_directory(service.input_root, destination_folder)
        reserved = set()
        try:
            for relative_path, source, expected in prevalidated:
                current = os.lstat(source)
                if (
                    stat_module.S_ISLNK(current.st_mode)
                    or not stat_module.S_ISREG(current.st_mode)
                    or (current.st_dev, current.st_ino) != (expected.st_dev, expected.st_ino)
                    or current.st_size != expected.st_size
                    or current.st_mtime_ns != expected.st_mtime_ns
                ):
                    raise InvalidLibraryOperation(f"The file changed during the copy: {relative_path}")

                if _parent_path(relative_path) == destination_folder:
                    result_files.append(
                        {
                            "source_path": relative_path,
                            "relative_path": relative_path,
                            "copied": False,
                            "reused": True,
                        }
                    )
                    reserved.add(relative_path.casefold())
                    continue

                filename = PurePosixPath(relative_path).name
                direct_relative = f"{destination_folder}/{filename}" if destination_folder else filename
                direct_absolute = os.path.join(service.input_root, *direct_relative.split("/"))

                if (
                    direct_relative.casefold() not in reserved
                    and _regular_existing_target(direct_absolute)
                    and _same_file_contents(source, direct_absolute)
                ):
                    reserved.add(direct_relative.casefold())
                    result_files.append(
                        {
                            "source_path": relative_path,
                            "relative_path": direct_relative,
                            "copied": False,
                            "reused": True,
                        }
                    )
                    continue

                target_relative = _next_copy_target(
                    service.input_root,
                    destination_folder,
                    filename,
                    reserved,
                )
                target = os.path.abspath(os.path.join(service.input_root, *target_relative.split("/")))
                if os.path.dirname(target) != os.path.abspath(destination_directory):
                    raise InvalidInputPath("The destination path changed during the copy.")
                _copy_no_replace(source, target)
                copied_records.append((target_relative, target))
                result_files.append(
                    {
                        "source_path": relative_path,
                        "relative_path": target_relative,
                        "copied": True,
                        "reused": False,
                    }
                )

            if finalize is not None:
                finalized = finalize([entry["relative_path"] for entry in result_files])
        except Exception:
            rollback_failures = []
            for relative_path, target in reversed(copied_records):
                try:
                    os.unlink(target)
                except FileNotFoundError:
                    pass
                except OSError as exc:
                    rollback_failures.append(f"{relative_path}: {exc}")
            if rollback_failures:
                LOGGER.critical(
                    "Image Conveyor copy rollback was incomplete: %s",
                    "; ".join(rollback_failures),
                )
            service.invalidate_snapshot()
            raise

    if copied_records:
        service.invalidate_snapshot()
    return {
        "files": result_files,
        "copied": len(copied_records),
        "finalized": finalized,
    }


def _replace_character_members_with_materialized_paths(
    registry,
    preset_id: str,
    source_paths: Sequence[str],
    target_paths: Sequence[str],
) -> Dict[str, Any]:
    """Replace logical source memberships with their physical character-folder paths atomically."""
    if len(source_paths) != len(target_paths):
        raise InvalidLibraryOperation("Character materialization produced an inconsistent path mapping.")
    normalized_id = registry._normalize_preset_id(preset_id)
    mapping = dict(zip(source_paths, target_paths))
    with registry._lock:
        document = registry._load_unlocked()
        entry = document["characters"].get(normalized_id)
        if entry is None:
            raise InvalidLibraryOperation("Character folder not found. Refresh character presets and try again.")

        for target_path in target_paths:
            _regular_input_file(registry.input_root, target_path)

        before = list(entry.get("members", []))
        next_members = []
        seen = set()
        for member in before:
            replacement = mapping.get(member, member)
            if replacement in seen:
                continue
            seen.add(replacement)
            next_members.append(replacement)
        for target_path in target_paths:
            if target_path in seen:
                continue
            seen.add(target_path)
            next_members.append(target_path)

        if next_members != before:
            entry["members"] = next_members
            registry._write_unlocked(document)
        return {
            "preset_id": normalized_id,
            "folder": entry["folder"],
            "members": list(next_members),
        }


def materialize_character_files(
    service,
    preset_id: Any,
    relative_paths: Sequence[Any],
) -> Dict[str, Any]:
    """Physically materialize selected Input images inside a character's managed folder."""
    registry = _registry_for_service(service)
    presets = service.preset_store.list()
    characters = registry.ensure_for_presets(presets)
    normalized_id = registry._normalize_preset_id(preset_id)
    character = next((entry for entry in characters if entry["preset_id"] == normalized_id), None)
    if character is None:
        raise InvalidLibraryOperation("Character folder not found. Refresh character presets and try again.")

    source_paths = _normalize_path_batch(relative_paths)
    membership_result = None

    def finalize(target_paths: List[str]):
        nonlocal membership_result
        membership_result = _replace_character_members_with_materialized_paths(
            registry,
            normalized_id,
            source_paths,
            target_paths,
        )
        return membership_result

    result = copy_input_files(
        service,
        source_paths,
        character["folder"],
        finalize=finalize,
    )
    return {
        "preset_id": normalized_id,
        "folder": character["folder"],
        "files": result["files"],
        "copied": result["copied"],
        "members": list((membership_result or {}).get("members", [])),
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

    @routes.post("/image-conveyor/input-files/copy")
    async def image_conveyor_copy_input_files(request):
        service = get_service(folder_paths)
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise InvalidLibraryOperation("The copy request is malformed.")
            result = await asyncio.to_thread(
                copy_input_files,
                service,
                payload.get("relative_paths"),
                payload.get("destination_subfolder", ""),
            )
            return web.json_response(result)
        except (InvalidLibraryOperation, InvalidUpload, InvalidInputPath, InvalidPreset, json.JSONDecodeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except FileNotFoundError:
            return web.json_response({"error": "A selected input image no longer exists."}, status=409)
        except Exception:
            LOGGER.exception("Image Conveyor failed to copy input files.")
            return web.json_response({"error": "Unable to copy the selected input files."}, status=500)

    @routes.post("/image-conveyor/character-folders/{preset_id}/materialize")
    async def image_conveyor_materialize_character_files(request):
        service = get_service(folder_paths)
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise InvalidLibraryOperation("The character materialization request is malformed.")
            result = await asyncio.to_thread(
                materialize_character_files,
                service,
                request.match_info["preset_id"],
                payload.get("relative_paths"),
            )
            return web.json_response(result)
        except FileNotFoundError:
            return web.json_response({"error": "A selected input image no longer exists."}, status=409)
        except (InvalidLibraryOperation, InvalidUpload, InvalidInputPath, InvalidPreset, json.JSONDecodeError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception:
            LOGGER.exception("Image Conveyor failed to materialize character files.")
            return web.json_response({"error": "Unable to materialize the selected character images."}, status=500)

    setattr(server_module, _DRAG_ROUTES_MARKER, True)
    _DRAG_ROUTES_REGISTERED = True
