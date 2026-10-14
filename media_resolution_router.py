"""Compact per-source or universal image/video reference resolution for Image Conveyor.

Delegate resizing to Scale Image to Total Pixels Advanced so crops, alignment,
and interpolation retain the behavior of existing reference workflows.
"""

from __future__ import annotations

import math


_MEDIA_INPUTS = tuple(f"reference_image_{i}" for i in range(1, 9)) + (
    "first_frame", "last_frame", "reference_video_1"
)
_DEFAULT_MP = (0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.4)


class ImageConveyorMediaResolution:
    """Resize populated sources; leave absent optional sources as None."""

    @classmethod
    def INPUT_TYPES(cls):
        def float_spec(default):
            return ("FLOAT", {
                "default": default,
                "min": 0.001,
                "max": 16.0,
                "step": 0.001,
                "round": 0.001,
            })

        required = {
            "use_universal": ("BOOLEAN", {"default": False}),
            "universal_megapixels": float_spec(0.7),
        }
        for name, value in zip(_MEDIA_INPUTS, _DEFAULT_MP):
            required[f"{name}_mp"] = float_spec(value)
        optional = {name: ("IMAGE",) for name in _MEDIA_INPUTS}
        return {"required": required, "optional": optional}

    RETURN_TYPES = ("IMAGE",) * len(_MEDIA_INPUTS)
    RETURN_NAMES = _MEDIA_INPUTS
    FUNCTION = "resize_media"
    CATEGORY = "image/conveyor"

    @staticmethod
    def _resizer():
        import nodes
        scale_cls = nodes.NODE_CLASS_MAPPINGS.get("ImageScaleToTotalPixelsX")
        if scale_cls is None:
            raise RuntimeError(
                "Media Resolution: install Scale Image to Total Pixels Advanced "
                "(ImageScaleToTotalPixelsX)."
            )
        return scale_cls()

    def resize_media(self, use_universal, universal_megapixels, **kwargs):
        sources = [kwargs.get(name) for name in _MEDIA_INPUTS]
        if not any(source is not None for source in sources):
            return (None,) * len(_MEDIA_INPUTS)

        resizer = self._resizer()
        results = []
        for name, source in zip(_MEDIA_INPUTS, sources):
            if source is None:
                results.append(None)
                continue
            mp = universal_megapixels if use_universal else kwargs[f"{name}_mp"]
            if not math.isfinite(float(mp)) or not 0.001 <= float(mp) <= 16.0:
                raise ValueError(
                    f"Media Resolution: {name} megapixels must be between 0.001 and 16."
                )
            scaled = resizer.upscale(
                image=source,
                megapixels=float(mp),
                multiple_of=32,
                resize_mode="crop",
                upscale_method="lanczos",
                unique_id=None,
            )
            results.append(scaled["result"][0])
        return tuple(results)


NODE_CLASS_MAPPINGS = {
    "ImageConveyorMediaResolution": ImageConveyorMediaResolution,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageConveyorMediaResolution": "Media Resolution — Image Conveyor",
}
