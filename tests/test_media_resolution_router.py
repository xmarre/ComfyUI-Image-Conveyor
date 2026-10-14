import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "media_resolution_router.py"
spec = importlib.util.spec_from_file_location("media_resolution_router_under_test", MODULE_PATH)
router = importlib.util.module_from_spec(spec)
spec.loader.exec_module(router)


class FakeImage:
    def __init__(self, width=2048, height=1024, frames=1, label="image"):
        self.shape = (frames, height, width, 3)
        self.label = label

    def __getitem__(self, selection):
        batch, h, w, channel = selection
        assert batch == slice(None) and channel == slice(None)
        height = h.stop - (h.start or 0)
        width = w.stop - (w.start or 0)
        return FakeImage(width, height, self.shape[0], self.label + ":crop")


class FakeScale:
    calls = []

    def upscale(self, **kwargs):
        self.calls.append(kwargs)
        return {"ui": {"text": ["ok"]}, "result": (kwargs["image"], 32, 32)}


def defaults():
    return {f"{name}_mp": mp for name, mp in zip(router._MEDIA_INPUTS, router._DEFAULT_MP)}


def execute(**values):
    return router.ImageConveyorMediaResolution().resize_media(
        values.pop("use_universal", False),
        values.pop("universal_megapixels", 0.7),
        **{**defaults(), **values},
    )


class MediaResolutionTest(unittest.TestCase):
    def setUp(self):
        FakeScale.calls.clear()
        self.fake_nodes = types.SimpleNamespace(
            NODE_CLASS_MAPPINGS={"ImageScaleToTotalPixelsX": FakeScale}
        )
        self.ctx = mock.patch.dict(sys.modules, {"nodes": self.fake_nodes})
        self.ctx.start()
        self.addCleanup(self.ctx.stop)

    def test_schema_tenth_megapixel_precision_and_widget_order(self):
        schema = router.ImageConveyorMediaResolution.INPUT_TYPES()
        self.assertEqual(len(schema["optional"]), 11)
        self.assertEqual(len(router.ImageConveyorMediaResolution.RETURN_TYPES), 11)
        self.assertEqual(list(schema["required"])[-1], "limit_to_source")
        self.assertTrue(schema["required"]["limit_to_source"][1]["default"])
        for name, spec in schema["required"].items():
            if name.endswith("_mp") or name.endswith("megapixels"):
                self.assertEqual(spec[1]["step"], 0.1)
                self.assertEqual(spec[1]["round"], 0.1)

    def test_empty_optional_media(self):
        response = execute()
        self.assertEqual(response["result"], (None,) * 11)
        self.assertEqual(response["ui"]["text"], ["MP cap: no media"])
        self.assertFalse(FakeScale.calls)

    def test_local_values_and_none_slots(self):
        sources = [FakeImage(label="ref1"), FakeImage(label="ref2"), FakeImage(label="video")]
        response = execute(reference_image_1=sources[0], reference_image_2=sources[1],
                           reference_image_2_mp=1.2, reference_video_1=sources[2])
        self.assertEqual((response["result"][0], response["result"][1], response["result"][-1]), tuple(sources))
        self.assertTrue(all(value is None for value in response["result"][2:-1]))
        self.assertEqual([call["megapixels"] for call in FakeScale.calls], [0.7, 1.2, 0.4])
        self.assertEqual(response["ui"]["text"], ["MP capped: 0 / 3"])

    def test_universal_tenth_megapixel_precision(self):
        response = execute(use_universal=True, universal_megapixels=1.2,
                           reference_image_3=FakeImage(), first_frame=FakeImage(),
                           reference_video_1=FakeImage())
        self.assertEqual([call["megapixels"] for call in FakeScale.calls], [1.2] * 3)
        self.assertTrue(all(call["multiple_of"] == 32 and call["resize_mode"] == "crop"
                            and call["upscale_method"] == "lanczos" for call in FakeScale.calls))
        self.assertEqual(response["ui"]["text"], ["MP capped: 0 / 3"])

    def test_native_cap_returns_aligned_view_without_resampling(self):
        source = FakeImage(width=1008, height=1512)
        response = execute(reference_image_1=source, reference_image_1_mp=1.8)
        result = response["result"][0]
        self.assertEqual(result.shape, (1, 1504, 992, 3))
        self.assertFalse(FakeScale.calls)
        self.assertEqual(response["ui"]["text"], [
            "MP capped: 1 / 1",
            "Ref 1: 1.80 → 1.49 MP (native 1.52)",
        ])

    def test_already_aligned_native_cap_reuses_exact_source(self):
        source = FakeImage(width=1024, height=1536)
        response = execute(reference_image_1=source, reference_image_1_mp=1.8)
        self.assertIs(response["result"][0], source)
        self.assertFalse(FakeScale.calls)

    def test_reference_video_batch_preserves_frame_count_on_cap(self):
        source = FakeImage(width=1008, height=1512, frames=83)
        response = execute(reference_video_1=source, reference_video_1_mp=1.8)
        self.assertEqual(response["result"][-1].shape, (83, 1504, 992, 3))
        self.assertIn("Video 1", response["ui"]["text"][1])

    def test_below_native_uses_existing_lanczos_scaler(self):
        response = execute(reference_image_1=FakeImage(width=1008, height=1512),
                           reference_image_1_mp=0.7)
        self.assertEqual([call["megapixels"] for call in FakeScale.calls], [0.7])
        self.assertEqual(response["ui"]["text"], ["MP capped: 0 / 1"])

    def test_cap_can_be_disabled_to_preserve_old_behavior(self):
        source = FakeImage(width=1008, height=1512)
        response = execute(reference_image_1=source, reference_image_1_mp=1.8,
                           limit_to_source=False)
        self.assertEqual(FakeScale.calls[0]["megapixels"], 1.8)
        self.assertIs(response["result"][0], source)
        self.assertEqual(response["ui"]["text"], ["MP cap: disabled"])

    def test_tiny_image_never_forces_32_pixel_upscale(self):
        source = FakeImage(width=16, height=24)
        response = execute(reference_image_1=source, reference_image_1_mp=0.7)
        self.assertIs(response["result"][0], source)
        self.assertFalse(FakeScale.calls)
        self.assertIn("32px alignment unavailable", response["ui"]["text"][1])

    def test_invalid_live_value(self):
        with self.assertRaisesRegex(ValueError, "reference_image_3"):
            execute(reference_image_3=FakeImage(), reference_image_3_mp=float("nan"))

    def test_invalid_image_shape(self):
        with self.assertRaisesRegex(ValueError, "BHWC"):
            execute(reference_image_1=object())

    def test_missing_resizer_error_only_when_scaling_needed(self):
        self.fake_nodes.NODE_CLASS_MAPPINGS.clear()
        source = FakeImage(width=1024, height=1536)
        self.assertIs(execute(reference_image_1=source, reference_image_1_mp=1.8)["result"][0], source)
        with self.assertRaisesRegex(RuntimeError, "Scale Image to Total Pixels"):
            execute(reference_image_4=source)


if __name__ == "__main__":
    unittest.main()
