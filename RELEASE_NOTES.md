# Image Conveyor v1.1.1

Packaging fix for the v1.1 release.

## Packaging

- Adds the missing `.comfyignore` used by the Comfy Registry publisher.
- Excludes development-only `.github/` and `tests/` content from Comfy Registry archives.
- Keeps the Image Conveyor v1.1.0 functionality and saved-workflow compatibility unchanged.

## Validation

- The v1.1 feature release passed 40 Python tests and 24 gallery tests before merge.
- The release workflow continues to validate Python/JavaScript syntax and whitespace before publishing a GitHub release.
