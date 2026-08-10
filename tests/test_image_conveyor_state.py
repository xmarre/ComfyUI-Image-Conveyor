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
SPEC = importlib.util.spec_from_file_location("image_conveyor_under_test", MODULE_PATH)
conveyor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
with mock.patch.dict(sys.modules, {"folder_paths": fake_folder_paths, "nodes": fake_nodes}):
    SPEC.loader.exec_module(conveyor)


def item(item_id, annotated=None, status="pending", source_path=""):
    annotated = annotated or f"{item_id}.png [input]"
    return {
        "id": item_id,
        "annotated": annotated,
        "filename": f"{item_id}.png",
        "subfolder": "",
        "source_path": source_path,
        "type": "input",
        "status": status,
        "added_at": 1,
        "last_queued_at": 0,
        "last_processed_at": 0,
    }


def grouped_payload(*entries):
    members = [{"id": entry["id"], "annotated": entry["annotated"]} for entry in entries]
    return json.dumps({
        "id": members[0]["id"],
        "annotated": members[0]["annotated"],
        "items": members,
    })


class ImageConveyorStateTest(unittest.TestCase):
    def setUp(self):
        FILE_PATHS.clear()
        EXISTING_ANNOTATED.clear()
        FakeLoadImage.calls.clear()
        self.temp_dir = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp_dir.cleanup()

    def state(self, entries, *, legacy=False, **options):
        payload = conveyor._default_state()
        payload["items"] = entries
        payload.update(options)
        normalized_count = conveyor._normalize_images_per_execution(options.get("images_per_execution", 1))
        if normalized_count > 1 and "output_mode" not in options:
            payload["output_mode"] = conveyor._OUTPUT_MODE_QUEUE_GROUP
        if legacy:
            payload.pop("images_per_execution", None)
            payload.pop("output_mode", None)
        return json.dumps(payload)

    def materialize(self, entry, contents=b"image-bytes"):
        path = Path(self.temp_dir.name) / f"{entry['id']}-{len(FILE_PATHS)}.img"
        path.write_bytes(contents)
        FILE_PATHS[entry["annotated"]] = str(path)
        EXISTING_ANNOTATED.add(entry["annotated"])
        return path

    def materialize_all(self, entries):
        for index, entry in enumerate(entries):
            self.materialize(entry, f"bytes-{entry['id']}-{index}".encode())

    def test_legacy_v1_state_without_count_normalizes_to_one(self):
        state = conveyor._normalize_state(self.state([item("one")], legacy=True))
        self.assertEqual(2, state["version"])
        self.assertEqual(1, state["images_per_execution"])
        self.assertEqual(conveyor._OUTPUT_MODE_PERSISTENT, state["output_mode"])

    def test_legacy_state_with_multi_count_migrates_to_queue_group(self):
        payload = conveyor._default_state()
        payload.pop("output_mode")
        payload["images_per_execution"] = 3
        payload["items"] = [item("A"), item("B"), item("C")]
        state = conveyor._normalize_state(json.dumps(payload))
        self.assertEqual(conveyor._OUTPUT_MODE_QUEUE_GROUP, state["output_mode"])
        self.assertEqual(3, conveyor._effective_images_per_execution(state))

    def test_new_default_uses_persistent_references_and_one_queue_item(self):
        entries = [item("A"), item("B"), item("C")]
        state = conveyor._normalize_state(self.state(entries, images_per_execution=9, output_mode="persistent_refs"))
        selected = conveyor._select_group(state, "")
        self.assertEqual(["A"], [entry["id"] for _, entry in selected])

    def test_reference_slots_normalize_to_fixed_sparse_eight(self):
        reference = {"annotated": "refs/one.png [input]", "filename": "one.png", "subfolder": "refs", "type": "input"}
        state = conveyor._normalize_state(self.state([], reference_slots=[reference, "bad", None]))
        self.assertEqual(8, len(state["reference_slots"]))
        self.assertEqual(reference, state["reference_slots"][0])
        self.assertEqual([None] * 7, state["reference_slots"][1:])

    def test_reference_state_rejects_absolute_traversal_output_and_unsupported_paths(self):
        values = [
            {"annotated": "/tmp/a.png [input]", "type": "input"},
            {"annotated": "../a.png [input]", "type": "input"},
            {"annotated": "a.png [output]", "type": "input"},
            {"annotated": "a.svg [input]", "type": "input"},
        ]
        state = conveyor._normalize_state(self.state([], reference_slots=values))
        self.assertEqual([None] * 8, state["reference_slots"])

    def test_images_per_execution_range_normalization(self):
        cases = {0: 1, -5: 1, "bad": 1, None: 1, 3.5: 3, 10: 9, 999: 9}
        for value, expected in cases.items():
            with self.subTest(value=value):
                state = conveyor._normalize_state(self.state([], images_per_execution=value))
                self.assertEqual(expected, state["images_per_execution"])
        for count in range(1, 10):
            with self.subTest(count=count):
                state = conveyor._normalize_state(self.state([], images_per_execution=count))
                self.assertEqual(count, state["images_per_execution"])

    def test_existing_single_selection_semantics_remain(self):
        entries = [item("done", status="processed"), item("next"), item("queued", status="queued")]
        index, selected = conveyor._select_item(conveyor._normalize_state(self.state(entries)), "")
        self.assertEqual((1, "next"), (index, selected["id"]))

    def test_multi_selection_preserves_queue_order(self):
        entries = [item("A"), item("B"), item("C"), item("D")]
        selected = conveyor._select_group(
            conveyor._normalize_state(self.state(entries, images_per_execution=3)), ""
        )
        self.assertEqual(["A", "B", "C"], [entry["id"] for _, entry in selected])

    def test_duplicate_physical_paths_remain_distinct_logical_slots(self):
        shared = "same.png [input]"
        entries = [item("A1", shared), item("A2", shared), item("B", "other.png [input]")]
        selected = conveyor._select_group(
            conveyor._normalize_state(self.state(entries, images_per_execution=3)), ""
        )
        self.assertEqual(["A1", "A2", "B"], [entry["id"] for _, entry in selected])

    def test_dont_consume_selects_same_group_repeatedly(self):
        entries = [item("A"), item("B"), item("C"), item("D")]
        raw = self.state(entries, images_per_execution=3, dont_consume=True)
        first = conveyor.ImageConveyor().load_next(raw)
        second = conveyor.ImageConveyor().load_next(raw)
        self.assertEqual(first["result"][:1] + first["result"][6:8], second["result"][:1] + second["result"][6:8])
        self.assertFalse(json.loads(first["ui"]["batch_image_loader_delta"][0])["consumed"])
        self.assertFalse(json.loads(second["ui"]["batch_image_loader_delta"][0])["consumed"])

    def test_dont_consume_processed_fallback_uses_first_n(self):
        entries = [item("A", status="processed"), item("B", status="processed"), item("C", status="processed")]
        state = conveyor._normalize_state(self.state(entries, images_per_execution=2, dont_consume=True))
        selected = conveyor._select_group(state, "", allow_processed=True)
        self.assertEqual(["A", "B"], [entry["id"] for _, entry in selected])

    def test_dont_consume_does_not_fill_partial_eligible_group_with_processed(self):
        entries = [item("A"), item("B", status="processed"), item("C", status="processed")]
        state = conveyor._normalize_state(self.state(entries, images_per_execution=2, dont_consume=True))
        with self.assertRaisesRegex(RuntimeError, "2 images per execution requested, but only 1 eligible"):
            conveyor._select_group(state, "", allow_processed=True)

    def test_insufficient_group_has_clear_validation_error(self):
        raw = self.state([item("A"), item("B")], images_per_execution=3)
        result = conveyor.ImageConveyor.VALIDATE_INPUTS(raw)
        self.assertIn("3 images per execution requested", result)
        self.assertIn("only 2 eligible", result)

    def test_validate_inputs_checks_missing_secondary_file(self):
        entries = [item("A"), item("B"), item("C")]
        self.materialize(entries[0])
        self.materialize(entries[2])
        result = conveyor.ImageConveyor.VALIDATE_INPUTS(self.state(entries, images_per_execution=3))
        self.assertEqual("Image Conveyor: missing file 'B.png [input]'.", result)

    def test_legacy_queue_payload_count_one_preserves_id_selection(self):
        shared = "same.png [input]"
        entries = [item("first", shared), item("second", shared, status="queued")]
        state = conveyor._normalize_state(self.state(entries))
        index, selected = conveyor._select_item(
            state, json.dumps({"id": "second", "annotated": shared})
        )
        self.assertEqual((1, "second"), (index, selected["id"]))

    def test_legacy_payload_cannot_invent_multi_image_group(self):
        entries = [item("A"), item("B"), item("C")]
        state = conveyor._normalize_state(self.state(entries, images_per_execution=3))
        with self.assertRaisesRegex(RuntimeError, "legacy single-image reservation cannot satisfy 3"):
            conveyor._select_group(
                state,
                json.dumps({"id": "A", "annotated": entries[0]["annotated"]}),
            )

    def test_grouped_reservation_uses_payload_order(self):
        a, b, c = item("A"), item("B"), item("C")
        state = conveyor._normalize_state(self.state([a, b, c], images_per_execution=3))
        selected = conveyor._select_group(state, grouped_payload(a, b, c))
        self.assertEqual(["A", "B", "C"], [entry["id"] for _, entry in selected])

    def test_grouped_reservation_missing_member_is_strict_error(self):
        a, b, c = item("A"), item("B"), item("C")
        state = conveyor._normalize_state(self.state([a, c], images_per_execution=3))
        with self.assertRaisesRegex(RuntimeError, "reserved queue image 'B' is no longer present"):
            conveyor._select_group(state, grouped_payload(a, b, c))

    def test_grouped_reservation_rejects_changed_member_path(self):
        a, b, c = item("A"), item("B"), item("C")
        payload = grouped_payload(a, b, c)
        b["annotated"] = "changed.png [input]"
        state = conveyor._normalize_state(self.state([a, b, c], images_per_execution=3))
        with self.assertRaisesRegex(RuntimeError, "reserved queue image 'B' changed"):
            conveyor._select_group(state, payload)

    def test_grouped_reservation_order_survives_live_reorder(self):
        a, b, c = item("A"), item("B"), item("C")
        state = conveyor._normalize_state(self.state([c, b, a], images_per_execution=3))
        selected = conveyor._select_group(state, grouped_payload(a, b, c))
        self.assertEqual(["A", "B", "C"], [entry["id"] for _, entry in selected])

    def test_output_layout_preserves_first_six_slots_and_appends_images(self):
        self.assertEqual(
            ("IMAGE", "MASK", "STRING", "INT", "INT", "STRING"),
            conveyor.ImageConveyor.RETURN_TYPES[:6],
        )
        self.assertEqual(
            ("image", "mask", "path", "index", "remaining_pending", "source_path"),
            conveyor.ImageConveyor.RETURN_NAMES[:6],
        )
        self.assertEqual(
            ("image_2", "image_3", "image_4", "image_5", "image_6", "image_7", "image_8", "image_9"),
            conveyor.ImageConveyor.RETURN_NAMES[6:],
        )
        self.assertEqual(("IMAGE",) * 8, conveyor.ImageConveyor.RETURN_TYPES[6:])
        self.assertEqual(14, len(conveyor.ImageConveyor.RETURN_TYPES))
        self.assertEqual(14, len(conveyor.ImageConveyor.RETURN_NAMES))

    def test_result_mapping_and_inactive_image_outputs(self):
        entries = [item("A"), item("B"), item("C"), item("D")]
        result = conveyor.ImageConveyor().load_next(
            self.state(entries, images_per_execution=3)
        )["result"]
        self.assertEqual(14, len(result))
        self.assertEqual("image:A.png [input]", result[0])
        self.assertEqual("image:B.png [input]", result[6])
        self.assertEqual("image:C.png [input]", result[7])
        self.assertEqual([None] * 6, list(result[8:14]))
        self.assertEqual(
            ["A.png [input]", "B.png [input]", "C.png [input]"],
            FakeLoadImage.calls,
        )

    def test_persistent_reference_output_mapping_is_sparse_and_never_consumed(self):
        entries = [item("A"), item("B")]
        refs = [
            {"annotated": "R1.png [input]", "filename": "R1.png", "subfolder": "", "type": "input"},
            None,
            {"annotated": "R3.png [input]", "filename": "R3.png", "subfolder": "", "type": "input"},
        ]
        result = conveyor.ImageConveyor().load_next(
            self.state(entries, output_mode="persistent_refs", reference_slots=refs)
        )["result"]
        self.assertEqual("image:A.png [input]", result[0])
        self.assertEqual("image:R1.png [input]", result[6])
        self.assertIsNone(result[7])
        self.assertEqual("image:R3.png [input]", result[8])
        self.assertEqual([None] * 5, list(result[9:]))
        self.assertEqual(1, result[4])
        self.assertEqual(["A.png [input]", "R1.png [input]", "R3.png [input]"], FakeLoadImage.calls)
        delta = json.loads(conveyor.ImageConveyor().load_next(
            self.state(entries, output_mode="persistent_refs", reference_slots=refs)
        )["ui"]["batch_image_loader_delta"][0])
        self.assertEqual(["A"], [entry["id"] for entry in delta["processed_items"]])

    def test_persistent_reference_missing_validation_identifies_slot(self):
        main = item("A")
        self.materialize(main)
        refs = [None, None, None, {"annotated": "missing.png [input]", "type": "input"}]
        raw = self.state([main], output_mode="persistent_refs", reference_slots=refs)
        self.assertEqual(
            "Image Conveyor: reference slot 4 is missing 'missing.png [input]'.",
            conveyor.ImageConveyor.VALIDATE_INPUTS(raw),
        )

    def test_is_changed_tracks_reference_contents(self):
        main = item("A")
        reference = {"annotated": "R.png [input]", "filename": "R.png", "subfolder": "", "type": "input"}
        self.materialize(main, b"main")
        reference_entry = item("R", "R.png [input]")
        reference_path = self.materialize(reference_entry, b"reference")
        raw = self.state([main], output_mode="persistent_refs", reference_slots=[reference])
        baseline = conveyor.ImageConveyor.IS_CHANGED(raw)
        reference_path.write_bytes(b"changed-reference")
        self.assertNotEqual(baseline, conveyor.ImageConveyor.IS_CHANGED(raw))

    def test_metadata_outputs_describe_first_selected_item(self):
        a, b, c = item("A", source_path="persisted/A.png"), item("B"), item("C")
        ui_state = json.dumps({
            "version": 1,
            "selected_ids": [],
            "source_paths": {"A": "runtime/A.png"},
        })
        result = conveyor.ImageConveyor().load_next(
            self.state([a, b, c], images_per_execution=3), ui_state
        )["result"]
        self.assertEqual("mask:A.png [input]", result[1])
        self.assertEqual("A.png [input]", result[2])
        self.assertEqual(1, result[3])
        self.assertEqual("runtime/A.png", result[5])

    def test_remaining_pending_is_group_aware_when_consuming(self):
        entries = [item(str(index)) for index in range(10)]
        result = conveyor.ImageConveyor().load_next(
            self.state(entries, images_per_execution=3)
        )["result"]
        self.assertEqual(7, result[4])

    def test_remaining_pending_is_unchanged_when_not_consuming(self):
        entries = [item("A"), item("B"), item("C"), item("D")]
        result = conveyor.ImageConveyor().load_next(
            self.state(entries, images_per_execution=3, dont_consume=True)
        )["result"]
        self.assertEqual(4, result[4])

    def test_backend_delta_contains_complete_ordered_group_and_legacy_fields(self):
        entries = [item("A"), item("B"), item("C")]
        output = conveyor.ImageConveyor().load_next(self.state(entries, images_per_execution=3))
        delta = json.loads(output["ui"]["batch_image_loader_delta"][0])
        self.assertEqual("A", delta["processed_item_id"])
        self.assertEqual("A.png [input]", delta["processed_annotated"])
        self.assertEqual(["A", "B", "C"], [entry["id"] for entry in delta["processed_items"]])
        self.assertEqual("processed", delta["new_status"])
        self.assertTrue(delta["consumed"])

    def test_backend_delta_dont_consume_reports_false_for_complete_group(self):
        entries = [item("A"), item("B"), item("C")]
        output = conveyor.ImageConveyor().load_next(
            self.state(entries, images_per_execution=3, dont_consume=True)
        )
        delta = json.loads(output["ui"]["batch_image_loader_delta"][0])
        self.assertFalse(delta["consumed"])
        self.assertEqual(["A", "B", "C"], [entry["id"] for entry in delta["processed_items"]])

    def test_is_changed_hashes_selected_contents_order_count_and_metadata_index(self):
        a, b, c, d = item("A"), item("B"), item("C"), item("D")
        entries = [a, b, c, d]
        a_path = self.materialize(a, b"a")
        b_path = self.materialize(b, b"b")
        c_path = self.materialize(c, b"c")
        d_path = self.materialize(d, b"d")
        raw = self.state(entries, images_per_execution=3)
        baseline = conveyor.ImageConveyor.IS_CHANGED(raw)

        a_path.write_bytes(b"a-changed")
        self.assertNotEqual(baseline, conveyor.ImageConveyor.IS_CHANGED(raw))
        a_path.write_bytes(b"a")

        b_path.write_bytes(b"b-changed")
        self.assertNotEqual(baseline, conveyor.ImageConveyor.IS_CHANGED(raw))
        b_path.write_bytes(b"b")

        c_path.write_bytes(b"c-changed")
        self.assertNotEqual(baseline, conveyor.ImageConveyor.IS_CHANGED(raw))
        c_path.write_bytes(b"c")

        self.assertNotEqual(
            baseline,
            conveyor.ImageConveyor.IS_CHANGED(self.state([a, c, b, d], images_per_execution=3)),
        )
        self.assertNotEqual(
            baseline,
            conveyor.ImageConveyor.IS_CHANGED(self.state(entries, images_per_execution=2)),
        )

        shifted = self.state([item("done", status="processed"), a, b, c, d], images_per_execution=3)
        self.assertNotEqual(baseline, conveyor.ImageConveyor.IS_CHANGED(shifted))

        d_path.write_bytes(b"unrelated-changed")
        self.assertEqual(baseline, conveyor.ImageConveyor.IS_CHANGED(raw))

    def test_validate_inputs_accepts_complete_group_when_all_files_exist(self):
        entries = [item("A"), item("B"), item("C")]
        self.materialize_all(entries)
        self.assertIs(
            True,
            conveyor.ImageConveyor.VALIDATE_INPUTS(self.state(entries, images_per_execution=3)),
        )

    def test_legacy_node_class_mapping_is_preserved(self):
        self.assertIs(
            conveyor.ImageConveyor,
            conveyor.NODE_CLASS_MAPPINGS["SequentialBatchImageLoader"],
        )


if __name__ == "__main__":
    unittest.main()
