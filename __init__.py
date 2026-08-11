import logging

from .image_conveyor import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .image_conveyor_drag_ops import register_drag_routes
from .image_conveyor_library_ops import register_library_routes
from .image_conveyor_server import register_routes

WEB_DIRECTORY = "./web"

try:
    register_routes()
    register_library_routes()
    register_drag_routes()
except Exception:
    logging.getLogger(__name__).exception(
        "Image Conveyor: failed to register HTTP routes; input-folder browsing and imports will be unavailable."
    )

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
