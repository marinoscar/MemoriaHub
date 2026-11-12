---
"@marinoscar/memoriahub-web": minor
---

Add the `face` slice to `@marinoscar/memoriahub-web` (private): the face settings admin clients (`getFaceSettings`, `putFaceCredentials`, ..., the global backfill calls), `useFaceSettings` and `FaceSettingsPage`. The admin port gains `SecretField` (the host's write-only secret input; its `sx` is a plain object so a headless entry imports no MUI) and the settings document the `face` namespace (`MemoriahubFaceSettings`); the fake admin port serves a plain-HTML `SecretField`. The web app binds the platform's `SecretField` in `platform-memoriahub/admin.tsx` and keeps the page in its admin section registry.
