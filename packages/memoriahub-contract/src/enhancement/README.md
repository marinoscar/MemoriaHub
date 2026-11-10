# enhancement

Wire schemas of the AI picture enhancer: the enhance parameters, apply, bulk enhance by selection or by filter, the batch list query and the hub list query with its status vocabulary and aliases.

## Purpose and scope

Wire schemas of the AI picture enhancer: the enhance parameters, apply, bulk enhance by selection or by filter, the batch list query and the hub list query with its status vocabulary and aliases.

Wire shapes only: no framework import, no environment read, no behaviour beyond parsing. The schemas are permanent: add fields, never rename or remove one, and change a limit only with the API in the same release. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-contract/enhancement`. `enhancement/index.ts` exports one `<name>Schema` and its inferred type per request, plus `ENHANCEMENT_STATUSES` and `ENHANCEMENT_STATUS_ALIASES`. Other slices: `media`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes schemas, inferred types and constants, not extension points.
