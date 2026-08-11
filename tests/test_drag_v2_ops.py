import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path, PurePosixPath
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "image_conveyor_drag_v2_testpkg"


def load_modules():
    package = types.ModuleType(PACKAGE)
    package.__path__ = [str(ROOT)]
    sys.modules[PACKAGE] = package
    result = {}
    for name in (
        "image_conveyor_server",
        "image_conveyor_library_ops",
        "image_conveyor_drag_ops",
        "image_conveyor_drag_v2_ops",
    ):
        spec = importlib.util.spec_from_file_location(f"{PACKAGE}.{name}", ROOT / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        result[name] = module
    return result


mods = load_modules()
server = mods["image_conveyor_server"]
library = mods["image_conveyor_library_ops"]
drag = mods["image_conveyor_drag_v2_ops"]


def ref(path):
    value = PurePosixPath(path)
    parent = "" if str(value.parent) == "." else str(value.parent)
    return {"annotated": f"{path} [input]", "filename": value.name, "subfolder": parent, "type": "input"}


def slots(*values):
    if len(values) > 8:
        raise ValueError("Reference presets contain at most eight slots.")
    return list(values) + [None] * (8 - len(values))


def slot_path(value):
    return value["annotated"][:-len(" [input]")] if value else None


class DragV2OperationsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.input = root / "input"
        self.cache = root / "cache"
        self.input.mkdir()
        self.cache.mkdir()
        self.service = server.InputLibrary(
            str(self.input),
            str(self.cache),
            snapshot_ttl=60.0,
            preset_path=str(root / "user" / "reference-presets.json"),
        )

    def image(self, path, data=b"image"):
        target = self.input / Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target

    def character(self, preset):
        registry = library._registry_for_service(self.service)
        character = next(
            entry
            for entry in registry.ensure_for_presets(self.service.preset_store.list())
            if entry["preset_id"] == preset["id"]
        )
        return registry, character

    def test_slots_reject_more_than_eight_references(self):
        with self.assertRaises(ValueError):
            slots(*[None] * 9)

    def test_relocate_moves_instead_of_copying(self):
        source = self.image("source/a.png", b"payload")
        result = drag.relocate_input_files(self.service, ["source/a.png"], "dest")
        self.assertFalse(source.exists())
        self.assertEqual((self.input / "dest/a.png").read_bytes(), b"payload")
        self.assertEqual(result["moved"], [{"relative_path": "source/a.png", "keep_path": "dest/a.png"}])

    def test_missing_source_is_skipped_without_losing_prior_batch_results(self):
        source = self.image("source/a.png", b"payload")
        result = drag.relocate_input_files(
            self.service,
            ["source/a.png", "source/missing.png"],
            "dest",
        )
        self.assertFalse(source.exists())
        self.assertTrue((self.input / "dest/a.png").is_file())
        self.assertEqual(result["files"][0]["relative_path"], "dest/a.png")
        self.assertEqual(
            [entry["relative_path"] for entry in result["skipped"]],
            ["source/missing.png"],
        )

    def test_identical_destination_is_collapsed_without_suffix(self):
        source = self.image("source/a.png", b"same")
        self.image("dest/a.png", b"same")
        preset = self.service.preset_store.create("Mara", slots(ref("source/a.png")))
        result = drag.relocate_input_files(self.service, ["source/a.png"], "dest")
        self.assertFalse(source.exists())
        self.assertFalse((self.input / "dest/a (1).png").exists())
        self.assertEqual(result["deduplicated"], 1)
        saved = next(entry for entry in self.service.preset_store.list() if entry["id"] == preset["id"])
        self.assertEqual(slot_path(saved["slots"][0]), "dest/a.png")

    def test_same_batch_identical_sources_collapse_to_one_physical_file(self):
        first = self.image("one/a.png", b"same")
        second = self.image("two/b.png", b"same")
        result = drag.relocate_input_files(self.service, ["one/a.png", "two/b.png"], "dest")
        self.assertFalse(first.exists())
        self.assertFalse(second.exists())
        canonical_paths = {entry["relative_path"] for entry in result["files"]}
        self.assertEqual(len(canonical_paths), 1)
        canonical = next(iter(canonical_paths))
        self.assertTrue((self.input / Path(canonical)).is_file())
        self.assertEqual(result["deduplicated"], 1)

    def test_legacy_suffixed_identical_copy_is_reused(self):
        source = self.image("source/a.png", b"same")
        self.image("dest/a.png", b"different")
        self.image("dest/a (1).png", b"same")
        result = drag.relocate_input_files(self.service, ["source/a.png"], "dest")
        self.assertFalse(source.exists())
        self.assertEqual(result["files"][0]["relative_path"], "dest/a (1).png")
        self.assertFalse((self.input / "dest/a (2).png").exists())

    def test_different_collision_keeps_both_different_images(self):
        source = self.image("source/a.png", b"source")
        self.image("dest/a.png", b"different")
        result = drag.relocate_input_files(self.service, ["source/a.png"], "dest")
        self.assertFalse(source.exists())
        self.assertEqual(result["files"][0]["relative_path"], "dest/a (1).png")
        self.assertEqual((self.input / "dest/a (1).png").read_bytes(), b"source")

    def test_relocate_rejects_traversing_destination_without_moving_source(self):
        source = self.image("source/a.png")
        with self.assertRaises(server.InvalidInputPath):
            drag.relocate_input_files(self.service, ["source/a.png"], "../outside")
        self.assertTrue(source.is_file())
        self.assertFalse((Path(self.temp.name) / "outside" / "a.png").exists())

    def test_relocate_rejects_symlinked_destination_component(self):
        source = self.image("source/a.png")
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        link = self.input / "linked"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation is unavailable")
        with self.assertRaises(server.InvalidInputPath):
            drag.relocate_input_files(self.service, ["source/a.png"], "linked")
        self.assertTrue(source.is_file())
        self.assertFalse((outside / "a.png").exists())

    def test_character_materialization_moves_and_relinks_refs(self):
        source = self.image("existing/a.png", b"payload")
        preset = self.service.preset_store.create("Mara", slots(ref("existing/a.png")))
        registry, character = self.character(preset)
        registry.add_members(preset["id"], ["existing/a.png"])
        result = drag.materialize_character_files(self.service, preset["id"], ["existing/a.png"])
        canonical = result["files"][0]["relative_path"]
        self.assertFalse(source.exists())
        self.assertTrue(canonical.startswith(character["folder"] + "/"))
        saved = next(entry for entry in self.service.preset_store.list() if entry["id"] == preset["id"])
        self.assertEqual(slot_path(saved["slots"][0]), canonical)
        refreshed = next(
            entry
            for entry in registry.ensure_for_presets(self.service.preset_store.list())
            if entry["preset_id"] == preset["id"]
        )
        self.assertIn(canonical, refreshed["members"])
        self.assertNotIn("existing/a.png", refreshed["members"])

    def test_materialize_rejects_symlinked_character_folder(self):
        source = self.image("source/a.png")
        preset = self.service.preset_store.create("Mara", slots())
        _registry, character = self.character(preset)
        folder = self.input / Path(character["folder"])
        outside = Path(self.temp.name) / "outside-character"
        outside.mkdir()
        try:
            folder.rmdir()
            folder.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation is unavailable")
        with self.assertRaises(server.InvalidInputPath):
            drag.materialize_character_files(self.service, preset["id"], ["source/a.png"])
        self.assertTrue(source.is_file())
        self.assertFalse((outside / "a.png").exists())

    def test_retroactive_migration_collapses_orphan_copy_era_source(self):
        old_source = self.image("legacy/a.png", b"same")
        preset = self.service.preset_store.create("Mara", slots())
        registry, character = self.character(preset)
        canonical = f"{character['folder']}/a.png"
        self.image(canonical, b"same")
        self.service.preset_store.update(preset["id"], slots=slots(ref(canonical)))
        registry.add_members(preset["id"], [canonical])
        result = drag.migrate_character_libraries(self.service)
        self.assertFalse(old_source.exists())
        self.assertTrue((self.input / Path(canonical)).is_file())
        self.assertTrue(
            any(
                entry["relative_path"] == "legacy/a.png" and entry["keep_path"] == canonical
                for entry in result["moved"]
            )
        )

    def test_orphan_duplicate_collapse_preserves_protected_source(self):
        old_source = self.image("legacy/a.png", b"same")
        preset = self.service.preset_store.create("Mara", slots())
        registry, character = self.character(preset)
        canonical = f"{character['folder']}/a.png"
        self.image(canonical, b"same")
        self.service.preset_store.update(preset["id"], slots=slots(ref(canonical)))
        registry.add_members(preset["id"], [canonical])
        result = drag.migrate_character_libraries(self.service, ["legacy/a.png"])
        self.assertTrue(old_source.is_file())
        self.assertFalse(any(entry["relative_path"] == "legacy/a.png" for entry in result["moved"]))

    def test_protected_character_source_is_not_moved_or_catalogued(self):
        source = self.image("source/a.png")
        preset = self.service.preset_store.create("Mara", slots())
        registry, character = self.character(preset)
        result = drag.materialize_character_files(
            self.service,
            preset["id"],
            ["source/a.png"],
            ["source/a.png"],
        )
        self.assertTrue(source.exists())
        self.assertFalse((self.input / Path(character["folder"]) / "a.png").exists())
        self.assertEqual(result["files"], [])
        self.assertEqual(
            [entry["relative_path"] for entry in result["skipped"]],
            ["source/a.png"],
        )
        refreshed = next(
            entry
            for entry in registry.ensure_for_presets(self.service.preset_store.list())
            if entry["preset_id"] == preset["id"]
        )
        self.assertNotIn("source/a.png", refreshed["members"])

    def test_duplicate_collapse_rolls_back_on_preset_failure(self):
        source = self.image("source/a.png", b"same")
        self.image("dest/a.png", b"same")
        preset = self.service.preset_store.create("Mara", slots(ref("source/a.png")))
        registry, _ = self.character(preset)
        registry.add_members(preset["id"], ["source/a.png"])
        with mock.patch.object(self.service.preset_store, "relink_paths", side_effect=OSError("locked")):
            with self.assertRaises(OSError):
                drag._collapse_identical_source(self.service, "source/a.png", "dest/a.png")
        self.assertTrue(source.exists())
        saved = next(entry for entry in self.service.preset_store.list() if entry["id"] == preset["id"])
        self.assertEqual(slot_path(saved["slots"][0]), "source/a.png")
        refreshed = next(
            entry
            for entry in registry.ensure_for_presets(self.service.preset_store.list())
            if entry["preset_id"] == preset["id"]
        )
        self.assertIn("source/a.png", refreshed["members"])

    def test_relocation_journal_reports_mappings(self):
        self.image("source/a.png")
        before = drag.relocation_history()["sequence"]
        drag.relocate_input_files(self.service, ["source/a.png"], "dest")
        history = drag.relocation_history(before)
        self.assertGreater(history["sequence"], before)
        self.assertEqual(history["moved"][-1]["keep_path"], "dest/a.png")


if __name__ == "__main__":
    unittest.main()
