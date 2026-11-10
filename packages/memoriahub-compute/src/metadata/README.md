# metadata

Metadata extraction cores: EXIF fields, orientation-corrected dimensions, ffprobe invocation and container metadata normalization, and the civil-timestamp helpers that keep a capture wall clock a civil value.

## Purpose and scope

Metadata extraction cores: EXIF fields, orientation-corrected dimensions, ffprobe invocation and container metadata normalization, and the civil-timestamp helpers that keep a capture wall clock a civil value.

Pure compute only: no framework import, no environment read, no persistence. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-compute/metadata`. `metadata/index.ts`: `extractExif`, `extractDimensions`, `probeVideoFile`, `probeVideo`, `extractContainerMetadata`, `parseVideoCaptureTimestamp`, `wallClockToCivilTimestamp`, `parseExifOffsetToMinutes`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`exifr` (exact-pinned dependency of the package), loaded lazily; the `ffmpeg` and `image` slices.

## Configuration

None.

## Extension-point catalog

None. The slice exposes functions and data shapes, not extension points.
