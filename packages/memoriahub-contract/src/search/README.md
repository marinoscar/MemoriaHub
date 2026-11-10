# search

Wire schemas of deterministic search: the search request with its people, near and date-range filter values.

## Purpose and scope

Wire schemas of deterministic search: the search request with its people, near and date-range filter values.

Wire shapes only: no framework import, no environment read, no behaviour beyond parsing. The schemas are permanent: add fields, never rename or remove one, and change a limit only with the API in the same release. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-contract/search`. `search/index.ts` exports `searchQuerySchema` and the three filter value schemas. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes schemas, inferred types and constants, not extension points.
