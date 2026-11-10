# errors

Machine-readable `details.reason` codes of the domain: the Media Sync refusals and the retired public-share route. The error `code` is derived from the HTTP status; clients key off `details.reason`. Platform reasons (storage upload, identity) come from `@marinoscar/platform-contract`.

## Purpose and scope

Machine-readable `details.reason` codes of the domain: the Media Sync refusals and the retired public-share route. The error `code` is derived from the HTTP status; clients key off `details.reason`. Platform reasons (storage upload, identity) come from `@marinoscar/platform-contract`.

Wire shapes only: no framework import, no environment read, no behaviour beyond parsing. The schemas are permanent: add fields, never rename or remove one, and change a limit only with the API in the same release. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-contract/errors`. `errors/index.ts` exports `MEDIA_SYNC_ERROR_REASONS`, `SHARE_ERROR_REASONS` and their union types. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes schemas, inferred types and constants, not extension points.
