# social-media

The social-media video detection slice of the MemoriaHub domain (RETRO-J10, #624).

## Purpose and scope

Classifies whether a VIDEO was downloaded or re-shared from TikTok, Instagram, Facebook or another platform, in two tiers: Tier 1 (`SocialMediaDetectorService`, the rule catalog of `@marinoscar/memoriahub-compute/social`: container metadata, filename, caption hashtags) and a Tier-2 OCR fallback (`SocialMediaOcrService`, frames near the start and end of the clip, degraded to Tier-1-only and never throwing when the engine cannot start). `SocialMediaDetectionHandler` is the `social_media_detection` job (type string and node eligibility permanent: it declares `nodeResultSchema` and `persistNodeResult`, a node submits the verdict and the server persists it; the profile is the 20-minute video bucket, three attempts). Its pre-flight stays server-side and cheapest first: the `VIDEO_ENRICHMENT_MAX_BYTES` hard cap, the duration and size caps and the landscape gate decide CLEAN without a byte downloaded. A DETECTED verdict applies the system tags (`Social Media` plus the platform) and the `social_media_source` column and stops the chain; a CLEAN one strips stale tags and fans out the video enrichment that was withheld while the verdict was pending. `SocialMediaUploadEnrichment` registers the video fan-out with the media slice (priority 10, order 300); with detection off it runs that same post-detection fan-out directly. `SocialMediaBackfillService` is the per-item rerun, the status read and the per-circle and global backfill; the two controllers (`SocialMediaMediaController`, `AdminSocialMediaController`) are exported classes the host mounts. Does not own: the post-detection fan-out itself (the host's media enrichment service routes to face detection and video tagging), the settings schema (the `socialMedia` namespace is the host's). Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-api/social-media` (and `@marinoscar/memoriahub-api/social-media/testing`). It imports the `ports`, `core`, `media` and `face` slices through their `index.ts` (the OCR extracts its frames with the face slice's `VideoFrameExtractionService`) and nothing else of the package.

## Peer dependencies

`@nestjs/common`, `@nestjs/swagger`, `nestjs-zod`, `@marinoscar/memoriahub-compute` (`social`, `ocr`, `dto`, `metadata`) and `@marinoscar/memoriahub-contract` (`social`). The OCR engine (`tesseract.js`) is an optional dependency of the compute package.

## Configuration

`SocialMediaModule.forRoot({ providers, imports, videoJobTimeoutMs })`: `providers` binds `SOCIAL_MEDIA_POST_DETECTION`, `imports` lists the host module that provides the face slice (for `VideoFrameExtractionService`) and the one the hook binding needs, `videoJobTimeoutMs` is the job's `maxRuntimeMs` (default 20 minutes). Import it once in the host and list the two controllers in the module where the routes belong. Settings: `features.socialMediaDetection` (kill switch `SOCIAL_MEDIA_DETECTION_ENABLED`) and the `socialMedia` namespace (`minConfidence`, `ocrEnabled`, `ocrMaxFrames`, `ocrLanguages`, `ocrTimeoutSeconds`, `maxDurationSeconds`, `maxSizeBytes`); environment: `VIDEO_ENRICHMENT_MAX_BYTES`, `MODELS_DIR` (the tesseract language data).

## Extension-point catalog

| Symbol | Kind | What the host does |
|---|---|---|
| `SOCIAL_MEDIA_POST_DETECTION`, `SocialMediaPostDetection` | token, interface | required: enqueues the video jobs withheld while a video was being classified (each behind its own gate), best-effort and never throwing |
| `SOCIAL_MEDIA_OPTIONS`, `SocialMediaModuleOptions` | token, interface | set by `forRoot`: the job's `maxRuntimeMs` (`videoJobTimeoutMs`) |

`describeSocialMediaSliceConformance` (`./social-media/testing`) proves the fan-out registration: videos only, priority 10, the `pending` status, the withheld jobs and the direct post-detection fan-out while the feature is off.
