import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path, PurePosixPath
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_NAME = "image_conveyor_ops_testpkg"


def load_modules():
    package = types.ModuleType(PACKAGE_NAME)
    package.__path__ = [str(ROOT)]
    sys.modules[PACKAGE_NAME] = package

    server_name = f"{PACKAGE_NAME}.image_conveyor_server"
    server_spec = importlib.util.spec_from_file_location(server_name, ROOT / "image_conveyor_server.py")
    server = importlib.util.module_from_spec(server_spec)
    sys.modules[server_name] = server
    server_spec.loader.exec_module(server)

    ops_name = f"{PACKAGE_NAME}.image_conveyor_library_ops"
    ops_spec = importlib.util.spec_from_file_location(ops_name, ROOT / "image_conveyor_library_ops.py")
    ops = importlib.util.module_from_spec(ops_spec)
    sys.modules[ops_name] = ops
    ops_spec.loader.exec_module(ops)
    return server, ops


server, ops = load_modules()


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
    if len(values) > 8:
        raise ValueError("reference test fixture exceeds the eight-slot preset contract")
    return values + [None] * (8 - len(values))


class InputLibraryOperationsTest(unittest.TestCase):
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
        self.registry = ops._registry_for_service(self.service)

    def write_image(self, relative_path, payload=b"image-bytes"):
        path = self.input_root / Path(relative_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return path

    def test_registry_instances_share_the_same_lock_for_one_store(self):
        self.assertIs(self.registry._lock, ops._registry_for_service(self.service)._lock)

    def test_registry_rejects_unsupported_version(self):
        registry_path = Path(self.registry.path)
        registry_path.parent.mkdir(parents=True, exist_ok=True)
        registry_path.write_text(json.dumps({"version": ops.REGISTRY_VERSION + 1, "characters": {}}), encoding="utf-8")
        with self.assertRaises(ops.InvalidLibraryOperation):
            self.registry._load_unlocked()

    def test_character_folder_is_created_once_and_survives_rename_and_delete(self):
        preset = self.service.preset_store.create("Mara", slots())
        characters = self.registry.ensure_for_presets(self.service.preset_store.list())
        self.assertEqual(len(characters), 1)
        folder = characters[0]["folder"]
        self.assertTrue(folder.startswith(f"{ops.CHARACTER_FOLDER_ROOT}/Mara--"))
        self.assertTrue((self.input_root / Path(folder)).is_dir())

        self.service.preset_store.update(preset["id"], name="Mara Renamed")
        renamed = self.registry.ensure_for_presets(self.service.preset_store.list())
        self.assertEqual(renamed[0]["folder"], folder)

        self.service.preset_store.delete(preset["id"])
        self.assertEqual(self.registry.ensure_for_presets(self.service.preset_store.list()), [])
        self.assertTrue((self.input_root / Path(folder)).is_dir())

    def test_character_members_are_unique_and_validate_existing_files(self):
        file_path = self.write_image("refs/a.png")
        preset = self.service.preset_store.create("Mara", slots())
        self.registry.ensure_for_presets(self.service.preset_store.list())
        result = self.registry.add_members(preset["id"], ["refs/a.png", "refs/a.png"])
        self.assertEqual(result["members"], ["refs/a.png"])
        self.assertEqual(result["added"], 1)
        file_path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.registry.add_members(preset["id"], ["refs/a.png"])
        with self.assertRaises(FileNotFoundError):
            self.registry.add_members(preset["id"], ["refs/missing.png"])

    def test_character_relink_deduplicates_existing_member_and_counts_change_once(self):
        self.write_image("refs/a.png")
        self.write_image("refs/b.png")
        preset = self.service.preset_store.create("Mara", slots())
        self.registry.ensure_for_presets(self.service.preset_store.list())
        self.registry.add_members(preset["id"], ["refs/a.png", "refs/b.png"])

        changed = self.registry.relink_paths([
            {"relative_path": "refs/a.png", "keep_path": "refs/b.png"},
        ])

        self.assertEqual(changed, 1)
        character = self.registry.ensure_for_presets(self.service.preset_store.list())[0]
        self.assertEqual(character["members"], ["refs/b.png"])

    def test_directory_listing_includes_empty_directories(self):
        (self.input_root / "characters" / "empty").mkdir(parents=True)
        self.write_image("nested/deeper/a.png")
        (self.input_root / ".hidden").mkdir()
        directories = ops.list_input_directories(str(self.input_root))
        self.assertIn("characters", directories)
        self.assertIn("characters/empty", directories)
        self.assertIn("nested", directories)
        self.assertIn("nested/deeper", directories)
        self.assertNotIn(".hidden", directories)

    def test_directory_listing_cache_is_reused_and_explicitly_invalidated(self):
        (self.input_root / "one").mkdir()
        first = ops.list_input_directories(str(self.input_root))
        self.assertEqual(first, ["one"])

        (self.input_root / "two").mkdir()
        with mock.patch.object(ops.os, "scandir", side_effect=AssertionError("cache should be reused")):
            self.assertEqual(ops.list_input_directories(str(self.input_root)), ["one"])

        ops._invalidate_input_directory_cache(str(self.input_root))
        self.assertEqual(ops.list_input_directories(str(self.input_root)), ["one", "two"])

    def test_move_relinks_saved_reference_and_character_membership(self):
        source = self.write_image("source/a.png")
        preset = self.service.preset_store.create("Mara", slots(reference("source/a.png")))
        self.registry.ensure_for_presets(self.service.preset_store.list())
        self.registry.add_members(preset["id"], ["source/a.png"])

        result = ops.move_input_files(self.service, ["source/a.png"], "characters/mara")
        self.assertEqual(result["moved"], [{"relative_path": "source/a.png", "keep_path": "characters/mara/a.png"}])
        self.assertFalse(source.exists())
        self.assertTrue((self.input_root / "characters" / "mara" / "a.png").is_file())
        saved = self.service.preset_store.list()[0]
        self.assertEqual(saved["slots"][0]["annotated"], "characters/mara/a.png [input]")
        character = self.registry.ensure_for_presets(self.service.preset_store.list())[0]
        self.assertEqual(character["members"], ["characters/mara/a.png"])

    def test_move_rolls_back_file_and_character_metadata_if_preset_write_fails(self):
        source = self.write_image("source/a.png", b"payload")
        preset = self.service.preset_store.create("Mara", slots(reference("source/a.png")))
        self.registry.ensure_for_presets(self.service.preset_store.list())
        self.registry.add_members(preset["id"], ["source/a.png"])

        with mock.patch.object(
            self.service.preset_store,
            "_write_unlocked",
            side_effect=OSError("preset storage locked"),
        ):
            with self.assertRaises(OSError):
                ops.move_input_files(self.service, ["source/a.png"], "destination")

        destination = self.input_root / "destination" / "a.png"
        self.assertTrue(source.is_file())
        self.assertEqual(source.read_bytes(), b"payload")
        self.assertFalse(destination.exists())
        saved = self.service.preset_store.list()[0]
        self.assertEqual(saved["slots"][0]["annotated"], "source/a.png [input]")
        character = self.registry.ensure_for_presets(self.service.preset_store.list())[0]
        self.assertEqual(character["members"], ["source/a.png"])

    def test_move_protects_queued_paths_without_creating_destination(self):
        source = self.write_image("source/a.png")
        result = ops.move_input_files(
            self.service,
            ["source/a.png"],
            "destination",
            protected_paths=["source/a.png"],
        )
        self.assertEqual(result["moved"], [])
        self.assertEqual(len(result["skipped"]), 1)
        self.assertTrue(source.is_file())
        self.assertFalse((self.input_root / "destination").exists())

    def test_move_missing_sources_does_not_create_destination(self):
        result = ops.move_input_files(self.service, ["source/missing.png"], "destination")
        self.assertEqual(result["moved"], [])
        self.assertEqual(len(result["skipped"]), 1)
        self.assertFalse((self.input_root / "destination").exists())

    def test_manual_move_collision_is_all_or_nothing(self):
        first = self.write_image("one/a.png", b"one")
        second = self.write_image("two/b.png", b"two")
        existing = self.write_image("dest/a.png", b"existing")
        with self.assertRaises(ops.InvalidLibraryOperation):
            ops.move_input_files(self.service, ["one/a.png", "two/b.png"], "dest")
        self.assertEqual(first.read_bytes(), b"one")
        self.assertEqual(second.read_bytes(), b"two")
        self.assertEqual(existing.read_bytes(), b"existing")
        self.assertFalse((self.input_root / "dest" / "b.png").exists())

    def test_collision_safe_move_reserves_names_inside_the_same_batch(self):
        self.write_image("one/a.png", b"one")
        self.write_image("two/a.png", b"two")
        result = ops.move_input_files(
            self.service,
            ["one/a.png", "two/a.png"],
            "dest",
            collision_safe=True,
        )
        targets = [entry["keep_path"] for entry in result["moved"]]
        self.assertEqual(targets, ["dest/a.png", "dest/a (1).png"])
        self.assertEqual((self.input_root / "dest" / "a.png").read_bytes(), b"one")
        self.assertEqual((self.input_root / "dest" / "a (1).png").read_bytes(), b"two")

    def test_delete_clears_saved_reference_and_character_membership(self):
        source = self.write_image("source/a.png", b"payload")
        preset = self.service.preset_store.create("Mara", slots(reference("source/a.png")))
        self.registry.ensure_for_presets(self.service.preset_store.list())
        self.registry.add_members(preset["id"], ["source/a.png"])

        result = ops.delete_input_files(self.service, ["source/a.png"])
        self.assertEqual([entry["relative_path"] for entry in result["deleted"]], ["source/a.png"])
        self.assertEqual(result["reclaimed_bytes"], len(b"payload"))
        self.assertFalse(source.exists())
        self.assertIsNone(self.service.preset_store.list()[0]["slots"][0])
        character = self.registry.ensure_for_presets(self.service.preset_store.list())[0]
        self.assertEqual(character["members"], [])

    def test_delete_restores_file_if_preset_write_fails(self):
        source = self.write_image("source/a.png", b"payload")
        self.service.preset_store.create("Mara", slots(reference("source/a.png")))

        with mock.patch.object(
            self.service.preset_store,
            "_write_unlocked",
            side_effect=OSError("preset storage locked"),
        ):
            with self.assertRaises(OSError):
                ops.delete_input_files(self.service, ["source/a.png"])

        self.assertTrue(source.is_file())
        self.assertEqual(source.read_bytes(), b"payload")
        self.assertFalse(any(source.parent.glob(".image-conveyor-delete-*.tmp")))
        saved = self.service.preset_store.list()[0]
        self.assertEqual(saved["slots"][0]["annotated"], "source/a.png [input]")

    def test_delete_unlink_failure_restores_file_and_preset_reference(self):
        source = self.write_image("source/a.png", b"payload")
        self.service.preset_store.create("Mara", slots(reference("source/a.png")))
        real_unlink = os.unlink

        def fail_staged_unlink(path):
            if Path(path).name.startswith(".image-conveyor-delete-"):
                raise OSError("file is busy")
            return real_unlink(path)

        with mock.patch.object(ops.os, "unlink", side_effect=fail_staged_unlink):
            result = ops.delete_input_files(self.service, ["source/a.png"])

        self.assertEqual(result["deleted"], [])
        self.assertEqual(result["presets_cleared"], 0)
        self.assertEqual(len(result["skipped"]), 1)
        self.assertTrue(source.is_file())
        saved = self.service.preset_store.list()[0]
        self.assertEqual(saved["slots"][0]["annotated"], "source/a.png [input]")

    def test_delete_restore_write_failure_does_not_skip_registry_cleanup(self):
        first = self.write_image("source/a.png", b"a")
        second = self.write_image("source/b.png", b"b")
        preset = self.service.preset_store.create(
            "Mara",
            slots(reference("source/a.png"), reference("source/b.png")),
        )
        self.registry.ensure_for_presets(self.service.preset_store.list())
        self.registry.add_members(preset["id"], ["source/a.png", "source/b.png"])
        real_unlink = os.unlink
        failed_staged_unlink = False

        def fail_first_staged_unlink(path):
            nonlocal failed_staged_unlink
            if Path(path).name.startswith(".image-conveyor-delete-") and not failed_staged_unlink:
                failed_staged_unlink = True
                raise OSError("file is busy")
            return real_unlink(path)

        original_write = self.service.preset_store._write_unlocked
        write_count = 0

        def fail_restore_write(document):
            nonlocal write_count
            write_count += 1
            if write_count == 2:
                raise OSError("restore write failed")
            return original_write(document)

        with mock.patch.object(ops.os, "unlink", side_effect=fail_first_staged_unlink), mock.patch.object(
            self.service.preset_store,
            "_write_unlocked",
            side_effect=fail_restore_write,
        ), self.assertLogs(ops.LOGGER, level="CRITICAL"):
            result = ops.delete_input_files(self.service, ["source/a.png", "source/b.png"])

        self.assertTrue(first.is_file())
        self.assertFalse(second.exists())
        self.assertEqual([entry["relative_path"] for entry in result["deleted"]], ["source/b.png"])
        character = self.registry.ensure_for_presets(self.service.preset_store.list())[0]
        self.assertEqual(character["members"], ["source/a.png"])

    def test_delete_protects_queued_path(self):
        source = self.write_image("source/a.png")
        result = ops.delete_input_files(
            self.service,
            ["source/a.png"],
            protected_paths=["source/a.png"],
        )
        self.assertEqual(result["deleted"], [])
        self.assertEqual(len(result["skipped"]), 1)
        self.assertTrue(source.is_file())

    def test_symlinked_destination_component_is_rejected(self):
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks are unavailable")
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        try:
            os.symlink(outside, self.input_root / "linked", target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation is unavailable")
        self.write_image("source/a.png")
        with self.assertRaises(server.InvalidInputPath):
            ops.move_input_files(self.service, ["source/a.png"], "linked/escape")
        self.assertFalse((outside / "escape" / "a.png").exists())


if __name__ == "__main__":
    unittest.main()
