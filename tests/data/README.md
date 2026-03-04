# Test Media Fixtures

This directory contains binary fixtures used for media-related tests.

## Files

- `example_image.jpg`
  - Small JPEG fixture for image attachment and upload/path tests.
- `example_video.mp4`
  - Small MP4 fixture for video attachment and upload/path tests.

## Usage Guidelines

- Treat these files as static test assets.
- Do not mutate them in tests; copy to a temp path first if a test needs write access.
- Keep fixtures reasonably small to avoid slowing down CI/test runs.
- Prefer asserting metadata/URLs/types in unit tests over decoding/transcoding media.
