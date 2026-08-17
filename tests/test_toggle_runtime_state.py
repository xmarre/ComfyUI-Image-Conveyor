import json
import types
import unittest

from image_conveyor_toggle_runtime import install_toggle_runtime


class ToggleRuntimeStateTests(unittest.TestCase):
    def fake_module(self):
        module = types.SimpleNamespace()
        module._OUTPUT_MODE_PERSISTENT = "persistent_refs"
        module._safe_json_load = lambda raw, fallback: json.loads(raw) if raw else fallback
        module._normalize_state = lambda raw: {
            "output_mode": json.loads(raw).get("output_mode", "persistent_refs")
        }
        module._active_reference_slots = lambda state, queue_item_json: (1, 2, 3, 4)
        module._main_output_enabled = lambda state, queue_item_json: True
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

    def test_explicit_main_disable_is_backend_authoritative(self):
        module = self.fake_module()
        install_toggle_runtime(module)
        raw = json.dumps({
            "output_mode": "persistent_refs",
            "reference_output_enabled": [True] * 8,
            "main_output_enabled": False,
        })
        state = module._normalize_state(raw)
        self.assertFalse(module._main_output_enabled(state, "stale-snapshot"))

    def test_legacy_state_preserves_existing_snapshot_behavior(self):
        module = self.fake_module()
        install_toggle_runtime(module)
        state = module._normalize_state(json.dumps({"output_mode": "persistent_refs"}))
        self.assertEqual((1, 2, 3, 4), module._active_reference_slots(state, "legacy"))
        self.assertTrue(module._main_output_enabled(state, "legacy"))

    def test_queue_group_ignores_main_disable(self):
        module = self.fake_module()
        install_toggle_runtime(module)
        raw = json.dumps({
            "output_mode": "queue_group",
            "main_output_enabled": False,
        })
        state = module._normalize_state(raw)
        self.assertTrue(module._main_output_enabled(state, "ignored"))


if __name__ == "__main__":
    unittest.main()
