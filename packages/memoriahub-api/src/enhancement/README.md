# enhancement

The AI Picture Enhancer slice of the MemoriaHub domain (RETRO-J10, #624).

## Purpose and scope

Photo-only, human-reviewed enhancement through a model image edit: the result is staged, a person reviews a side-by-side compare, and chooses keep both (a new media item), replace (the original's bytes are overwritten) or discard. `MediaEnhancementService` starts one enhancement or a bulk batch (a selection or a server-resolved filter, capped by `pictureEnhancement.maxBatchSize`), lists, polls, applies and discards, and inspects and cancels batches (progress is derived from the enhancement rows, never stored). `PictureEnhancementHandler` is the `picture_enhancement` job, SERVER-ONLY permanently: it calls `MEMORIAHUB_AI` (`forSystem`, the `picture_enhance` feature), declares `usesAi` and never the node result pair, names the `enhance` throttle bucket, and mirrors the queue's retry and rate-limit decision into its row (a retryable failure leaves the row actionable, only the last breath marks it failed). `PictureEnhancementPurgeHandler` (`picture_enhancement_purge`) expires staged previews past `pictureEnhancement.retentionHours` and `PictureEnhancementPurgeTask` is the enqueue-only hourly cron. Type strings and profiles never change (10 minutes, 3 attempts; the purge 10 minutes, 2). `MediaEnhancementController`, `EnhancementBatchesController` and `AdminEnhancementController` are exported classes the host mounts. Does not own: the native image libraries and the file-level metadata carry-over (sharp, ExifTool), the deployment key status, the AI feature registration, the post-upload processing the keep-both and replace paths re-run. Status: experimental until the first published release.

A cancelled batch deletes its still-pending `picture_enhancement` rows from the queue's table through the database port (`job`, matched on the enhancement id in the payload); everything else reaches the queue through the jobs port.

## Entry point

`@marinoscar/memoriahub-api/enhancement` (and `@marinoscar/memoriahub-api/enhancement/testing`). It imports the `ports`, `core` and `media` slices through their `index.ts` (the metadata sync, the thumbnail signer, the upload fan-out, the media filter builders) and nothing else of the package.

## Peer dependencies

`@nestjs/common`, `@nestjs/schedule` (the cron), `@nestjs/swagger`, `nestjs-zod`, `@marinoscar/memoriahub-compute` (`image`: the orientation pre-pass of the model input) and `@marinoscar/memoriahub-contract` (`enhancement`: the request and query schemas).

## Configuration

`EnhancementModule.forRoot({ providers, imports, rateLimitMaxHits, housekeepingEnabled })`: `providers` binds the five hooks below, `imports` lists the host module that provides `MediaMetadataSyncService` (the host binds its location hook) and the ones the bindings use, `rateLimitMaxHits` is the queue's budget of provider rate-limit deferrals (default 10), `housekeepingEnabled` says whether this instance schedules the purge (false on an instance with no worker). Import it once in the host and list the three controllers in the module where the routes belong (`MediaEnhancementController` after the media controller's static routes). Settings: `features.pictureEnhancement` (kill switch `PICTURE_ENHANCEMENT_ENABLED`), the `pictureEnhancement` namespace (`defaultQuality`, `defaultStrength`, `stampExif`, `allowReplace`, `blockReplaceOnDownscale`, `maxInputMegapixels`, `retentionHours`, `maxBatchSize`) and the `ai.features.enhance` model selection.

## Extension-point catalog

| Symbol | Kind | What the host does |
|---|---|---|
| `ENHANCEMENT_IMAGE_TOOLS`, `EnhancementImageTools` | token, interface | required: the three operations that need a native library: the thumbnail of the staged bytes, the real pixel size of the returned image and the best-effort EXIF, GPS, IPTC, XMP and ICC carry-over with the AI marker (the host's `carryOverMetadata` delegates to the packaged `ExifCarryoverService`) |
| `ENHANCEMENT_KEY_STATUS`, `EnhancementKeyStatus` | token, interface | required: whether the deployment holds a usable key for a provider (the admin status route), with no key material |
| `ENHANCEMENT_STORAGE_ORG`, `EnhancementStorageOrg` | token, interface | required: the organization a derived storage row (the object of a keep-both) is stamped with |
| `ENHANCEMENT_OPTIONS`, `EnhancementModuleOptions` | token, interface | set by `forRoot`: the rate-limit budget and the housekeeping switch |

The host also binds the media slice's `MEDIA_OBJECT_REPROCESSOR` and `MEDIA_THUMBNAIL_PRUNER` (a destructive replace reprocesses, then awaits the media item sync, then prunes the superseded thumbnails) and registers the `picture_enhance` AI feature with the model runtime.

`describeEnhancementSliceConformance` (`./enhancement/testing`) proves the queue contract: both job types register through the jobs port, `picture_enhancement` is server-only (`usesAi`, no node pair, the permanent profile and throttle bucket) and the cron only enqueues the housekeeping job, only on a worker instance.

**The EXIF carry-over (RETRO-J10, #624).** `ExifCarryoverService` (`forRoot()` provides and exports it) copies the original's EXIF, GPS, IPTC, XMP and ICC onto the enhanced JPEG, forces the orientation to the numeric `1` (the `#` suffix: the plain assignment lands on "Rotate 180"), stamps the real output size, drops the embedded previews and writes the AI marker (`Software` and `XMP-xmp:CreatorTool` = `MemoriaHub AI Enhance (<model>)`, `XMP-iptcExt:DigitalSourceType` = the IPTC `compositeWithTrainedAlgorithmicMedia` code). `exiftool-vendored` is an OPTIONAL peer of the package, imported lazily; on POSIX it needs `perl` on the host's `PATH`. Strictly best-effort as before: a missing package or perl, an unwritable temp directory or corrupt input returns the enhanced bytes unchanged and never throws. Its spec runs the real ExifTool against `test/fixtures/exif-source-sample.jpg`.
