---
"@marinoscar/memoriahub-web": minor
---

Move the media-detail face panels into the `people` slice of `@marinoscar/memoriahub-web` (private): `FaceThumbnails`, `VideoFacePanel`, `FaceMarkerStrip` and `AssignFaceDialog` are now exports of `people/ui`. The web app's detail drawer imports them from the package.
