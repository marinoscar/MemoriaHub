# Phase 08 — Android Sync (Superseded)

**Previous Phase:** [Phase 07 — Memory Prioritization](phase-07-memory-prioritization.md)
**Next Phase:** [Phase 09 — Long-Term Enrichment](phase-09-longterm-enrichment.md)
**Status:** Superseded

---

> **SUPERSEDED.** The standalone native Android app this document described (package `cr.marin.memoriahub`, `apps/android/`) has been **retired and deleted** (issue #500, epic #498). It is replaced by an Android app built as a Trusted Web Activity (TWA) plus a native Media Sync module.
>
> - Current spec: [docs/specs/android-media-sync.md](../specs/android-media-sync.md) (epic #498)
> - **Uninstall the legacy app manually.** The new app's ID is `memoriahub.marin.cr`, a different package from `cr.marin.memoriahub`, so a phone can have both installed and both would upload.
> - Server features the legacy app used are kept for other clients: `MediaSource.android`, `clientInfo.returnUri` / `sanitizeReturnUri`, and the `/activate` deep-link redirect (see [DEVICE-AUTH.md](../DEVICE-AUTH.md)).
>
> This file is kept only so old links resolve. Do not rely on its contents.

The original phase plan (a PAT-only native app under `apps/android/`) was never completed as written and is no longer maintained.
