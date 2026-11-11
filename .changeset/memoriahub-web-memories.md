---
"@marinoscar/memoriahub-web": minor
---

Add the `memories` slice to `@marinoscar/memoriahub-web` (private): the memories clients and hooks (`memories/headless`) and the Memories page, the detail page with the story player, the feed carousel and the action and album dialogs (`memories/ui`). `core` gains `useCircleRole` and `useLongPress`. The save-as-album flow reaches the share dialog through the media slice's `media.shareDialog` slot. The web app mounts the packaged pages on the same routes; nothing changes for users.
