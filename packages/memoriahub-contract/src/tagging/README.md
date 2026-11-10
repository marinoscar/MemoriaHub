# tagging

Wire schemas of AI tagging: the tag-label vocabulary bodies and the admin backfill request.

## Purpose and scope

Wire schemas of AI tagging: the tag-label vocabulary bodies and the admin backfill request.

Wire shapes only: no framework import, no environment read, no behaviour beyond parsing. The schemas are permanent: add fields, never rename or remove one, and change a limit only with the API in the same release. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-contract/tagging`. `tagging/index.ts` exports `createTagLabelSchema`, `updateTagLabelSchema`, `adminTaggingBackfillSchema`. It builds on the `primitives` slice. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes schemas, inferred types and constants, not extension points.
