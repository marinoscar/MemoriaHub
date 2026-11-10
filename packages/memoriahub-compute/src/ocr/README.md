# ocr

The Tesseract OCR core of the social-media Tier-2 pass: worker creation with a pinned language directory, a serialized recognize queue, frame preprocessing and per-word confidence filtering.

## Purpose and scope

The Tesseract OCR core of the social-media Tier-2 pass: worker creation with a pinned language directory, a serialized recognize queue, frame preprocessing and per-word confidence filtering.

Pure compute only: no framework import, no environment read, no persistence. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-compute/ocr`. `ocr/index.ts`: `createOcrEngine`, `extractConfidentWords`, the defaults. Other slices are imported only through their `index.ts`.

## Peer dependencies

`tesseract.js` (exact-pinned optional dependency of the package), loaded lazily when an engine is requested; a descriptive error is thrown if it is absent.

## Configuration

None. The language directory is a parameter.

## Extension-point catalog

None. The slice exposes functions and data shapes, not extension points.
