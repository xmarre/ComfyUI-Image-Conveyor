import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_NAME = "image_conveyor_drag_compat_testpkg"


def load_modules():
    package = types.ModuleType(PACKAGE_NAME)
    package.__path__ = [str(ROOT)]
    sys.modules[PACKAGE_NAME] = package
    modules = {}
    for short_name in (
        "image_conveyor_server",
        "image_conveyor_library_ops",
        "image_conveyor_drag_ops",
        "image_conveyor_drag_v2_ops",
    ):
        full_name = f"{PACKAGE_NAME}.{short_name}"
        spec = importlib.util.spec_from_file_location(full_name, ROOT / f"{short_name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[full_name] = module
        spec.loader.exec_module(module)
        modules[short_name] = module
    return modules


modules = load_modules()
server = modules["image_conveyor_server"]
drag = modules["image_conveyor_drag_ops"]


class DragCompatibilityTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.input_root = root / "input"
        self.cache_root = root / "cache"
        self.input_root.mkdir()
        self.cache_root.mkdir()
        self.service = server.InputLibrary(
            str(self.input_root),
            str(self.cache_root),
            snapshot_ttl=60.0,
            preset_path=str(root / "user" / "reference-presets.json"),
        )

    def write_image(self, relative_path, payload=b"image-bytes"):
        path = self.input_root / Path(relative_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return path

    def test_legacy_module_does_not_export_a_route_registrar(self):
        self.assertFalse(hasattr(drag, "register_drag_routes"))

    def test_copy_compatibility_wrapper_relocates_instead_of_duplicating(self):
        source = self.write_image("source/a.png", b"payload")
        result = drag.copy_input_files(self.service, ["source/a.png"], "dest")
        self.assertFalse(source.exists())
        self.assertEqual((self.input_root / "dest" / "a.png").read_bytes(), b"payload")
        self.assertEqual(result["files"][0]["relative_path"], "dest/a.png")

    def test_copy_compatibility_wrapper_rejects_traversal(self):
        source = self.write_image("source/a.png")
        with self.assertRaises(server.InvalidInputPath):
            drag.copy_input_files(self.service, ["source/a.png"], "../outside")
        self.assertTrue(source.is_file())
        self.assertFalse((Path(self.temporary.name) / "outside" / "a.png").exists())

    def test_copy_compatibility_wrapper_rejects_symlinked_destination(self):
        if not hasattr(Path, "symlink_to"):
            self.skipTest("symlinks are unavailable")
        source = self.write_image("source/a.png")
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        link = self.input_root / "linked"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation is unavailable")
        with self.assertRaises(server.InvalidInputPath):
            drag.copy_input_files(self.service, ["source/a.png"], "linked")
        self.assertTrue(source.is_file())
        self.assertFalse((outside / "a.png").exists())


if __name__ == "__main__":
    unittest.main()
