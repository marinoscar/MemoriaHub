# Bulk Uploads on a Cheap VPS — Memory Tuning & Runbook

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | July 2026 |

Running MemoriaHub on an inexpensive, memory-constrained VPS is a core design goal. But a **bulk upload of thousands of photos** is the single most demanding thing the app does: each photo fans out into ~5 enrichment jobs (face detection, auto-tagging, burst detection, duplicate detection, location inference), all processed **in-process** by the enrichment worker, and the AI/image work is memory-heavy. On a small container this can push the process into an **out-of-memory (OOM) crash loop** that manifests as `502 Bad Gateway` across the whole app.

This document explains *why* that happens and *exactly which knobs* to turn. It is the operator runbook for large imports.

Cross-references: [Bulk Import Resilience](bulk-import-resilience.md) (retry/backoff/stuck-recovery mechanics) · [Enrichment Queue](enrichment-queue.md) (worker config reference) · [Job Queue Insights](job-insights.md) (the monitoring dashboard)

---

## TL;DR — if your API is 502-ing during a bulk import

It is almost certainly an OOM kill, not an app bug. Do this, in order:

1. **Set a heap cap** (the single most effective change):
   `NODE_OPTIONS=--max-old-space-size=<~55% of the container's memory limit>` (e.g. `320` for a 512MB container).
2. **Keep concurrency at 1** on a 512MB container: `ENRICHMENT_WORKER_CONCURRENCY=1`.
3. Restart the API (env change only — no rebuild needed) and watch it survive past ~60s.
4. Once stable, recover any casualties: `POST /api/admin/jobs/reset-stuck {"olderThanMinutes":5}` then `POST /api/admin/jobs/retry-failed`.

Everything below is *why* those work and how to size them for larger boxes.

---

## 1. The mental model: two separate memory pools

The mistake that costs people hours is assuming `--max-old-space-size` controls the process's total memory. **It does not.** A Node process has two distinct memory pools:

| Pool | What lives there | Governed by |
|------|------------------|-------------|
| **V8 JS heap** | JavaScript objects, closures, the request/response graph | `--max-old-space-size` |
| **Off-heap / native** | Decoded image buffers, ONNX/CLIP + face-model inference working sets, the GeoNames reverse-geocode dataset, `sharp`/libvips buffers, Prisma's native engine, Node/libuv internals | **Nothing you set with `--max-old-space-size`** |

The container's **cgroup memory limit** (the `deploy.resources.limits.memory` in `prod.compose.yml`) is enforced on **total RSS = heap + off-heap**. When total RSS crosses the limit, the Linux kernel **immediately `SIGKILL`s the process** — no warning, no graceful degradation, no chance for the app to shed load. Then `restart: unless-stopped` brings it back, it runs for ~40–60s, and gets killed again: a **crash loop**.

**Key consequence:** the memory that *bulk-import concurrency* consumes is almost entirely **off-heap** (decoded images + model inference). So raising or lowering `--max-old-space-size` does **not** directly control the cost of concurrency — but it *does* keep the JS heap from crowding out the room the off-heap pool needs, and (crucially) it forces V8 to garbage-collect proactively instead of lazily.

---

## 2. Why bulk imports specifically trigger this

- **Fixed baseline cost** (resident the whole time, regardless of load): Node + NestJS, the CLIP ViT-B/32 model (~87 MB), the face model, and the offline GeoNames dataset (loaded synchronously at boot — it can block the event loop for several seconds). This baseline is a large fraction of a 512MB budget before a single photo is processed.
- **Per-concurrent-job cost:** each in-flight job holds a **fully-decoded image buffer** (size scales with `TAG_MAX_IMAGE_DIM` / `FACE_MAX_IMAGE_DIM`) plus the model's inference working set. With `ENRICHMENT_WORKER_CONCURRENCY=N`, you pay roughly **N×** this on top of baseline.
- **No idle breathing room:** the enrichment worker is a continuous pool — it claims the next job the instant the previous finishes, back-to-back, for as long as there's backlog. That means the process is *always* holding those buffers and rarely goes idle, so V8's garbage collector never gets a natural quiet moment to reclaim them **unless you force it** with a heap cap set well below the container limit. (This is exactly why `--max-old-space-size` turned out to be the decisive lever in practice: it makes V8 collect eagerly rather than waiting for a pressure signal that arrives *after* the cgroup has already killed it.)

---

## 3. The levers, in priority order

Set these in `infra/compose/.env` (they take effect on an API restart — no image rebuild needed).

1. **`NODE_OPTIONS=--max-old-space-size=<MB>`** — the highest-leverage knob.
   Set it to roughly **50–60% of the container's memory limit**. This forces proactive GC and prevents the JS heap from starving the off-heap pool. On a 512MB container, `320` is a good value.

2. **`ENRICHMENT_WORKER_CONCURRENCY`** — the primary *memory multiplier*.
   This is how many jobs run at once, and therefore how many decoded-image + inference buffers are resident simultaneously. **On 512MB, keep this at `1`.** Raising it is the fastest way back into an OOM loop on a small box.

3. **`TAG_MAX_IMAGE_DIM` / `FACE_MAX_IMAGE_DIM`** — shrink the per-job buffer.
   Default is `1568`. Lowering to **`1024` or `768`** materially reduces the memory each concurrent job holds, at a small accuracy cost. This is often the *cheapest* way to make higher concurrency fit without buying more RAM.

4. **Container `memory:` limit** (`prod.compose.yml`) — raise **only if the host has the RAM**.
   Concurrency scales with this. If you want concurrency 4, you need the limit high enough to hold baseline + 4× per-job — realistically ~1–1.25 GB.

5. **`VIDEO_ENRICHMENT_MAX_BYTES`** — the video-specific escape hatch.
   Photo levers above don't help with video: a `video_face_detection` / `social_media_detection` job streams the whole video to a `memoriaHub-*` temp file, so its dominant cost is **disk** (temp space), not the JS heap. Set a byte cap (e.g. a few hundred MB) to skip huge videos entirely — no download — in both handlers. `0` (default) processes all sizes. A disk-space pre-flight guard (free space `>= size × 1.2`) and an hourly `TempFileJanitorTask` orphan sweep back this up (see §6), but a cap is what keeps a multi-GB clip from ever touching the disk. If, conversely, large *legitimate* videos are being killed as "timed out", raise `ENRICHMENT_VIDEO_JOB_TIMEOUT_MS` (default 20 min, vs. the 10-min `ENRICHMENT_JOB_TIMEOUT_MS` for non-video jobs) rather than the photo levers.

> **A heap cap does not make higher concurrency safe by itself.** Concurrency's cost is off-heap; the only things that make concurrency > 1 safe are a bigger container limit and/or smaller per-job buffers (`*_MAX_IMAGE_DIM`). Video cost is different again — it's temp disk, bounded by `VIDEO_ENRICHMENT_MAX_BYTES`, not RAM.

---

## 4. Recommended presets by container size

| Container limit | `ENRICHMENT_WORKER_CONCURRENCY` | `NODE_OPTIONS=--max-old-space-size` | `*_MAX_IMAGE_DIM` | Notes |
|---|---|---|---|---|
| **512 MB** (cheap VPS) | `1` | `320` | `1024` | Field-proven stable for a ~20k-job import. Slower but resilient. |
| **1 GB** | `2` | `576` | `1024`–`1568` | Step up gradually; watch `dmesg` after each bump. |
| **2 GB+** | `4` | `1024` | `1568` (default) | Comfortable for aggressive throughput. |

Rule of thumb: `--max-old-space-size` ≈ **55% of the container limit**, leaving the rest for the resident models + `concurrency ×` per-job image buffers. When raising concurrency, **step up one at a time** (1 → 2 → 3), watching `dmesg` for a few minutes at each step, rather than jumping straight to 4.

---

## 5. Diagnosing an OOM crash loop

The symptom is `502 Bad Gateway` on `/api/...` requests — because Nginx has no healthy API container to proxy to. Confirm it's memory:

```bash
# 1. Is the container crash-looping (short/rising uptime, "Restarting")?
sudo docker compose -f base.compose.yml -f prod.compose.yml ps -a

# 2. The smoking gun — kernel OOM kills of the Node process:
sudo dmesg -T | grep -i "out of memory\|killed process" | tail -20
```

An OOM kill looks like this, and the tell is `node-MainThread` with `anon-rss` landing right around your container limit, repeating every ~40–60s:

```
Memory cgroup out of memory: Killed process 3466723 (node-MainThread) total-vm:18433032kB, anon-rss:496944kB, file-rss:77952kB ... oom_score_adj:0
```

Also confirm the boot line shows the concurrency you expect (the worker logs it on startup):

```bash
sudo docker compose -f base.compose.yml -f prod.compose.yml logs api | grep "pool size"
# → EnrichmentJobWorker starting; pool size 1, poll interval 5000ms
```

> **Gotcha — compose overrides.** The `memory: 512M` limit lives in `prod.compose.yml`. It only applies if you launch with **both** files: `docker compose -f base.compose.yml -f prod.compose.yml up -d`. A bare `docker compose up` may not load the prod override at all, meaning the container runs **uncapped** — which changes the whole calculus (uncapped is fine if the host has RAM).

---

## 6. Recovering after a rough run

Restarts and OOM kills leave debris. None of it is lost data — jobs live in Postgres and the handlers are idempotent — but you may need to nudge things:

- **Orphaned `running` jobs** (killed mid-flight; there is no graceful drain on a hard restart):
  `POST /api/admin/jobs/reset-stuck {"olderThanMinutes":5}` flips them back to `pending` immediately. An hourly cron (`ENRICHMENT_STUCK_MINUTES`, default 15) also does this automatically, but the manual call skips the wait.
- **Failed jobs**: `POST /api/admin/jobs/retry-failed` (optionally `{"type":"..."}` to scope) requeues them.
- **Monitor progress**: `/admin/settings/jobs/insights` (or `GET /api/admin/jobs/insights`) shows live counts, throughput, per-type ETA, and lifetime totals.
- **Orphaned `StorageObject`s stuck at `status='processing'`** (upload-time thumbnail/EXIF/dimensions pipeline killed mid-flight — a *separate* system from the `enrichment_jobs` above, since it isn't a queued job at all): symptom is photos/videos showing a permanent "Processing…" spinner in the gallery. `POST /api/admin/media/reprocess-stuck {"olderThanMinutes":5}` recovers them immediately; `StorageProcessingRecoveryTask` (`STORAGE_PROCESSING_STUCK_MINUTES`, default 10) also does this automatically. See [Bulk Import Resilience § Stuck StorageObject auto-reset cron](bulk-import-resilience.md#stuck-storageobject-auto-reset-cron-new--storageprocessingrecoverytask) for the full mechanism, including the retry-cap/OOM-during-recovery correctness detail.
- **Missing thumbnails** (`StorageObject` reached `status IN ('ready','failed')` but the `MediaItem` never picked up a `thumbnailStorageKey` — e.g. an old ffmpeg failure, or a sync interrupted mid-flight): no manual action needed in most cases. The hourly `ThumbnailRepairTask` cron self-heals these in the background; `POST /api/admin/media/thumbnails/repair` drains the backlog immediately without waiting for the next tick.

Reprocessing interrupted jobs is safe: face detection re-detects, auto-tagging overwrites its own `source='ai'` tags, geocode/metadata recompute, duplicate/burst detection are read-time non-destructive. No duplicates, no corruption. The same applies to reprocessing a stuck `StorageObject` — content-hash is deterministic and thumbnail upload is an idempotent upsert.

The video thumbnail/probe path has also been hardened since the reference run below: video downloads now stream to a temp file with constant memory instead of buffering the whole MP4 in RAM, which was a significant OOM contributor on constrained VPS deployments — reducing how often you'll hit the recovery steps above during video-heavy imports. Two further guards protect the **temp disk** those streamed downloads use: a **disk-space pre-flight** (`assertDiskSpaceForDownload`) refuses a video download unless free space `>= object size × 1.2`, failing the job fast through the normal retry path instead of half-filling the disk; and the **`TempFileJanitorTask`** sweeps `memoriaHub-*` temp files older than 6h from `os.tmpdir()` on startup and hourly, reclaiming orphans left when a job is OOM-`SIGKILL`ed mid-download before its cleanup runs. Cap the largest videos out entirely with `VIDEO_ENRICHMENT_MAX_BYTES` (see §3, lever 5).

---

## 7. What a real bulk run looks like (reference numbers)

These are measured figures from a production import of ~4,200 photos on a **512 MB** container at **`ENRICHMENT_WORKER_CONCURRENCY=1`** with the heap cap in place — roughly **19–20k enrichment jobs total** (~5 per photo). Use them to sanity-check your own run and set expectations.

**Lifetime totals (all-time, survives history purges):**

| Metric | Value |
|---|---|
| Total processed | **19.1K** (succeeded + failed) |
| Succeeded | **18.9K** |
| Failed | **116** |
| Avg duration | **803 ms** (over 18.9K samples) |

**Per-type breakdown** (avg / p95 duration, sustained throughput at concurrency 1, all-time count):

| Job type | Avg | p95 | Throughput | All-time |
|---|---|---|---|---|
| `auto_tagging` | 2 s | 4 s | 13.3/min | 4,290 |
| `face_detection` | 1 s | 4 s | 6.4/min | 4,239 |
| `duplicate_detection` | 465 ms | 1 s | 7.4/min | 1,807 |
| `burst_detection` | 41 ms | 154 ms | 6.3/min | 4,239 |
| `location_inference` | 36 ms | 121 ms | 6.5/min | 4,242 |
| `video_face_detection` | 4 s | 7 s | — | 16 |
| `social_media_detection` | 2 s | 4 s | — | 8 |
| `storage_insights` / `trash_purge` / `job_history_purge` | ~150–350 ms | ~0.6–1 s | — | (global maintenance jobs) |

**Reading these numbers:**
- **`auto_tagging` dominates the wall-clock.** It was ~99% of the remaining backlog and the slowest high-volume type (avg 2s, because it round-trips to OpenAI for tags **and** an embedding per photo). The whole-queue ETA tracks auto-tagging almost exactly. The lightweight types (`burst`, `location_inference`, `duplicate`) drain quickly and are rarely the bottleneck.
- **Most heavy work is I/O-bound, not CPU-bound.** `auto_tagging` waits on OpenAI; `face_detection` waits on the CompreFace sidecar. That's *why* concurrency helps throughput so much on a bigger box — the slots spend most of their time waiting on the network, not pegging the single JS thread — but each waiting slot still holds a decoded image buffer, which is *why* it costs memory even while idle-waiting.
- **Sustained throughput at concurrency 1** was ~13/min for tagging → a ~1,000-job tagging backlog is ~38 minutes. Scale roughly linearly with concurrency once you have the RAM to raise it.
- **The 116 failures** were almost entirely operational, not data problems: a boot-time handler-registration race (since fixed — see §8) plus jobs interrupted by the OOM kills. All were recoverable via `retry-failed`.

---

## 8. Postmortem lessons (things learned the hard way)

- **Continuous processing removed the GC breathing room.** The worker pool claims jobs back-to-back with no idle gap. Without a heap cap forcing eager GC, decoded-image/model buffers accumulated faster than they were reclaimed and the container OOM-looped. `NODE_OPTIONS=--max-old-space-size` set well below the container limit is what compensates.
- **cgroup OOM kills are invisible from inside the app.** The process just vanishes (`SIGKILL`); there's no catchable error and nothing in the app logs. Always check `dmesg` — it's the only place the truth shows up.
- **No graceful shutdown.** `main.ts` does not call `enableShutdownHooks()`, so any restart (deploy, OOM, manual) kills in-flight jobs mid-processing. They're recoverable (`reset-stuck`), but expect to run that after every restart during a big import.
- **Concurrency is a memory decision, not just a speed decision.** On a fixed container limit, the safe concurrency is whatever leaves headroom above `baseline + concurrency × per-job`. Treat `ENRICHMENT_WORKER_CONCURRENCY` and the container `memory:` limit as a *matched pair*.
- **`*_MAX_IMAGE_DIM` is the underused lever.** Shrinking decoded-image size is often a better trade than throttling to concurrency 1, because it lets multiple slots coexist in the same budget.

---

## 9. Related configuration

All the environment variables referenced here are documented in full in [Enrichment Queue → §13 Configuration](enrichment-queue.md#13-configuration), including the retry/backoff and rate-limit knobs. The provider rate-limit classification matrix and CLI-side resilience live in [Bulk Import Resilience](bulk-import-resilience.md).

---

## Document History

| Version | Date | Author | Change |
|---|---|---|---|
| 1.0 | July 2026 | AI Assistant | Initial runbook: two-pool memory model (V8 heap vs off-heap), why bulk imports OOM, the four tuning levers, per-container-size presets, OOM diagnosis via dmesg, post-run recovery, and reference throughput/failure numbers from a real ~20k-job / ~4,200-photo import on a 512MB container |
| 1.1 | July 2026 | AI Assistant | Added the video-specific tuning lever (§3 lever 5): `VIDEO_ENRICHMENT_MAX_BYTES` size cap (skip huge videos, no download) and `ENRICHMENT_VIDEO_JOB_TIMEOUT_MS` (20-min per-type video timeout); documented the temp-disk guards in §6 — `assertDiskSpaceForDownload` disk pre-flight and the `TempFileJanitorTask` orphan sweep |
