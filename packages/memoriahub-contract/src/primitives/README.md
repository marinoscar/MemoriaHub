# primitives

Building blocks shared by every wire schema: the ISO date-time fields, the `bbox` query encoding, the lenient admin date bound and the IANA time-zone check.

## Purpose and scope

Building blocks shared by every wire schema: the ISO date-time fields, the `bbox` query encoding, the lenient admin date bound and the IANA time-zone check.

Wire shapes only: no framework import, no environment read, no behaviour beyond parsing. The schemas are permanent: add fields, never rename or remove one, and change a limit only with the API in the same release. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-contract/primitives`. `primitives/index.ts` exports `isoDateTime`, `isoDateTimeInput`, `bboxInput`, `flexibleDate`, `isSupportedTimeZone`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes schemas, inferred types and constants, not extension points.
