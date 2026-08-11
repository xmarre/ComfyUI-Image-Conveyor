import logging

from .image_conveyor import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .image_conveyor_drag_ops import register_drag_routes
from .image_conveyor_library_ops import register_library_routes
from .image_conveyor_server import register_routes

WEB_DIRECTORY = "./web"
LOGGER = logging.getLogger(__name__)


def _register_route_group(name, register):
    try:
        register()
    except Exception:
        LOGGER.exception("Image Conveyor: failed to register %s HTTP routes.", name)


_register_route_group("core", register_routes)
_register_route_group("library", register_library_routes)
_register_route_group("drag", register_drag_routes)

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
