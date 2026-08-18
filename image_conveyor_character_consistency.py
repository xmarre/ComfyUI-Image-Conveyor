"""Character-reference consistency guards for managed character folders.

The character library uses one physical canonical input file. A reference can be
shared by multiple character presets, so an image already owned by one managed
character folder must not be physically re-homed into another character folder.
"""

from typing import Any, Dict, Sequence

from .image_conveyor_library_ops import (
    _normalize_path_batch,
    _registry_for_service,
    _regular_input_file,
)


_INSTALL_MARKER = "_image_conveyor_character_consistency_installed"


def _managed_character_owner(relative_path: str, characters: Sequence[Dict[str, Any]]) -> str:
    path = str(relative_path or "")
    for character in characters:
        folder = str(character.get("folder") or "")
        if folder and path.startswith(f"{folder}/"):
            return str(character.get("preset_id") or "")
    return ""


def _shared_file(path: str) -> Dict[str, Any]:
    return {
        "source_path": path,
        "relative_path": path,
        "moved": False,
        "reused": True,
        "deduplicated": False,
    }


def install_character_consistency(drag_module) -> None:
    """Patch character materialization before the HTTP routes capture it.

    ``migrate_character_libraries`` resolves ``materialize_character_files``
    through its module globals at call time, so replacing this one function also
    protects retroactive/background migration without duplicating that logic.
    """

    if getattr(drag_module, _INSTALL_MARKER, False):
        return

    original_materialize = drag_module.materialize_character_files

    def materialize_character_files(
        service,
        preset_id: Any,
        relative_paths: Sequence[Any],
        protected_paths=(),
    ) -> Dict[str, Any]:
        normalized_id = drag_module._normalize_preset_id(preset_id)
        paths = _normalize_path_batch(relative_paths)
        protected = drag_module._protected_set(protected_paths)
        registry = _registry_for_service(service)
        presets = service.preset_store.list()
        characters = registry.ensure_for_presets(presets)
        target = next(
            (entry for entry in characters if entry.get("preset_id") == normalized_id),
            None,
        )
        if target is None:
            # Preserve the original error semantics for deleted/stale preset IDs.
            return original_materialize(service, preset_id, paths, protected_paths)

        shared_paths = []
        movable_paths = []
        for path in paths:
            # A protected/queued file must retain the original materialization
            # semantics, including being reported as skipped instead of assigned.
            if path in protected:
                movable_paths.append(path)
                continue
            owner = _managed_character_owner(path, characters)
            if owner and owner != normalized_id:
                try:
                    _regular_input_file(service.input_root, path)
                except FileNotFoundError:
                    # Let the original path handle disappeared files consistently.
                    movable_paths.append(path)
                    continue
                shared_paths.append(path)
            else:
                movable_paths.append(path)

        result = original_materialize(
            service,
            preset_id,
            movable_paths,
            protected_paths,
        )
        if not shared_paths:
            return result

        membership_warning = str(result.get("membership_warning") or "")
        try:
            registry.add_members(normalized_id, shared_paths)
        except Exception as exc:  # pragma: no cover - exercised by existing registry failure paths
            membership_warning = "; ".join(filter(None, (membership_warning, str(exc))))

        shared_files = [_shared_file(path) for path in shared_paths]
        result["shared"] = shared_files

        # ``files`` is the established materialization response consumed by the
        # frontend to populate Reference Shelf slots. Shared canonical files are
        # successful materializations too, even though no physical move occurs.
        # Preserve original request order when movable and shared paths are mixed.
        resolved_by_source = {
            str(entry.get("source_path") or ""): entry
            for entry in list(result.get("files", [])) + shared_files
            if isinstance(entry, dict) and entry.get("source_path")
        }
        result["files"] = [
            resolved_by_source[path]
            for path in paths
            if path in resolved_by_source
        ]

        result["membership_warning"] = membership_warning
        try:
            refreshed = next(
                entry
                for entry in registry.ensure_for_presets(service.preset_store.list())
                if entry.get("preset_id") == normalized_id
            )
            result["members"] = list(refreshed.get("members", []))
        except Exception:
            result["members"] = list(
                dict.fromkeys(list(result.get("members", [])) + shared_paths)
            )
        return result

    drag_module.materialize_character_files = materialize_character_files
    setattr(drag_module, _INSTALL_MARKER, True)
