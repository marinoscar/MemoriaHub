# people

People and faces on the web: the People page, the archived-faces page, the person cards and grids, the face crop and the merge and purge dialogs, and the clients and hooks behind them.

## Purpose and scope

`people/headless` carries the clients over the host's API client: the people of a circle (`listPeople`, `getPerson`, `createPerson`, `updatePerson`, `setPersonFavorite`, `mergePeople`, `deletePerson`, `assignFaces`, `unassignFace`, `clusterUnknownFaces`, the bulk hide, unhide and purge calls for people and for unassigned faces, `deleteCircleBiometrics`), the faces of one media item (`getMediaFaces`, `getMediaFaceStatus`, `rerunMediaFaces`) and the manual association (`addPersonToMedia`, `removePersonFromMedia`), with the wire types (`PersonListItem`, `PersonDetail`, `DetectedFaceDto`, `BoundingBox`, `UnassignedFaceDto`, ...). The hooks are `usePeople`, `usePerson`, `useUnassignedFaces` and `useMediaFaces` (which polls a running detection to a terminal status). `people/ui` carries `PeoplePage`, `ArchivedFacesPage`, `PersonAvatar`, `PersonCard`, `PersonGrid`, `FaceCrop`, `FaceThumbGrid`, `UnknownFacesReview`, `MergePeopleDialog`, `PurgeFacesDialog` and the media-detail face panels: `FaceThumbnails` (a photo's detected faces), `VideoFacePanel` (a video's identities with their moments), `FaceMarkerStrip` (the markers under a video's seek bar) and `AssignFaceDialog`.

The face settings admin API, hook and page are the `face` slice's, kept apart from the people clients because they configure the provider and need an admin permission. Staying in the app for now: the four host-slot bridges (`media.personMultiSelect`, `media.albumPeopleDialog`, `search.peopleExplore`, `workflows.personSelect`), whose components read this slice's hooks and avatar.

## Entry point

`@marinoscar/memoriahub-web/people/headless` and `@marinoscar/memoriahub-web/people/ui`. The slice imports `core` and `media` (the media clients `getMedia` and `listMedia`) through their entries.

## Peer dependencies

`react` and `react-dom` for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material`, `react-router-dom` and `react-easy-crop` (the cover-face crop of the People page).

## Configuration

None of its own. It reads the host's API client and owner scope.

## Extension-point catalog

None: the slice registers no slot of its own.
