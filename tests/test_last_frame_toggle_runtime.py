import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from typing import ClassVar
from unittest import mock

from image_conveyor_toggle_runtime import install_toggle_runtime


FILE_PATHS = {}
EXISTING_ANNOTATED = set()

fake_folder_paths = types.ModuleType("folder_paths")
fake_folder_paths.get_annotated_filepath = lambda annotated: FILE_PATHS.get(annotated, annotated)
fake_folder_paths.exists_annotated_filepath = lambda annotated: annotated in EXISTING_ANNOTATED


class FakeLoadImage:
    calls: ClassVar[list[str]] = []

    def load_image(self, annotated):
        self.calls.append(annotated)
        return f"image:{annotated}", f"mask:{annotated}"


fake_nodes = types.ModuleType("nodes")
fake_nodes.LoadImage = FakeLoadImage

MODULE_PATH = Path(__file__).resolve().parents[1] / "image_conveyor.py"
SPEC = importlib.util.spec_from_file_location("image_conveyor_last_frame_runtime_test", MODULE_PATH)
conveyor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
with mock.patch.dict(sys.modules, {"folder_paths": fake_folder_paths, "nodes": fake_nodes}):
    SPEC.loader.exec_module(conveyor)
install_toggle_runtime(conveyor)


def item(item_id, status="pending"):
    return {
        "id": item_id,
        "annotated": f"{item_id}.png [input]",
        "filename": f"{item_id}.png",
        "subfolder": "",
        "source_path": "",
        "type": "input",
        "status": status,
        "added_at": 1,
        "last_queued_at": 0,
        "last_processed_at": 0,
    }


def snapshot(*, queue_slots, members=()):
    members = list(members)
    payload = {
        "main_output_enabled": True,
        "last_frame_output_enabled": True,
        "reference_output_slots": [],
        "queue_output_slots": list(queue_slots),
    }
    if members:
        payload.update({
            "id": members[0]["id"],
            "annotated": members[0]["annotated"],
        })
        if len(members) > 1:
            payload["items"] = [
                {"id": member["id"], "annotated": member["annotated"]}
                for member in members
            ]
    return json.dumps(payload)


class LastFrameToggleRuntimeIntegrationTests(unittest.TestCase):
    def setUp(self):
        FILE_PATHS.clear()
        EXISTING_ANNOTATED.clear()
        FakeLoadImage.calls.clear()
        self.temp_dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp_dir.cleanup()

    def state(self, entries=(), **options):
        payload = conveyor._default_state()
        payload["items"] = list(entries)
        payload.update(options)
        return json.dumps(payload)

    def materialize_items(self, *entries):
        for entry in entries:
            path = Path(self.temp_dir.name) / f"{len(FILE_PATHS)}.img"
            path.write_bytes(entry["id"].encode())
            FILE_PATHS[entry["annotated"]] = str(path)
            EXISTING_ANNOTATED.add(entry["annotated"])

    def test_disabled_last_frame_cannot_be_reenabled_by_stale_two_role_snapshot(self):
        first = item("A")
        second = item("B")
        self.materialize_items(first, second)
        raw = self.state(
            [first, second],
            output_mode="persistent_refs",
            main_output_enabled=True,
            last_frame_output_enabled=False,
        )
        queued = snapshot(queue_slots=[0, 1], members=[first, second])

        self.assertIs(True, conveyor.ImageConveyor.VALIDATE_INPUTS(raw, queue_item_json=queued))
        output = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)
        result = output["result"]
        self.assertEqual("image:A.png [input]", result[0])
        self.assertIsNone(result[14])
        self.assertEqual(["A.png [input]"], FakeLoadImage.calls)
        delta = json.loads(output["ui"]["batch_image_loader_delta"][0])
        self.assertEqual(["A"], [entry["id"] for entry in delta["processed_items"]])

    def test_disabled_main_preserves_last_frame_role_position_in_stale_snapshot(self):
        first = item("A")
        second = item("B")
        self.materialize_items(first, second)
        raw = self.state(
            [first, second],
            output_mode="persistent_refs",
            main_output_enabled=False,
            last_frame_output_enabled=True,
        )
        queued = snapshot(queue_slots=[0, 1], members=[first, second])

        self.assertIs(True, conveyor.ImageConveyor.VALIDATE_INPUTS(raw, queue_item_json=queued))
        output = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)
        result = output["result"]
        self.assertIsNone(result[0])
        self.assertIsNone(result[1])
        self.assertEqual("", result[2])
        self.assertEqual(0, result[3])
        self.assertEqual("image:B.png [input]", result[14])
        self.assertEqual(["B.png [input]"], FakeLoadImage.calls)
        delta = json.loads(output["ui"]["batch_image_loader_delta"][0])
        self.assertEqual(["B"], [entry["id"] for entry in delta["processed_items"]])

    def test_disabling_both_queue_roles_ignores_stale_reservation_entirely(self):
        first = item("A")
        second = item("B")
        raw = self.state(
            [],
            output_mode="persistent_refs",
            main_output_enabled=False,
            last_frame_output_enabled=False,
        )
        queued = snapshot(queue_slots=[0, 1], members=[first, second])

        self.assertIs(True, conveyor.ImageConveyor.VALIDATE_INPUTS(raw, queue_item_json=queued))
        output = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)
        result = output["result"]
        self.assertIsNone(result[0])
        self.assertIsNone(result[14])
        self.assertEqual([], FakeLoadImage.calls)
        self.assertEqual({}, output["ui"])

    def test_legacy_state_keeps_explicit_two_role_snapshot_behavior(self):
        first = item("A")
        second = item("B")
        self.materialize_items(first, second)
        raw = self.state([first, second], output_mode="persistent_refs")
        queued = snapshot(queue_slots=[0, 1], members=[first, second])

        output = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)
        result = output["result"]
        self.assertEqual("image:A.png [input]", result[0])
        self.assertEqual("image:B.png [input]", result[14])
        self.assertEqual(["A.png [input]", "B.png [input]"], FakeLoadImage.calls)

    def test_queue_group_mapping_ignores_persistent_toggle_state(self):
        first = item("A")
        second = item("B")
        self.materialize_items(first, second)
        raw = self.state(
            [first, second],
            output_mode="queue_group",
            images_per_execution=2,
            main_output_enabled=False,
            last_frame_output_enabled=False,
        )
        queued = json.dumps({
            **first,
            "items": [first, second],
        })

        output = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)
        result = output["result"]
        self.assertEqual("image:A.png [input]", result[0])
        self.assertEqual("image:B.png [input]", result[14])
        self.assertEqual(["A.png [input]", "B.png [input]"], FakeLoadImage.calls)

    def test_filtered_stale_snapshot_rejects_ambiguous_reservation_cardinality(self):
        first = item("A")
        self.materialize_items(first)
        raw = self.state(
            [first],
            output_mode="persistent_refs",
            main_output_enabled=True,
            last_frame_output_enabled=False,
        )
        queued = snapshot(queue_slots=[0, 1], members=[first])

        self.assertEqual(
            "Image Conveyor: queued image reservation does not match the queue output snapshot. Queue this prompt again.",
            conveyor.ImageConveyor.VALIDATE_INPUTS(raw, queue_item_json=queued),
        )


if __name__ == "__main__":
    unittest.main()
