import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path, PurePosixPath
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_NAME = "image_conveyor_drag_testpkg"


def load_modules():
    package = types.ModuleType(PACKAGE_NAME)
    package.__path__ = [str(ROOT)]
    sys.modules[PACKAGE_NAME] = package

    modules = {}
    for short_name in ("image_conveyor_server", "image_conveyor_library_ops", "image_conveyor_drag_ops"):
        full_name = f"{PACKAGE_NAME}.{short_name}"
        spec = importlib.util.spec_from_file_location(full_name, ROOT / f"{short_name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[full_name] = module
        spec.loader.exec_module(module)
        modules[short_name] = module
    return modules


modules = load_modules()
server = modules["image_conveyor_server"]
library = modules["image_conveyor_library_ops"]
drag = modules["image_conveyor_drag_ops"]


def reference(relative_path):
    path = PurePosixPath(relative_path)
    parent = "" if str(path.parent) == "." else str(path.parent)
    return {
        "annotated": f"{relative_path} [input]",
        "filename": path.name,
        "subfolder": parent,
        "type": "input",
    }


def slots(*references):
    values = list(references)
    return values + [None] * (8 - len(values))


class DragOperationsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.input_root = root / "input"
        self.cache_root = root / "cache"
        self.input_root.mkdir()
        self.cache_root.mkdir()
        self.preset_path = root / "user" / "reference-presets.json"
        self.service = server.InputLibrary(
            str(self.input_root),
            str(self.cache_root),
            snapshot_ttl=60.0,
            preset_path=str(self.preset_path),
        )

    def write_image(self, relative_path, payload=b"image-bytes"):
        path = self.input_root / Path(relative_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return path

    def test_copy_keeps_source_and_materializes_destination(self):
        source = self.write_image("source/a.png", b"payload")
        result = drag.copy_input_files(self.service, ["source/a.png"], "dest")
        self.assertTrue(source.is_file())
        self.assertEqual((self.input_root / "dest" / "a.png").read_bytes(), b"payload")
        self.assertEqual(result["files"][0]["relative_path"], "dest/a.png")
        self.assertTrue(result["files"][0]["copied"])

    def test_copy_reuses_identical_direct_target_without_duplicate(self):
        self.write_image("source/a.png", b"same")
        existing = self.write_image("dest/a.png", b"same")
        result = drag.copy_input_files(self.service, ["source/a.png"], "dest")
        self.assertEqual(result["files"][0]["relative_path"], "dest/a.png")
        self.assertFalse(result["files"][0]["copied"])
        self.assertTrue(result["files"][0]["reused"])
        self.assertEqual(existing.read_bytes(), b"same")
        self.assertFalse((self.input_root / "dest" / "a (1).png").exists())

    def test_copy_uses_collision_safe_name_for_different_direct_target(self):
        self.write_image("source/a.png", b"source")
        self.write_image("dest/a.png", b"different")
        result = drag.copy_input_files(self.service, ["source/a.png"], "dest")
        self.assertEqual(result["files"][0]["relative_path"], "dest/a (1).png")
        self.assertEqual((self.input_root / "dest" / "a (1).png").read_bytes(), b"source")

    def test_character_materialization_replaces_old_logical_member_with_physical_copy(self):
        source = self.write_image("existing/a.png", b"payload")
        preset = self.service.preset_store.create("Mara", slots(reference("existing/a.png")))
        registry = library._registry_for_service(self.service)
        registry.ensure_for_presets(self.service.preset_store.list())
        registry.add_members(preset["id"], ["existing/a.png"])

        result = drag.materialize_character_files(self.service, preset["id"], ["existing/a.png"])
        self.assertTrue(source.is_file())
        self.assertEqual(len(result["files"]), 1)
        materialized = result["files"][0]["relative_path"]
        self.assertTrue(materialized.startswith(f"{library.CHARACTER_FOLDER_ROOT}/Mara--"))
        self.assertEqual((self.input_root / Path(materialized)).read_bytes(), b"payload")
        character = registry.ensure_for_presets(self.service.preset_store.list())[0]
        self.assertIn(materialized, character["members"])
        self.assertNotIn("existing/a.png", character["members"])
        self.assertNotEqual(materialized, "existing/a.png")

    def test_character_materialization_reuses_file_already_in_character_folder(self):
        preset = self.service.preset_store.create("Mara", slots())
        registry = library._registry_for_service(self.service)
        character = registry.ensure_for_presets(self.service.preset_store.list())[0]
        relative = f"{character['folder']}/a.png"
        self.write_image(relative, b"payload")
        result = drag.materialize_character_files(self.service, preset["id"], [relative])
        self.assertEqual(result["files"][0]["relative_path"], relative)
        self.assertFalse(result["files"][0]["copied"])
        self.assertFalse((self.input_root / Path(character["folder"]) / "a (1).png").exists())
        character = registry.ensure_for_presets(self.service.preset_store.list())[0]
        self.assertEqual(character["members"], [relative])

    def test_character_registry_failure_rolls_back_new_copy(self):
        self.write_image("source/a.png", b"payload")
        preset = self.service.preset_store.create("Mara", slots())
        registry = library._registry_for_service(self.service)
        character = registry.ensure_for_presets(self.service.preset_store.list())[0]
        with mock.patch.object(drag, "_registry_for_service", return_value=registry):
            with mock.patch.object(registry, "_write_unlocked", side_effect=OSError("registry locked")):
                with self.assertRaises(OSError):
                    drag.materialize_character_files(self.service, preset["id"], ["source/a.png"])
        self.assertFalse((self.input_root / Path(character["folder"]) / "a.png").exists())
        self.assertTrue((self.input_root / "source" / "a.png").is_file())

    def test_batch_copy_rolls_back_prior_copies_on_later_failure(self):
        self.write_image("one/a.png", b"one")
        self.write_image("two/b.png", b"two")
        original = drag._copy_no_replace
        calls = 0

        def fail_second(source, destination):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated copy failure")
            return original(source, destination)

        with mock.patch.object(drag, "_copy_no_replace", side_effect=fail_second):
            with self.assertRaises(OSError):
                drag.copy_input_files(self.service, ["one/a.png", "two/b.png"], "dest")
        self.assertFalse((self.input_root / "dest" / "a.png").exists())
        self.assertFalse((self.input_root / "dest" / "b.png").exists())
        self.assertTrue((self.input_root / "one" / "a.png").is_file())
        self.assertTrue((self.input_root / "two" / "b.png").is_file())

    def test_missing_source_does_not_create_destination_folder(self):
        with self.assertRaises(FileNotFoundError):
            drag.copy_input_files(self.service, ["missing/a.png"], "dest")
        self.assertFalse((self.input_root / "dest").exists())


if __name__ == "__main__":
    unittest.main()
