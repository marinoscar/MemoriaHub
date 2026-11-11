---
"@marinoscar/memoriahub-web": minor
---

Add the `tagging` slice to `@marinoscar/memoriahub-web` (private): the per-item tag status and re-run clients with `useMediaTags`, the tag vocabulary clients (list, create, update, delete, CSV export and import) in `tagging/headless`, and `TagsBrowsePage` in `tagging/ui`. The CSV requests go to the host's API root (`baseUrl`) instead of a fixed `/api`, which is the same URL in the web app. The admin vocabulary page and the Tagging settings page stay in the app (they need the platform data table); the web app mounts the packaged browse page unchanged for users.
