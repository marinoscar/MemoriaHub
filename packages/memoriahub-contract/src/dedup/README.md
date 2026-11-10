# dedup

Wire schemas of near-duplicate detection: the review-queue query, the resolve and dismiss bodies and the threshold bulk actions.

## Purpose and scope

Wire schemas of near-duplicate detection: the review-queue query, the resolve and dismiss bodies and the threshold bulk actions.

Wire shapes only: no framework import, no environment read, no behaviour beyond parsing. The schemas are permanent: add fields, never rename or remove one, and change a limit only with the API in the same release. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-contract/dedup`. `dedup/index.ts` exports one `<name>Schema` and its inferred type per request. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes schemas, inferred types and constants, not extension points.
