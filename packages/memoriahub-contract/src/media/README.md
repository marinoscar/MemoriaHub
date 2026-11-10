# media

Wire schemas of media items, albums, tags, archive and trash, the gallery and map queries, geocoding queries and the trash-empty runs. `mediaFilterFields` is the shared filter shape that `GET /api/media`, the album by-filter body and the bulk enhance by-filter body all spread.

## Purpose and scope

Wire schemas of media items, albums, tags, archive and trash, the gallery and map queries, geocoding queries and the trash-empty runs. `mediaFilterFields` is the shared filter shape that `GET /api/media`, the album by-filter body and the bulk enhance by-filter body all spread.

Wire shapes only: no framework import, no environment read, no behaviour beyond parsing. The schemas are permanent: add fields, never rename or remove one, and change a limit only with the API in the same release. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-contract/media`. `media/index.ts` exports one `<name>Schema` and its inferred type per request, plus `CreateMediaInput` and `BulkUpdateMediaInput` (the request shapes a client sends). It builds on the `primitives` slice. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes schemas, inferred types and constants, not extension points.
