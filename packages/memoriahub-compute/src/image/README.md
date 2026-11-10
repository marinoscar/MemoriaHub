# image

Image preparation: EXIF orientation, downscaling, the orientation edit transforms and the ffmpeg-transcode fallback for formats the bundled libvips cannot decode (HEIC).

## Purpose and scope

Image preparation: EXIF orientation, downscaling, the orientation edit transforms and the ffmpeg-transcode fallback for formats the bundled libvips cannot decode (HEIC). All image compute obtains its pixels here.

Pure compute only: no framework import, no environment read, no persistence. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-compute/image`. `image/index.ts`: `prepareImageForProcessing`, `applyOrientationTransform`, `getOrientedDimensions`, `transcodeToDecodableJpeg`, `setComputeLogger`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`sharp` (exact-pinned dependency of the package), loaded lazily; the `ffmpeg` slice for the fallback.

## Configuration

None. A host calls `setComputeLogger` once at start-up to route warnings to its logger.

## Extension-point catalog

None. The slice exposes functions and data shapes, not extension points.
