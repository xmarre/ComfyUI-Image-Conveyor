import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "media_resolution_router.py"
spec = importlib.util.spec_from_file_location(
    "media_resolution_router_under_test", MODULE_PATH
)
router = importlib.util.module_from_spec(spec)
spec.loader.exec_module(router)


class FakeScale:
    calls = []

    def upscale(self, **kwargs):
        self.calls.append(kwargs)
        return {"ui": {"text": ["ok"]}, "result": (kwargs["image"], 32, 32)}


def defaults():
    return {
        f"{name}_mp": mp
        for name, mp in zip(router._MEDIA_INPUTS, router._DEFAULT_MP)
    }


class MediaResolutionTest(unittest.TestCase):
    def setUp(self):
        FakeScale.calls.clear()
        self.fake_nodes = types.SimpleNamespace(
            NODE_CLASS_MAPPINGS={"ImageScaleToTotalPixelsX": FakeScale}
        )
        self.ctx = mock.patch.dict(sys.modules, {"nodes": self.fake_nodes})
        self.ctx.start()
        self.addCleanup(self.ctx.stop)

    def test_schema_tenth_megapixel_precision(self):
        schema = router.ImageConveyorMediaResolution.INPUT_TYPES()
        self.assertEqual(len(schema["optional"]), 11)
        self.assertEqual(len(router.ImageConveyorMediaResolution.RETURN_TYPES), 11)
        for name, spec in schema["required"].items():
            if name.endswith("_mp") or name.endswith("megapixels"):
                self.assertEqual(spec[1]["step"], 0.1)
                self.assertEqual(spec[1]["round"], 0.1)

    def test_empty_optional_media(self):
        result = router.ImageConveyorMediaResolution().resize_media(
            False, 0.7, **defaults()
        )
        self.assertEqual(result, (None,) * 11)
        self.assertFalse(FakeScale.calls)

    def test_local_values_and_none_slots(self):
        values = defaults()
        values.update(
            reference_image_1="ref1",
            reference_image_2="ref2",
            reference_image_2_mp=1.2,
            reference_video_1="video",
        )
        result = router.ImageConveyorMediaResolution().resize_media(
            False, 0.7, **values
        )
        self.assertEqual(
            (result[0], result[1], result[-1]), ("ref1", "ref2", "video")
        )
        self.assertTrue(all(value is None for value in result[2:-1]))
        self.assertEqual(
            [call["megapixels"] for call in FakeScale.calls],
            [0.7, 1.2, 0.4],
        )

    def test_universal_tenth_megapixel_precision(self):
        values = defaults()
        values.update(
            reference_image_3="ref3",
            first_frame="first",
            reference_video_1="video",
        )
        router.ImageConveyorMediaResolution().resize_media(
            True, 1.2, **values
        )
        self.assertEqual(
            [call["megapixels"] for call in FakeScale.calls], [1.2] * 3
        )
        self.assertTrue(all(
            call["multiple_of"] == 32
            and call["resize_mode"] == "crop"
            and call["upscale_method"] == "lanczos"
            for call in FakeScale.calls
        ))

    def test_invalid_live_value(self):
        values = defaults()
        values.update(
            reference_image_3="ref3",
            reference_image_3_mp=float("nan"),
        )
        with self.assertRaisesRegex(ValueError, "reference_image_3"):
            router.ImageConveyorMediaResolution().resize_media(
                False, 0.7, **values
            )

    def test_missing_resizer_error(self):
        self.fake_nodes.NODE_CLASS_MAPPINGS.clear()
        values = defaults()
        values["reference_image_4"] = "ref4"
        with self.assertRaisesRegex(RuntimeError, "Scale Image to Total Pixels"):
            router.ImageConveyorMediaResolution().resize_media(
                False, 0.7, **values
            )


if __name__ == "__main__":
    unittest.main()
