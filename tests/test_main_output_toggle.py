import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from typing import ClassVar
from unittest import mock


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
SPEC = importlib.util.spec_from_file_location("image_conveyor_main_toggle_test", MODULE_PATH)
conveyor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
with mock.patch.dict(sys.modules, {"folder_paths": fake_folder_paths, "nodes": fake_nodes}):
    SPEC.loader.exec_module(conveyor)


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


def reference(name):
    return {
        "annotated": f"{name}.png [input]",
        "filename": f"{name}.png",
        "subfolder": "",
        "type": "input",
    }


def snapshot(*, main=False, refs=(), queue_slots=None, members=()):
    payload = {
        "main_output_enabled": main,
        "reference_output_slots": list(refs),
    }
    if queue_slots is not None:
        payload["queue_output_slots"] = list(queue_slots)
    members = list(members)
    if members:
        payload.update(members[0])
        if len(members) > 1:
            payload["items"] = members
    return json.dumps(payload)


class MainOutputToggleTest(unittest.TestCase):
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

    def materialize(self, annotated, contents=b"image"):
        path = Path(self.temp_dir.name) / f"{len(FILE_PATHS)}.img"
        path.write_bytes(contents)
        FILE_PATHS[annotated] = str(path)
        EXISTING_ANNOTATED.add(annotated)
        return path

    def materialize_items(self, *entries):
        for entry in entries:
            self.materialize(entry["annotated"], entry["id"].encode())

    def test_legacy_snapshot_keeps_main_enabled(self):
        state = conveyor._normalize_state(self.state())
        self.assertTrue(conveyor._main_output_enabled(state, ""))
        self.assertEqual((0,), conveyor._connected_queue_output_slots(state, ""))
        self.assertEqual(
            (0,),
            conveyor._connected_queue_output_slots(
                state, json.dumps({"reference_output_slots": []})
            ),
        )

    def test_malformed_main_snapshot_is_rejected_for_legacy_prompt(self):
        raw = self.state(output_mode="persistent_refs")
        payload = json.dumps({"main_output_enabled": 0, "reference_output_slots": []})
        self.assertEqual(
            "Image Conveyor: main output enable snapshot is invalid.",
            conveyor.ImageConveyor.VALIDATE_INPUTS(raw, queue_item_json=payload),
        )

    def test_malformed_queue_output_snapshot_is_rejected(self):
        raw = self.state(output_mode="persistent_refs")
        payload = snapshot(main=False, refs=(), queue_slots=[2])
        self.assertEqual(
            "Image Conveyor: queue output connection snapshot is invalid.",
            conveyor.ImageConveyor.VALIDATE_INPUTS(raw, queue_item_json=payload),
        )

    def test_reference_only_executes_with_empty_conveyor(self):
        raw = self.state(output_mode="persistent_refs")
        queued = snapshot(main=False, refs=(), queue_slots=[])
        self.assertIs(True, conveyor.ImageConveyor.VALIDATE_INPUTS(raw, queue_item_json=queued))

        output = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)
        result = output["result"]
        self.assertEqual(15, len(result))
        self.assertIsNone(result[0])
        self.assertIsNone(result[1])
        self.assertEqual("", result[2])
        self.assertEqual(0, result[3])
        self.assertEqual(0, result[4])
        self.assertEqual("", result[5])
        self.assertEqual([None] * 8, list(result[6:14]))
        self.assertIsNone(result[14])
        self.assertEqual({}, output["ui"])
        self.assertEqual([], FakeLoadImage.calls)

    def test_image_only_uses_first_pending_queue_image(self):
        first = item("A")
        self.materialize_items(first)
        raw = self.state([first], output_mode="persistent_refs")
        queued = snapshot(main=True, refs=(), queue_slots=[0], members=[first])

        output = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)
        result = output["result"]
        self.assertEqual("image:A.png [input]", result[0])
        self.assertEqual("mask:A.png [input]", result[1])
        self.assertEqual("A.png [input]", result[2])
        self.assertEqual(1, result[3])
        self.assertIsNone(result[14])
        self.assertEqual(["A.png [input]"], FakeLoadImage.calls)

    def test_last_frame_only_uses_first_pending_and_keeps_main_metadata_neutral(self):
        first = item("A")
        self.materialize_items(first)
        raw = self.state([first], output_mode="persistent_refs")
        queued = snapshot(main=False, refs=(), queue_slots=[1], members=[first])

        output = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)
        result = output["result"]
        self.assertIsNone(result[0])
        self.assertIsNone(result[1])
        self.assertEqual("", result[2])
        self.assertEqual(0, result[3])
        self.assertEqual("", result[5])
        self.assertEqual("image:A.png [input]", result[14])
        self.assertEqual(["A.png [input]"], FakeLoadImage.calls)
        delta = json.loads(output["ui"]["batch_image_loader_delta"][0])
        self.assertEqual(["A"], [entry["id"] for entry in delta["processed_items"]])

    def test_image_and_last_frame_reserve_and_map_two_images(self):
        first = item("A")
        second = item("B")
        self.materialize_items(first, second)
        raw = self.state([first, second], output_mode="persistent_refs")
        queued = snapshot(
            main=True,
            refs=(),
            queue_slots=[0, 1],
            members=[first, second],
        )

        self.assertIs(True, conveyor.ImageConveyor.VALIDATE_INPUTS(raw, queue_item_json=queued))
        output = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)
        result = output["result"]
        self.assertEqual("image:A.png [input]", result[0])
        self.assertEqual("mask:A.png [input]", result[1])
        self.assertEqual("image:B.png [input]", result[14])
        self.assertEqual(0, result[4])
        self.assertEqual(["A.png [input]", "B.png [input]"], FakeLoadImage.calls)
        delta = json.loads(output["ui"]["batch_image_loader_delta"][0])
        self.assertEqual(["A", "B"], [entry["id"] for entry in delta["processed_items"]])

    def test_two_queue_roles_require_two_available_images(self):
        first = item("A")
        raw = self.state([first], output_mode="persistent_refs")
        queued = snapshot(main=True, refs=(), queue_slots=[0, 1])
        self.assertEqual(
            "Image Conveyor: 2 images per execution requested, but only 1 eligible queue images are available.",
            conveyor.ImageConveyor.VALIDATE_INPUTS(raw, queue_item_json=queued),
        )

    def test_reference_only_still_validates_and_loads_active_references(self):
        ref = reference("R1")
        self.materialize(ref["annotated"], b"ref")
        raw = self.state([], output_mode="persistent_refs", reference_slots=[ref])
        queued = snapshot(main=False, refs=(1,), queue_slots=[])
        self.assertIs(True, conveyor.ImageConveyor.VALIDATE_INPUTS(raw, queue_item_json=queued))

        result = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)["result"]
        self.assertIsNone(result[0])
        self.assertEqual("image:R1.png [input]", result[6])
        self.assertIsNone(result[14])
        self.assertEqual(["R1.png [input]"], FakeLoadImage.calls)

    def test_change_hash_distinguishes_image_and_last_frame_roles(self):
        first = item("A")
        self.materialize_items(first)
        raw = self.state([first], output_mode="persistent_refs")
        image_only = snapshot(main=True, refs=(), queue_slots=[0], members=[first])
        last_only = snapshot(main=False, refs=(), queue_slots=[1], members=[first])
        self.assertNotEqual(
            conveyor.ImageConveyor.IS_CHANGED(raw, queue_item_json=image_only),
            conveyor.ImageConveyor.IS_CHANGED(raw, queue_item_json=last_only),
        )

    def test_queue_group_preserves_reference_mapping_and_aliases_second_as_last_frame(self):
        first = item("A")
        second = item("B")
        third = item("C")
        self.materialize_items(first, second, third)
        raw = self.state(
            [first, second, third],
            output_mode="queue_group",
            images_per_execution=3,
        )
        queued = json.dumps({
            **first,
            "items": [first, second, third],
            "main_output_enabled": False,
            "reference_output_slots": [],
        })
        result = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)["result"]
        self.assertEqual("image:A.png [input]", result[0])
        self.assertEqual("image:B.png [input]", result[6])
        self.assertEqual("image:C.png [input]", result[7])
        self.assertEqual("image:B.png [input]", result[14])


if __name__ == "__main__":
    unittest.main()
