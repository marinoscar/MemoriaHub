---
"@marinoscar/memoriahub-api": minor
---

Add `ExifCarryoverService` to the `enhancement` slice of `@marinoscar/memoriahub-api` (private): the best-effort EXIF, GPS, IPTC, XMP and ICC carry-over with the AI marker for enhanced images, over `exiftool-vendored`, which is a new optional peer of the package (imported lazily; a missing package or perl keeps the unstamped bytes). `EnhancementModule.forRoot` provides and exports it and the host's `ENHANCEMENT_IMAGE_TOOLS` binding delegates to it. Behaviour is unchanged.
