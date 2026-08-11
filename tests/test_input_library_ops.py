import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path, PurePosixPath


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
            self.registry.add_members(preset["id"], ["refs/missing.png"])

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

    def test_move_protects_queued_paths_without_touching_them(self):
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
        self.assertFalse((self.input_root / "destination" / "a.png").exists())

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
