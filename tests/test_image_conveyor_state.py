import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path


fake_folder_paths = types.ModuleType("folder_paths")
fake_folder_paths.get_annotated_filepath = lambda annotated: annotated
fake_folder_paths.exists_annotated_filepath = lambda annotated: True
sys.modules.setdefault("folder_paths", fake_folder_paths)


class FakeLoadImage:
    def load_image(self, annotated):
        return f"image:{annotated}", f"mask:{annotated}"


fake_nodes = types.ModuleType("nodes")
fake_nodes.LoadImage = FakeLoadImage
sys.modules.setdefault("nodes", fake_nodes)

MODULE_PATH = Path(__file__).resolve().parents[1] / "image_conveyor.py"
SPEC = importlib.util.spec_from_file_location("image_conveyor_under_test", MODULE_PATH)
conveyor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(conveyor)


def item(item_id, annotated, status="pending"):
    return {
        "id": item_id,
        "annotated": annotated,
        "filename": f"{item_id}.png",
        "subfolder": "",
        "source_path": "",
        "type": "input",
        "status": status,
        "added_at": 1,
        "last_queued_at": 0,
        "last_processed_at": 0,
    }


class QueueCompatibilityTest(unittest.TestCase):
    def state(self, items, **options):
        payload = conveyor._default_state()
        payload["items"] = items
        payload.update(options)
        return json.dumps(payload)

    def test_old_v1_state_normalizes_and_selects_next_pending(self):
        raw = self.state([item("done", "done.png [input]", "processed"), item("next", "next.png [input]")])
        state = conveyor._normalize_state(raw)
        index, selected = conveyor._select_item(state, "")
        self.assertEqual(1, index)
        self.assertEqual("next", selected["id"])

    def test_queue_reservation_selects_by_id_with_duplicate_annotated_references(self):
        duplicate_path = "same.png [input]"
        raw = self.state([item("first", duplicate_path), item("second", duplicate_path, "queued")])
        state = conveyor._normalize_state(raw)
        index, selected = conveyor._select_item(
            state, json.dumps({"id": "second", "annotated": duplicate_path})
        )
        self.assertEqual(1, index)
        self.assertEqual("second", selected["id"])

    def test_load_next_reports_processed_delta(self):
        node = conveyor.ImageConveyor()
        raw = self.state([item("one", "one.png [input]"), item("two", "two.png [input]")])
        output = node.load_next(raw)
        self.assertEqual("image:one.png [input]", output["result"][0])
        self.assertEqual(1, output["result"][3])
        self.assertEqual(1, output["result"][4])
        delta = json.loads(output["ui"]["batch_image_loader_delta"][0])
        self.assertEqual("one", delta["processed_item_id"])
        self.assertTrue(delta["consumed"])

    def test_dont_consume_keeps_processed_item_reusable(self):
        node = conveyor.ImageConveyor()
        raw = self.state([item("one", "one.png [input]", "processed")], dont_consume=True)
        output = node.load_next(raw)
        delta = json.loads(output["ui"]["batch_image_loader_delta"][0])
        self.assertFalse(delta["consumed"])
        self.assertEqual(0, output["result"][4])


if __name__ == "__main__":
    unittest.main()
