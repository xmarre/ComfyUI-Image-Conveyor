"""Compact per-source or universal reference-media resolution for Image Conveyor.

Delegate downscaling to Scale Image to Total Pixels Advanced while avoiding
unnecessary interpolation or enlarging conditioning media past their input size.
"""

from __future__ import annotations

import math


_MEDIA_INPUTS = tuple(f"reference_image_{i}" for i in range(1, 9)) + (
    "first_frame", "last_frame", "reference_video_1"
)
_DEFAULT_MP = (0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.4)
_ALIGNMENT = 32


def _media_dimensions(source, name):
    shape = getattr(source, "shape", None)
    if shape is None or len(shape) != 4:
        raise ValueError(f"Media Resolution: {name} must be a BHWC IMAGE batch.")
    height, width = int(shape[1]), int(shape[2])
    if height < 1 or width < 1:
        raise ValueError(f"Media Resolution: {name} has invalid image dimensions.")
    return width, height


def _aligned_native(source, width, height):
    """Return an aligned view of native pixels, without allocating or resampling."""
    if width < _ALIGNMENT or height < _ALIGNMENT:
        # Alignment is impossible without enlarging at least one dimension.
        return source, True
    target_width = (width // _ALIGNMENT) * _ALIGNMENT
    target_height = (height // _ALIGNMENT) * _ALIGNMENT
    if target_width == width and target_height == height:
        return source, False
    left = (width - target_width) // 2
    top = (height - target_height) // 2
    return source[:, top:top + target_height, left:left + target_width, :], False


def _source_label(name):
    if name.startswith("reference_image_"):
        return f"Ref {name.rsplit('_', 1)[1]}"
    if name == "reference_video_1":
        return "Video 1"
    return name.replace("_", " ").capitalize()


class ImageConveyorMediaResolution:
    """Resize populated sources; leave absent optional sources as None."""

    @classmethod
    def INPUT_TYPES(cls):
        def float_spec(default):
            return ("FLOAT", {
                "default": default,
                "min": 0.1,
                "max": 16.0,
                "step": 0.1,
                "round": 0.1,
            })

        required = {
            "use_universal": ("BOOLEAN", {"default": False}),
            "universal_megapixels": float_spec(0.7),
        }
        for name, value in zip(_MEDIA_INPUTS, _DEFAULT_MP):
            required[f"{name}_mp"] = float_spec(value)
        # Keep the new setting after existing widgets: positional workflow values
        # from the initial router must retain their original meaning.
        required["limit_to_source"] = ("BOOLEAN", {"default": True})
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

    def resize_media(self, use_universal, universal_megapixels, limit_to_source=True, **kwargs):
        results = []
        notices = []
        populated = 0
        resizer = None

        for name in _MEDIA_INPUTS:
            source = kwargs.get(name)
            if source is None:
                results.append(None)
                continue
            populated += 1
            mp = float(universal_megapixels if use_universal else kwargs[f"{name}_mp"])
            if not math.isfinite(mp) or not 0.1 <= mp <= 16.0:
                raise ValueError(
                    f"Media Resolution: {name} megapixels must be between 0.1 and 16."
                )
            width, height = _media_dimensions(source, name)
            native_mp = width * height / 1_000_000
            capped = bool(limit_to_source and mp > native_mp)

            if limit_to_source and (mp >= native_mp or min(width, height) < _ALIGNMENT):
                # The upstream scaler floors to 32 pixels, then runs Lanczos even
                # for a native-size target. A centered view avoids both resampling
                # and another full-size GPU allocation in this path.
                scaled, unaligned = _aligned_native(source, width, height)
            else:
                if resizer is None:
                    resizer = self._resizer()
                output = resizer.upscale(
                    image=source,
                    megapixels=mp,
                    multiple_of=_ALIGNMENT,
                    resize_mode="crop",
                    upscale_method="lanczos",
                    unique_id=None,
                )
                scaled = output["result"][0]
                unaligned = False

            results.append(scaled)
            if capped or (limit_to_source and unaligned):
                output_width, output_height = _media_dimensions(scaled, name)
                output_mp = output_width * output_height / 1_000_000
                note = (
                    f"{_source_label(name)}: {mp:.2f} → {output_mp:.2f} MP "
                    f"(native {native_mp:.2f})"
                )
                if unaligned:
                    note += " · 32px alignment unavailable"
                notices.append(note)

        if not limit_to_source:
            status = ["MP cap: disabled"]
        elif not populated:
            status = ["MP cap: no media"]
        else:
            status = [f"MP capped: {len(notices)} / {populated}"]
            status.extend(notices)
        return {"ui": {"text": status}, "result": tuple(results)}


NODE_CLASS_MAPPINGS = {
    "ImageConveyorMediaResolution": ImageConveyorMediaResolution,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageConveyorMediaResolution": "Media Resolution — Image Conveyor",
}
