import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "image_conveyor_character_consistency_testpkg"


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
        "image_conveyor_character_consistency",
    ):
        spec = importlib.util.spec_from_file_location(f"{PACKAGE}.{name}", ROOT / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        result[name] = module
    result["image_conveyor_character_consistency"].install_character_consistency(
        result["image_conveyor_drag_v2_ops"]
    )
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
    return list(values) + [None] * (8 - len(values))


class CharacterConsistencyTest(unittest.TestCase):
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

    def make_shared_reference_state(self):
        owner = self.service.preset_store.create("Owner", slots())
        registry, owner_character = self.character(owner)
        shared_path = f"{owner_character['folder']}/portrait.png"
        self.image(shared_path, b"portrait")
        self.service.preset_store.update(owner["id"], slots=slots(ref(shared_path)))
        registry.add_members(owner["id"], [shared_path])

        stale = self.service.preset_store.create("Stale", slots())
        _registry, stale_character = self.character(stale)
        registry.add_members(stale["id"], [shared_path])
        return registry, owner, owner_character, stale, stale_character, shared_path

    def test_cross_character_reference_is_shared_without_rehoming_the_file(self):
        registry, owner, owner_character, stale, stale_character, shared_path = self.make_shared_reference_state()

        result = drag.materialize_character_files(self.service, stale["id"], [shared_path])

        self.assertTrue((self.input / Path(shared_path)).is_file())
        self.assertFalse((self.input / Path(stale_character["folder"]) / "portrait.png").exists())
        self.assertEqual(result["moved"], [])
        self.assertEqual([entry["relative_path"] for entry in result["shared"]], [shared_path])

        characters = {
            entry["preset_id"]: entry
            for entry in registry.ensure_for_presets(self.service.preset_store.list())
        }
        self.assertIn(shared_path, characters[owner["id"]]["members"])
        self.assertIn(shared_path, characters[stale["id"]]["members"])
        saved_owner = next(entry for entry in self.service.preset_store.list() if entry["id"] == owner["id"])
        self.assertEqual(saved_owner["slots"][0]["annotated"], f"{shared_path} [input]")

    def test_repeated_migration_of_stale_unsaved_preset_state_is_idempotent(self):
        _registry, owner, owner_character, stale, stale_character, shared_path = self.make_shared_reference_state()

        first = drag.migrate_character_libraries(self.service)
        second = drag.migrate_character_libraries(self.service)

        self.assertEqual(first["moved"], [])
        self.assertEqual(second["moved"], [])
        self.assertTrue((self.input / Path(shared_path)).is_file())
        self.assertFalse((self.input / Path(stale_character["folder"]) / "portrait.png").exists())
        saved_owner = next(entry for entry in self.service.preset_store.list() if entry["id"] == owner["id"])
        saved_stale = next(entry for entry in self.service.preset_store.list() if entry["id"] == stale["id"])
        self.assertEqual(saved_owner["slots"][0]["annotated"], f"{shared_path} [input]")
        self.assertIsNone(saved_stale["slots"][0])


if __name__ == "__main__":
    unittest.main()
