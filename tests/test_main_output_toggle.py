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
    calls = []

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


def snapshot(*, main=False, refs=()):
    return json.dumps({
        "main_output_enabled": main,
        "reference_output_slots": list(refs),
    })


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

    def test_legacy_snapshot_keeps_main_enabled(self):
        state = conveyor._normalize_state(self.state())
        self.assertTrue(conveyor._main_output_enabled(state, ""))
        self.assertTrue(conveyor._main_output_enabled(state, json.dumps({"reference_output_slots": []})))

    def test_malformed_main_snapshot_is_rejected(self):
        raw = self.state(output_mode="persistent_refs")
        payload = json.dumps({"main_output_enabled": 0, "reference_output_slots": []})
        self.assertEqual(
            "Image Conveyor: main output enable snapshot is invalid.",
            conveyor.ImageConveyor.VALIDATE_INPUTS(raw, queue_item_json=payload),
        )

    def test_disabled_main_validates_and_executes_with_empty_conveyor(self):
        raw = self.state(output_mode="persistent_refs")
        queued = snapshot(main=False, refs=())
        self.assertIs(True, conveyor.ImageConveyor.VALIDATE_INPUTS(raw, queue_item_json=queued))

        output = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)
        result = output["result"]
        self.assertEqual(14, len(result))
        self.assertIsNone(result[0])
        self.assertIsNone(result[1])
        self.assertEqual("", result[2])
        self.assertEqual(0, result[3])
        self.assertEqual(0, result[4])
        self.assertEqual("", result[5])
        self.assertEqual([None] * 8, list(result[6:]))
        self.assertEqual({}, output["ui"])
        self.assertEqual([], FakeLoadImage.calls)

    def test_disabled_main_does_not_select_decode_or_consume_pending_image(self):
        raw = self.state([item("A")], output_mode="persistent_refs")
        queued = snapshot(main=False, refs=())
        output = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)

        self.assertIsNone(output["result"][0])
        self.assertEqual(1, output["result"][4])
        self.assertEqual({}, output["ui"])
        self.assertEqual([], FakeLoadImage.calls)

    def test_disabled_main_still_validates_and_loads_active_references(self):
        ref = reference("R1")
        self.materialize(ref["annotated"], b"ref")
        raw = self.state(
            [],
            output_mode="persistent_refs",
            reference_slots=[ref],
        )
        queued = snapshot(main=False, refs=(1,))
        self.assertIs(True, conveyor.ImageConveyor.VALIDATE_INPUTS(raw, queue_item_json=queued))

        result = conveyor.ImageConveyor().load_next(raw, queue_item_json=queued)["result"]
        self.assertIsNone(result[0])
        self.assertEqual("image:R1.png [input]", result[6])
        self.assertEqual(["R1.png [input]"], FakeLoadImage.calls)

    def test_disabled_main_reports_missing_active_reference_without_requiring_queue(self):
        ref = reference("missing")
        raw = self.state([], output_mode="persistent_refs", reference_slots=[ref])
        self.assertEqual(
            "Image Conveyor: reference slot 1 is missing 'missing.png [input]'.",
            conveyor.ImageConveyor.VALIDATE_INPUTS(
                raw,
                queue_item_json=snapshot(main=False, refs=(1,)),
            ),
        )

    def test_disabled_main_change_hash_ignores_conveyor_items_and_tracks_reference(self):
        ref = reference("R1")
        ref_path = self.materialize(ref["annotated"], b"ref")
        queued = snapshot(main=False, refs=(1,))
        first = self.state([], output_mode="persistent_refs", reference_slots=[ref])
        second = self.state(
            [item("A"), item("B", status="processed")],
            output_mode="persistent_refs",
            reference_slots=[ref],
        )
        baseline = conveyor.ImageConveyor.IS_CHANGED(first, queue_item_json=queued)
        self.assertEqual(baseline, conveyor.ImageConveyor.IS_CHANGED(second, queue_item_json=queued))
        ref_path.write_bytes(b"changed")
        self.assertNotEqual(baseline, conveyor.ImageConveyor.IS_CHANGED(first, queue_item_json=queued))

    def test_queue_group_mode_ignores_main_disable_snapshot(self):
        entry = item("A")
        raw = self.state(
            [entry],
            output_mode="queue_group",
            images_per_execution=1,
        )
        self.assertTrue(conveyor._main_output_enabled(
            conveyor._normalize_state(raw),
            snapshot(main=False, refs=()),
        ))
        result = conveyor.ImageConveyor().load_next(
            raw,
            queue_item_json=snapshot(main=False, refs=()),
        )["result"]
        self.assertEqual("image:A.png [input]", result[0])
        self.assertEqual(["A.png [input]"], FakeLoadImage.calls)


if __name__ == "__main__":
    unittest.main()
