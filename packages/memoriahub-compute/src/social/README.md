# social

The pure rule engine that classifies a video as re-shared from TikTok, Instagram or Facebook from container metadata, filename, caption signals and OCR text.

## Purpose and scope

The pure rule engine that classifies a video as re-shared from TikTok, Instagram or Facebook from container metadata, filename, caption signals and OCR text. Zero IO; the same rule catalog runs on the server and on a node.

Pure compute only: no framework import, no environment read, no persistence. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-compute/social`. `social/index.ts`: `detectTier1`, `detectCaptionSignal`, `detectFromOcr`, `computeOcrTimestamps` and the input and result types. Other slices are imported only through their `index.ts`.

## Peer dependencies

None.

## Configuration

None. The rule sets are module-level data; adding a platform is a data-only change.

## Extension-point catalog

None. The slice exposes functions and data shapes, not extension points.
