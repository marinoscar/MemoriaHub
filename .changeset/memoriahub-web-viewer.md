---
"@marinoscar/memoriahub-web": minor
---

Add the `viewer` slice to `@marinoscar/memoriahub-web` (private): `MediaLightbox`, `MediaDetailDrawer` and `VideoPlayer` (the `ui` entry takes `@vidstack/react` as an optional peer), over the `media`, `people`, `tagging`, `review` and `enhancement` slices. The media pages still reach the lightbox and the drawer through the `media.lightbox` and `media.detailDrawer` host slots, which the web app now binds to the packaged components. The platform's inline public-link controls are the viewer's own host slot (`viewer.linkSharePanel`).
