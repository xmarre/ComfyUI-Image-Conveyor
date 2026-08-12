"""Compatibility helpers for the canonical drag implementation.

Route ownership lives exclusively in :mod:`image_conveyor_drag_v2_ops`.  This
module intentionally exposes no route registrar so importing legacy helpers can
never race or suppress the canonical route set.
"""

import os
import stat as stat_module
from pathlib import PurePosixPath
from typing import Any, Dict, Optional, Sequence


_COPY_CHUNK_SIZE = 1024 * 1024


def _parent_path(relative_path: str) -> str:
    parent = str(PurePosixPath(relative_path).parent)
    return "" if parent == "." else parent


def _regular_existing_target(path: str) -> bool:
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return stat_module.S_ISREG(info.st_mode) and not stat_module.S_ISLNK(info.st_mode)


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


def copy_input_files(
    service,
    relative_paths: Sequence[Any],
    destination_subfolder: Any,
    finalize: Optional[Any] = None,
) -> Dict[str, Any]:
    """Compatibility wrapper for the former copy API.

    Physical copy semantics were intentionally retired.  The compatibility URL
    and this callable now preserve the one-canonical-file invariant by routing to
    canonical relocation.  ``finalize`` is retained only for import compatibility
    and is called with the final canonical paths after a successful relocation.
    """
    from .image_conveyor_drag_v2_ops import relocate_input_files

    result = relocate_input_files(service, relative_paths, destination_subfolder)
    if finalize is not None:
        result["finalized"] = finalize([
            entry["relative_path"]
            for entry in result.get("files", [])
            if entry.get("relative_path")
        ])
    return result


def materialize_character_files(
    service,
    preset_id: Any,
    relative_paths: Sequence[Any],
) -> Dict[str, Any]:
    """Compatibility wrapper for canonical character materialization."""
    from .image_conveyor_drag_v2_ops import materialize_character_files as materialize

    return materialize(service, preset_id, relative_paths)


__all__ = [
    "_parent_path",
    "_regular_existing_target",
    "_same_file_contents",
    "copy_input_files",
    "materialize_character_files",
]
