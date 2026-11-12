# face

Face recognition settings on the web: the admin Face Settings page and the provider clients and hook behind it.

## Purpose and scope

`face/headless` carries the face settings admin API over the host's API client (`getFaceSettings`, `putFaceCredentials`, `deleteFaceCredentials`, `testFaceProvider`, `getFaceModels`, `putFaceDetectionFeature`), the global backfill calls (`runGlobalFaceBackfill`, `runGlobalFaceAutoArchiveBackfill`) with their wire types, and the `useFaceSettings` hook. `face/ui` carries `FaceSettingsPage`: the global face recognition switch, the provider credentials and connectivity test, the detection model, the video face detection card (`face.video.*`), the auto-archive switch, threshold and backlog sweep, and the global backfill.

The page takes its page header, write-only secret input and system-settings hook from the host's admin port (`useMemoriahubAdmin` of `core`) and stays registered in the app's admin section registry. The face clients that belong to the people experience (the people, the faces of a media item, manual association) are the `people` slice's, kept apart because they need no admin permission.

## Entry point

`@marinoscar/memoriahub-web/face/headless` and `@marinoscar/memoriahub-web/face/ui`. The slice imports `core` through its entries.

## Peer dependencies

`react` and `react-dom` for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

None of its own. It reads the host's API client, permissions and admin port.

## Extension-point catalog

None: the slice registers no slot of its own.
