---
"@marinoscar/memoriahub-web": minor
---

Add the `people` slice to `@marinoscar/memoriahub-web` (private): the people and face clients, types and hooks (`usePeople`, `usePerson`, `useUnassignedFaces`, `useMediaFaces`) in `people/headless`, and `PeoplePage`, `ArchivedFacesPage`, the person card, grid and avatar, the face crop and the merge and purge dialogs in `people/ui`. `react-easy-crop` becomes an optional peer of the `ui` entry. The face settings admin API, the media-detail face panels and the four people-picker host-slot bridges stay in the app, which now imports them from the package.
