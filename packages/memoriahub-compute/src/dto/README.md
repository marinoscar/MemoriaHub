# dto

The result contracts of the node-eligible job types: the Zod schemas a worker node submits and the API validates, so both sides use the same shapes.

## Purpose and scope

The result contracts of the node-eligible job types: the Zod schemas a worker node submits and the API validates, so both sides use the same shapes.

Pure compute only: no framework import, no environment read, no persistence. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-compute/dto`. `dto/index.ts`: one `<jobType>ResultSchema` and its inferred type per job type. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod` (dependency of the package).

## Configuration

None. The schemas are permanent wire shapes: add fields, never rename or remove one.

## Extension-point catalog

None. The slice exposes functions and data shapes, not extension points.
