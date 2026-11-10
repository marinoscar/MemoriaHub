# review-runs

Wire schemas and vocabulary of the shared review-run engine (bursts, duplicates, location suggestions): the run items query and the subject and action enums.

## Purpose and scope

Wire schemas and vocabulary of the shared review-run engine (bursts, duplicates, location suggestions): the run items query and the subject and action enums.

Wire shapes only: no framework import, no environment read, no behaviour beyond parsing. The schemas are permanent: add fields, never rename or remove one, and change a limit only with the API in the same release. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-contract/review-runs`. `review-runs/index.ts` exports `listReviewRunItemsQuerySchema`, `REVIEW_RUN_SUBJECTS`, `REVIEW_RUN_ACTIONS`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes schemas, inferred types and constants, not extension points.
