# face

Wire schemas of face recognition and people: person create, update and merge bodies, face assignment, the bulk hide, unhide and purge bodies, the unassigned face query and the face provider settings.

## Purpose and scope

Wire schemas of face recognition and people: person create, update and merge bodies, face assignment, the bulk hide, unhide and purge bodies, the unassigned face query and the face provider settings.

Wire shapes only: no framework import, no environment read, no behaviour beyond parsing. The schemas are permanent: add fields, never rename or remove one, and change a limit only with the API in the same release. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-contract/face`. `face/index.ts` exports one `<name>Schema` and its inferred type per request. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes schemas, inferred types and constants, not extension points.
