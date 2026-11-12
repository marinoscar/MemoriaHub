---
"@marinoscar/memoriahub-web": minor
---

Add the `media-sync` slice to `@marinoscar/memoriahub-web` (private): the Media Sync device clients and hooks, the user-side Android release clients, `MediaSyncPage`, `AndroidAppDownloadPage` and the device card pieces. The host gains an optional Android port (`MemoriahubWebHost.android`, `useMemoriahubAndroid`): the app identity, the Trusted Web Activity helpers and the release and download-link hooks; the web app binds the platform android-app slice there and keeps the identity drift test against `apps/android/identity.properties`. Presentation only, never authorization.
