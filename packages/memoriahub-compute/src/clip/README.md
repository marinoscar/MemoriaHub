# clip

CLIP ViT-B/32 visual embedding compute: preprocessing, session creation from an explicit model path, inference and L2 normalization.

## Purpose and scope

CLIP ViT-B/32 visual embedding compute: preprocessing, session creation from an explicit model path, inference and L2 normalization. A vector computed on a worker node is numerically identical to one computed on the server for the same bytes.

Pure compute only: no framework import, no environment read, no persistence. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-compute/clip`. `clip/index.ts`: `preprocessImageForClip`, `createClipSession`, `embedImageWithSession`, `releaseClipSession`, `l2Normalize`, `looksLikeOnnxModel` and the model constants. Other slices are imported only through their `index.ts`.

## Peer dependencies

`onnxruntime-node` (exact-pinned dependency of the package) and `sharp`, through the `image` slice. Both are dependencies of the package, not peers.

## Configuration

None. The model path and the recycle threshold are explicit parameters; the slice reads no environment variable and downloads nothing (the host owns the model file).

## Extension-point catalog

None. The slice exposes functions and data shapes, not extension points.
