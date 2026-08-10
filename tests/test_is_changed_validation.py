import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


FILE_PATHS = {}
EXISTING_ANNOTATED = set()

fake_folder_paths = types.ModuleType("folder_paths")
fake_folder_paths.get_annotated_filepath = lambda annotated: FILE_PATHS.get(annotated, annotated)
fake_folder_paths.exists_annotated_filepath = lambda annotated: annotated in EXISTING_ANNOTATED


class FakeLoadImage:
    def load_image(self, annotated):
        return f"image:{annotated}", f"mask:{annotated}"


fake_nodes = types.ModuleType("nodes")
fake_nodes.LoadImage = FakeLoadImage

MODULE_PATH = Path(__file__).resolve().parents[1] / "image_conveyor.py"
SPEC = importlib.util.spec_from_file_location("image_conveyor_validation_test", MODULE_PATH)
conveyor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
with mock.patch.dict(sys.modules, {"folder_paths": fake_folder_paths, "nodes": fake_nodes}):
    SPEC.loader.exec_module(conveyor)


def item(item_id):
    return {
        "id": item_id,
        "annotated": f"{item_id}.png [input]",
        "filename": f"{item_id}.png",
        "subfolder": "",
        "source_path": "",
        "type": "input",
        "status": "pending",
        "added_at": 1,
        "last_queued_at": 0,
        "last_processed_at": 0,
    }


def state(items, images_per_execution):
    payload = conveyor._default_state()
    payload["items"] = items
    payload["images_per_execution"] = images_per_execution
    return json.dumps(payload)


class IsChangedValidationTest(unittest.TestCase):
    def setUp(self):
        FILE_PATHS.clear()
        EXISTING_ANNOTATED.clear()
        self.temp_dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp_dir.cleanup()

    def materialize(self, entry, contents=b"image"):
        path = Path(self.temp_dir.name) / f"{entry['id']}.img"
        path.write_bytes(contents)
        FILE_PATHS[entry["annotated"]] = str(path)
        EXISTING_ANNOTATED.add(entry["annotated"])

    def test_insufficient_group_returns_stable_sentinel_and_validation_message(self):
        raw = state([item("A"), item("B")], 3)

        first = conveyor.ImageConveyor.IS_CHANGED(raw)
        second = conveyor.ImageConveyor.IS_CHANGED(raw)

        self.assertEqual(first, second)
        self.assertEqual(64, len(first))
        self.assertEqual(
            "Image Conveyor: 3 images per execution requested, but only 2 eligible queue images are available.",
            conveyor.ImageConveyor.VALIDATE_INPUTS(raw),
        )

    def test_missing_secondary_file_returns_stable_sentinel_and_validation_message(self):
        a = item("A")
        b = item("B")
        self.materialize(a)
        raw = state([a, b], 2)

        first = conveyor.ImageConveyor.IS_CHANGED(raw)
        second = conveyor.ImageConveyor.IS_CHANGED(raw)

        self.assertEqual(first, second)
        self.assertEqual(64, len(first))
        self.assertEqual(
            "Image Conveyor: missing file 'B.png [input]'.",
            conveyor.ImageConveyor.VALIDATE_INPUTS(raw),
        )


if __name__ == "__main__":
    unittest.main()
