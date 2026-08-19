import json
import types
import unittest

from image_conveyor_toggle_runtime import install_toggle_runtime


class ToggleRuntimeStateTests(unittest.TestCase):
    def fake_module(self):
        module = types.SimpleNamespace()
        module._OUTPUT_MODE_PERSISTENT = "persistent_refs"
        module._QUEUE_SLOT_IMAGE = 0
        module._QUEUE_SLOT_LAST_FRAME = 1
        module._QUEUE_OUTPUT_SLOTS_KEY = "queue_output_slots"
        module._safe_json_load = lambda raw, fallback: json.loads(raw) if raw else fallback
        module._normalize_state = lambda raw: {
            "output_mode": json.loads(raw).get("output_mode", "persistent_refs")
        }
        module._active_reference_slots = lambda state, queue_item_json: (1, 2, 3, 4)
        module._main_output_enabled = lambda state, queue_item_json: True
        module._connected_queue_output_slots = lambda state, queue_item_json: tuple(
            json.loads(queue_item_json).get("queue_output_slots", [0])
        )
        module._parse_queue_item = lambda raw: None
        module._select_group = (
            lambda state, queue_item_json, allow_processed=False: []
        )
        return module

    def test_explicit_reference_mask_filters_even_when_queue_snapshot_is_stale(self):
        module = self.fake_module()
        install_toggle_runtime(module)
        raw = json.dumps({
            "output_mode": "persistent_refs",
            "reference_output_enabled": [False, True, False, True],
            "main_output_enabled": True,
        })
        state = module._normalize_state(raw)
        self.assertEqual((2, 4), module._active_reference_slots(state, "stale-snapshot"))

    def test_explicit_main_disable_filters_stale_main_queue_role(self):
        module = self.fake_module()
        install_toggle_runtime(module)
        raw = json.dumps({
            "output_mode": "persistent_refs",
            "reference_output_enabled": [True] * 8,
            "main_output_enabled": False,
            "last_frame_output_enabled": True,
        })
        state = module._normalize_state(raw)
        self.assertFalse(module._main_output_enabled(state, "stale-snapshot"))
        self.assertEqual(
            (1,),
            module._connected_queue_output_slots(
                state, json.dumps({"queue_output_slots": [0, 1]})
            ),
        )

    def test_explicit_last_frame_disable_filters_stale_last_frame_queue_role(self):
        module = self.fake_module()
        install_toggle_runtime(module)
        raw = json.dumps({
            "output_mode": "persistent_refs",
            "main_output_enabled": True,
            "last_frame_output_enabled": False,
        })
        state = module._normalize_state(raw)
        self.assertFalse(state["last_frame_output_enabled"])
        self.assertEqual(
            (0,),
            module._connected_queue_output_slots(
                state, json.dumps({"queue_output_slots": [0, 1]})
            ),
        )

    def test_explicit_queue_role_disables_can_filter_every_queue_output(self):
        module = self.fake_module()
        install_toggle_runtime(module)
        raw = json.dumps({
            "output_mode": "persistent_refs",
            "main_output_enabled": False,
            "last_frame_output_enabled": False,
        })
        state = module._normalize_state(raw)
        self.assertEqual(
            (),
            module._connected_queue_output_slots(
                state, json.dumps({"queue_output_slots": [0, 1]})
            ),
        )

    def test_legacy_state_preserves_existing_snapshot_behavior(self):
        module = self.fake_module()
        install_toggle_runtime(module)
        state = module._normalize_state(json.dumps({"output_mode": "persistent_refs"}))
        self.assertEqual((1, 2, 3, 4), module._active_reference_slots(state, "legacy"))
        self.assertTrue(module._main_output_enabled(state, "legacy"))
        self.assertIsNone(state["last_frame_output_enabled"])
        self.assertEqual(
            (0, 1),
            module._connected_queue_output_slots(
                state, json.dumps({"queue_output_slots": [0, 1]})
            ),
        )

    def test_queue_group_ignores_output_disables(self):
        module = self.fake_module()
        install_toggle_runtime(module)
        raw = json.dumps({
            "output_mode": "queue_group",
            "main_output_enabled": False,
            "last_frame_output_enabled": False,
        })
        state = module._normalize_state(raw)
        self.assertTrue(module._main_output_enabled(state, "ignored"))
        self.assertEqual(
            (0, 1),
            module._connected_queue_output_slots(
                state, json.dumps({"queue_output_slots": [0, 1]})
            ),
        )


if __name__ == "__main__":
    unittest.main()
