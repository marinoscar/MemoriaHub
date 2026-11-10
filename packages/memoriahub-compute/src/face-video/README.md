# face-video

Cross-frame face clustering for video (greedy single-pass cosine similarity) and the face-centred crop thumbnail.

## Purpose and scope

Cross-frame face clustering for video (greedy single-pass cosine similarity) and the face-centred crop thumbnail. Generic over a host `payload` type.

Pure compute only: no framework import, no environment read, no persistence. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-compute/face-video`. `face-video/index.ts`: `clusterFaceDetections`, `bestMatchAgainstSet`, `buildFaceCropThumbnail`, the default thresholds. Other slices are imported only through their `index.ts`.

## Peer dependencies

`sharp` (exact-pinned dependency of the package), loaded lazily.

## Configuration

None. The cluster threshold is a parameter; the default thresholds are exported constants.

## Extension-point catalog

None. The slice exposes functions and data shapes, not extension points.
