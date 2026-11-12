---
"@marinoscar/memoriahub-api": minor
---

Add `mediaSyncReportedApps` and `mediaSyncDevicesBehind` to the `media` slice of `@marinoscar/memoriahub-api` (private): the two queries a host's Android app slice asks of Media Sync (the application and signer pairs active devices report, and how many run an older build of the current release), over the database port. Behaviour is unchanged.
