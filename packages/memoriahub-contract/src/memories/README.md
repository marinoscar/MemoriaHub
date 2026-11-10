# memories

Wire schemas of Memories: the list and feed queries, the card, detail and per-user state response shapes, the save-as-album body, the admin backfill body and the memory type vocabulary.

## Purpose and scope

Wire schemas of Memories: the list and feed queries, the card, detail and per-user state response shapes, the save-as-album body, the admin backfill body and the memory type vocabulary.

Wire shapes only: no framework import, no environment read, no behaviour beyond parsing. The schemas are permanent: add fields, never rename or remove one, and change a limit only with the API in the same release. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-contract/memories`. `memories/index.ts` exports the query and response schemas, `MEMORY_TYPES`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes schemas, inferred types and constants, not extension points.
