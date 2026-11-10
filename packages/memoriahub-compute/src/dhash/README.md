# dhash

Perceptual hash (dHash) and variance-of-Laplacian sharpness of one image.

## Purpose and scope

Perceptual hash (dHash) and variance-of-Laplacian sharpness of one image. The hash is an unsigned 64-bit value returned as a decimal string, never a bigint.

Pure compute only: no framework import, no environment read, no persistence. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-compute/dhash`. `dhash/index.ts`: `computeVisualHash`, `computeDHash`, `hammingDistance`, `hammingDistanceBigInt`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`sharp` (exact-pinned dependency of the package), through the `image` slice.

## Configuration

None.

## Extension-point catalog

None. The slice exposes functions and data shapes, not extension points.
