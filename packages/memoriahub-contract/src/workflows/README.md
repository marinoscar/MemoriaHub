# workflows

Wire schemas of media workflow automation: the versioned Subject, Trigger, If, Then definition document, the workflow and run request bodies and queries, the admin oversight queries and the trigger and run-status vocabulary.

## Purpose and scope

Wire schemas of media workflow automation: the versioned Subject, Trigger, If, Then definition document, the workflow and run request bodies and queries, the admin oversight queries and the trigger and run-status vocabulary.

Wire shapes only: no framework import, no environment read, no behaviour beyond parsing. The schemas are permanent: add fields, never rename or remove one, and change a limit only with the API in the same release. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-contract/workflows`. `workflows/index.ts` exports `workflowDefinitionSchema`, the request schemas, `WORKFLOW_TRIGGERS`, `WORKFLOW_RUN_STATUSES`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes schemas, inferred types and constants, not extension points.
