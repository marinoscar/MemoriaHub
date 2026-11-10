# face-compreface

CompreFace Core (keyless) face detection over HTTP: multipart request, response parsing, L2 normalization and the `/status` connectivity probe.

## Purpose and scope

CompreFace Core (keyless) face detection over HTTP: multipart request, response parsing, L2 normalization and the `/status` connectivity probe. `baseUrl` is an explicit parameter.

Pure compute only: no framework import, no environment read, no persistence. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-compute/face-compreface`. `face-compreface/index.ts`: `detectComprefaceFaces`, `testComprefaceStatus` and the provider constants. Other slices are imported only through their `index.ts`.

## Peer dependencies

None beyond Node built-ins (the global `fetch`, `FormData` and `Blob`).

## Configuration

None. The base URL is a parameter of each call.

## Extension-point catalog

None. The slice exposes functions and data shapes, not extension points.
