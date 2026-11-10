# media-sync

Wire schemas and limits of the Android Media Sync companion: device registration, the versioned desired config, commands, check-in, runs and diagnostics, and the vocabulary and limits the schemas, the service and the clients share.

## Purpose and scope

Wire schemas and limits of the Android Media Sync companion: device registration, the versioned desired config, commands, check-in, runs and diagnostics, and the vocabulary and limits the schemas, the service and the clients share.

Wire shapes only: no framework import, no environment read, no behaviour beyond parsing. The schemas are permanent: add fields, never rename or remove one, and change a limit only with the API in the same release. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-contract/media-sync`. `media-sync/index.ts` exports the schemas, the `MEDIA_SYNC_*` vocabularies and the limit constants. It builds on the `primitives` slice. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes schemas, inferred types and constants, not extension points.
