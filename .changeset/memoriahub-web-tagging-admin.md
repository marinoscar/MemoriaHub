---
"@marinoscar/memoriahub-web": minor
---

Move the tagging admin pages into the `tagging` slice of `@marinoscar/memoriahub-web` (private): `TagsPage` (the admin vocabulary, with its column declaration), `TaggingSettingsPage` (the global toggle, the video cost levers, the backfill) and `runTaggingBackfill` in `tagging/headless`. They read the data table, the admin page header and the system-settings hook from the host's admin port. The web app mounts the packaged settings page on the same route; nothing changes for users.
