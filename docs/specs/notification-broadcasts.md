# Admin Notification Broadcasts

| Field | Value |
|-------|-------|
| **Epic** | #481 |
| **Issue** | #488 (documented in #489) |
| **Version** | 1.0 |
| **Last Updated** | August 2026 |
| **Status** | Implemented |
| **Code** | `apps/api/src/notifications/broadcasts/`, `apps/api/src/email/templates/broadcast.email.ts`, `apps/web/src/pages/Admin/BroadcastsPage.tsx`, `apps/web/src/components/admin/{BroadcastComposer,BroadcastDetailDialog}.tsx`, `apps/web/src/{services/broadcasts.ts,hooks/useBroadcasts.ts}` |
| **Builds on** | [Notification Center](notifications.md), [Browser Notifications, Web Push and the Live Stream](browser-notifications.md) |

An administrator composes one announcement and sends it now or on a schedule to **every active user**, over any combination of the inbox, Web Push and email. This spec documents what the code in this repository does. It was ported from EnterpriseAppBase; here it rides on MemoriaHub's `enrichment_jobs` queue and Notification Center rather than EAB's registry.

---

## Table of Contents

1. [What It Is and Is Not](#1-what-it-is-and-is-not)
2. [The Model](#2-the-model)
3. [Content and Validation](#3-content-and-validation)
4. [Channels and Notification Types](#4-channels-and-notification-types)
5. [The Audience](#5-the-audience)
6. [Lifecycle and Compare-and-Swap Transitions](#6-lifecycle-and-compare-and-swap-transitions)
7. [Fan-out: Two Job Types](#7-fan-out-two-job-types)
8. [Failure, Resume, Cancel and Delete](#8-failure-resume-cancel-and-delete)
9. [Test Send](#9-test-send)
10. [The Email Channel](#10-the-email-channel)
11. [API](#11-api)
12. [RBAC](#12-rbac)
13. [Admin UI](#13-admin-ui)
14. [Rejected Alternatives](#14-rejected-alternatives)
15. [Known Limitations](#15-known-limitations)

---

## 1. What It Is and Is Not

**Is.** A durable, resumable, cancellable one-to-all announcement. The row in `notification_broadcasts` is both the record and the fan-out's persisted state. Delivery reuses existing machinery: the inbox row is written by `NotificationsService.emit()` (so it gets the SSE stream and Web Push dispatch for free), email goes through `EmailService`, and the fan-out runs as ordinary `enrichment_jobs` (retries, visibility in `/admin/settings/jobs`).

**Is not.** Not a targeted send: there is no segment, role or circle filter, and no per-recipient parameter anywhere (the test send goes to the caller only). Not a template system: `body` is plain text. Not a delivery-statistics product (section 15).

## 2. The Model

Table `notification_broadcasts` (migration `20260815000000_add_notification_broadcasts`; enum `NotificationBroadcastStatus`):

| Column | Notes |
|---|---|
| `title` (<=120), `body` (<=2,000, plain text) | Composed content |
| `link`, `cta_label` | Optional root-relative in-app path and its button label |
| `critical` | Boolean; selects the notification type (section 4) |
| `channels` | `text[]`, a non-empty subset of `inbox`, `push`, `email` |
| `status` | `draft` (reserved, no route produces it), `scheduled`, `sending`, `sent`, `canceled`, `failed` |
| `scheduled_for` | Future time, or null for "send now" |
| `audience_cutoff` | Frozen when sending begins, written once by the claim |
| `recipient_count` | Audience size at the cutoff (a snapshot) |
| `cursor_user_id`, `processed_count` | Persisted fan-out progress (cumulative across resumes) |
| `started_at`, `finished_at`, `last_error` | Timing and the failure reason |
| `created_by_id`, `canceled_by_id`, `canceled_at` | Both user FKs are SetNull |

Indexes: `(status, scheduled_for)`, `(created_at DESC)`. Admin mutations write `audit_events` rows (target type `notification_broadcast`): `notification_broadcast.created`, `.canceled`, `.resumed`, `.deleted`, `.test_sent`. `meta` carries identifiers and shape only, never the composed title or body.

## 3. Content and Validation

`createBroadcastSchema` (Zod, `dto/create-broadcast.dto.ts`), used by both `POST /api/admin/broadcasts` and `POST /api/admin/broadcasts/test`:

- `title`, `body` trimmed and non-empty; `body` is **plain text**, never interpreted as HTML or markdown anywhere.
- `link` must be **root-relative**: starts with `/`, not `//`, not `/\`, no whitespace or control characters, at most 500 characters. A broadcast link reaches every user, so it must not be able to send them off-site.
- `ctaLabel` (<=40) requires `link`.
- `channels`: at least one, no duplicates.
- `scheduledFor`: ISO 8601 with offset, strictly in the future; omit to send now.
- `push` requires `inbox` ("a Web Push is dispatched from, and opens, the in-app notification").
- `critical` requires `inbox` ("the in-app notification is the durable record every recipient can go back and read").
- `critical` defaults to `false`.

The web composer (`BroadcastComposer.tsx`) mirrors every rule as a disabled control or inline error so the 400s are unreachable from the form; the Important switch forces Inbox on and locks it, and Push is disabled while Inbox is off.

## 4. Channels and Notification Types

The notification type is **derived from `critical`, never accepted from the client** (`broadcastNotificationType`):

| `critical` | Type | Channels declared (`notification-channels.ts`) | `mandatory` |
|---|---|---|---|
| false | `admin_broadcast` | inbox, push | no |
| true | `admin_broadcast_critical` | inbox, push | **yes** |

Both values were added to `NotificationType` in their own migration (`20260815010000_add_admin_broadcast_notification_types`, since `ALTER TYPE ... ADD VALUE` cannot share a transaction with statements referencing the value). Both are per-occurrence EVENT types written with `emit()`, so the review-queue partial unique index does not apply.

What `mandatory` buys (see [browser-notifications.md section 3](browser-notifications.md#3-the-channel-layer)):

- The **inbox row** of a critical broadcast survives the admin `notifications.disabledTypes` switch and the user's own per-type preference. `resolveNotificationPreferences` forces `types[admin_broadcast_critical]` true, so a settings save never dismisses its rows either.
- **Push is not exempt**: it still needs an active VAPID pair, a subscription, `notifications.pushEnabled`, and the user's push preferences. `pushEnabled: false` stops critical pushes too.
- The in-page toast is not exempt either.

An ordinary broadcast is subject to the user's preference and to `disabledTypes`. When the broadcast did not select `push`, delivery passes `skipPush: true`, which can only remove the push channel. An email-only broadcast writes no inbox row at all.

## 5. The Audience

One predicate defines it, `audienceWhere(cutoff)` in `broadcast-constants.ts`:

```ts
{ isActive: true, createdAt: { lte: cutoff } }
```

The composer's count (`GET /audience`, evaluated at "now"), the start handler's `recipientCount`, and every chunk's page use this same function so the three numbers cannot disagree. For a scheduled broadcast the composer number is an estimate: the real audience is **frozen when the start job claims the broadcast**, so users created after the cutoff never receive it, and a user deactivated mid-fan-out is skipped (so `processedCount` may finish below `recipientCount`).

## 6. Lifecycle and Compare-and-Swap Transitions

```
scheduled --(start job CAS)--> sending --(short page)--> sent
scheduled | sending | failed --(cancel)--> canceled
scheduled | sending --(a fan-out job fails permanently)--> failed --(resume)--> sending | scheduled
```

Every transition that can race another is a **conditional write** (`updateMany` with the expected status in the `WHERE`), so exactly one actor wins in the database:

| Transition | Writer | Condition |
|---|---|---|
| `scheduled` -> `sending` (stamps `started_at`, `audience_cutoff`) | `broadcast_start` | `status = 'scheduled'` |
| record `recipient_count` | `broadcast_start` | `status = 'sending'` |
| advance `cursor_user_id`, `processed_count` | `broadcast_chunk` | `status = 'sending'` **and** `cursor_user_id = <the cursor it started from>` |
| `sending` -> `sent` | `broadcast_chunk` (short page) | `status = 'sending'` |
| `scheduled|sending|failed` -> `canceled` | cancel route | status in that set |
| `scheduled|sending` -> `failed` | `BroadcastFailureListener` | status in that set |
| `failed` -> `sending` / `scheduled` | resume route | `status = 'failed'` |

A cancel can therefore never be overwritten by a late chunk, and a failure can never overwrite `canceled` or `sent`.

## 7. Fan-out: Two Job Types

Both are registered `EnrichmentHandler`s, **server-only by omission** (no `nodeResultSchema` / `persistNodeResult`: a node has no database access), which places them in the `ENRICHMENT_WORKER_MODE=system` claim set automatically. Neither is in the CLI's `NODE_JOB_TYPES`. The type strings `broadcast_start` and `broadcast_chunk` are **permanent** once rows exist (renaming orphans queued rows; for `broadcast_start` that is a scheduled announcement that silently never fires). Payload is `{ broadcastId }`; priority 10 (behind upload enrichment, ahead of backfills).

### 7.1 Enqueue: `skipDedup` and `scheduledFor`

Global jobs (`mediaItemId: null`) dedup on `(type, mediaItemId IS NULL)`, which would collapse every broadcast's start job into the first. So **every broadcast enqueue passes `skipDedup: true`**: the start job, every chunk (a chunk enqueues its successor while itself still `running`, so dedup would swallow it), and the resume path. The per-broadcast duplicate gate is the handler's compare-and-swap, not the queue.

**Scheduling is the queue's own `scheduled_for`.** `POST` enqueues the start job with `scheduledFor`; the claim query ignores it until due. It is durable across restarts and needs no second cron-based scheduler. `BroadcastsService` enqueues only **after** the row write commits, outside any `$transaction`, so a worker never claims a job whose row it cannot see.

### 7.2 `broadcast_start`

Sends nothing. It turns a `scheduled` broadcast into `sending` exactly once (the CAS above, writing `audience_cutoff` in the same statement, never again), counts the audience, records `recipient_count`, and enqueues the first `broadcast_chunk`. It is **idempotent past the claim**: if the process dies after the claim but before the first chunk is queued, the retry finds the broadcast `sending` with no cursor, no progress and no existing chunk job, and finishes the hand-off with the **stored** cutoff. A deleted broadcast, a non-`scheduled` broadcast, or a malformed payload is a logged no-op, not a failure.

### 7.3 `broadcast_chunk`

Pages up to `BROADCAST_CHUNK_SIZE` (200) users (`id > cursor_user_id`, ordered by id, `audienceWhere(cutoff)`), delivers with `BROADCAST_SEND_CONCURRENCY` (5) in flight, and every `BROADCAST_STATUS_RECHECK_INTERVAL` (25) recipients it (1) commits progress with the cursor CAS and (2) re-checks that the broadcast is still `sending`. A full page enqueues its successor chunk; a short page flips the broadcast to `sent`.

- **Cancel latency**: a cancel stops the fan-out within one 25-recipient group. What was already delivered stays delivered.
- **Crash bound**: progress is committed per group, so a retry after a crash re-sends at most one group (about 25 recipients), never the remaining audience.
- **Zombie safety**: if another execution already moved the cursor (a reaped-but-alive job beside its replacement, or an admin retry beside a resume), the CAS fails and that chain stops without queuing a successor.
- Delivery problems never throw (inbox and email are best-effort); only a database fault throws, which the queue retries, resuming from the last committed cursor.

### 7.4 Delete veto

Both handlers implement the optional `EnrichmentHandler.canDelete(job)`, consulted by `DELETE /api/admin/jobs/:id` for **pending** rows. A pending start or chunk job whose broadcast is still `scheduled` or `sending` is the only thing that will advance it; deleting it would strand the broadcast forever. The veto refuses with a 400 ("Cancel the broadcast instead of deleting its job"). Terminal and history rows are always deletable. (`canDelete` is a generic queue hook added for this feature.)

## 8. Failure, Resume, Cancel and Delete

**Failure.** `BroadcastFailureListener` subscribes (async, so it never delays the worker's next claim) to `ENRICHMENT_JOB_SETTLED_EVENT`, emitted only on a job's **terminal** failure. For `broadcast_start`/`broadcast_chunk` jobs it re-reads the job, and conditionally flips the broadcast `scheduled|sending` -> `failed`, recording `lastError` ("Start|Chunk job <id> failed permanently after N attempt(s): <cause, truncated to 500 chars>"). `scheduled` is included because a start job that failed before its claim leaves nothing to start the broadcast.

**Resume** (`POST /:id/resume`, 409 unless `failed`). If an audience cutoff exists the broadcast returns to `sending` and one chunk job is enqueued that continues from the persisted cursor (recipients already reached are not re-sent, beyond one in-flight group). If it failed before ever being claimed it returns to `scheduled` and the start job is re-queued. If the enqueue itself fails, the broadcast is compensated back to `failed` so a resume can never strand it with no job.

**Cancel** (`POST /:id/cancel`, 409 for `sent`/`canceled`). A conditional write on `scheduled|sending|failed`. Queued job rows are left alone: the handlers' status checks make them no-ops. The row is kept, with `canceled_at`/`canceled_by_id`.

**Delete** (`DELETE /:id`, 204). Refused with 409 while `sending`. Notifications already delivered are kept.

## 9. Test Send

`POST /api/admin/broadcasts/test` delivers the composition to the **calling admin only**, through the same `BroadcastDeliveryService` the fan-out uses, so a test exercises exactly what a real send will do. It writes no broadcast row and queues no job; **there is no recipient parameter by design** (that would be a spam relay). The response reports the derived `notificationType`, the channels, `sentToUserId`, and the email outcome (`null` when email was not selected). `scheduledFor` is ignored.

## 10. The Email Channel

`BroadcastDeliveryService` calls `EmailService.sendEmail(recipient.email, 'broadcast', data)`. The `broadcast` template (`broadcast.email.ts`) is a pure function of its input:

- The body is **HTML-escaped**, never interpreted; blank-line-separated blocks become paragraphs (single newlines inside a block are joined with a space).
- A critical broadcast appends the notice that it "was marked important by an administrator and is sent to everyone, regardless of notification preferences".
- The CTA needs an **absolute** URL because a mail client cannot resolve `/path`: the caller builds it from the `appUrl` configuration (`APP_URL`) plus the root-relative `link` (`absoluteLink`). Without `link` (or `APP_URL`) there is no button; the default label is "Open MemoriaHub".

When email is not enabled deployment-wide, `sendEmail` returns `{ success: false, error: 'email_disabled' }`, which the chunk handler does not count as a failure. Email failures never fail the job; they are counted and logged per chunk. Email is an admin-selected channel: the code applies neither the inbox preferences nor `disabledTypes` to it.

## 11. API

All routes are under `/api/admin/broadcasts`, Admin role plus the permission shown. The literal routes `audience` and `test` are declared before `:id`. Responses use the standard `{ data, meta }` envelope; list is `{ items, meta: { page, pageSize, totalItems, totalPages } }`, newest first, `pageSize` max 100.

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/audience` | `broadcasts:read` | `{ activeUsers }`, counted with the fan-out's own predicate |
| `POST` | `/test` | `broadcasts:write` | Send the composition to yourself |
| `GET` | `/?page=&pageSize=&status=` | `broadcasts:read` | Paginated list, optional status filter |
| `POST` | `/` | `broadcasts:write` | Create and queue; `201` |
| `GET` | `/:id` | `broadcasts:read` | One broadcast with progress (`recipientCount` / `processedCount`) |
| `POST` | `/:id/cancel` | `broadcasts:write` | Cancel scheduled, sending or failed; `409` otherwise |
| `POST` | `/:id/resume` | `broadcasts:write` | Resume a failed broadcast; `409` unless `failed` |
| `DELETE` | `/:id` | `broadcasts:write` | Delete; `204`; `409` while sending |

The broadcast object exposes `id, title, body, link, ctaLabel, critical, channels, status, scheduledFor, audienceCutoff, recipientCount, processedCount, startedAt, finishedAt, lastError, canceledAt, createdAt, updatedAt, createdBy, canceledBy` (the last two as `{ id, email, displayName }` or null).

## 12. RBAC

`broadcasts:read` and `broadcasts:write`, seeded in `prisma/seed.ts` and granted to the `admin` role only. `read` = view broadcasts and audience size; `write` = compose, test-send, schedule, cancel, resume, delete. There is no environment variable and no feature flag: the feature is inert until an administrator sends something.

## 13. Admin UI

`/admin/settings/broadcasts`, a card in the Operations group of `ADMIN_SECTIONS` gated on `broadcasts:read`. Writes need `broadcasts:write` and are **disabled with a reason, never absent**. Row actions are disabled by status, mirroring the API's 409s (a `sent` broadcast cannot be cancelled, a `sending` one cannot be deleted, only a `failed` one resumes). The composer shows a live preview, the audience count, a confirmation before sending, and disables Push when the deployment has push off (`config?.pushEnabled === false`). The list polls every 10 s **only while something is `scheduled` or `sending`** (`useBroadcasts`, visibility-aware); the open detail dialog follows the polled list so an operator watching a send sees progress move. There is no bulk selection because no endpoint takes a set of ids.

## 14. Rejected Alternatives

| Alternative | Why not |
|---|---|
| A cron-based scheduler for scheduled broadcasts | The queue's `scheduled_for` already gives durable, restart-safe scheduling |
| One giant job for the whole audience | Would outlive the lease/timeout budget and lose all progress on a crash; a cursor plus chunk chain bounds both |
| Trusting a client-supplied notification type | The type is derived from `critical`; accepting it would let a caller mint a mandatory type without the guarantees |
| Queue-level dedup for the chain | It would collapse other broadcasts' jobs (and a chunk's own successor); the CAS is the real gate |
| Counter-equality to detect completion | The audience is a snapshot and users deactivate mid-send; a short page is the completion signal |
| A recipient parameter on the test send | A spam relay |
| Interpreting body as HTML/markdown | Plain text only; the email template escapes it |

## 15. Known Limitations

- **No email rate-limit deferral.** The email channel has no per-provider throttle: a chunk sends to its group with concurrency 5 and only counts failures. A provider that rate-limits mid-fan-out produces failed emails that are logged, not retried or deferred (the job still succeeds), and there is no resend. (A failed inbox/push delivery is separate: those never fail the job either.)
- **No per-channel delivery breakdown.** `processedCount` counts recipients walked, not messages delivered per channel. The broadcast row does not record how many inbox rows were written (a user's preference can suppress an ordinary broadcast's row), how many pushes were accepted, or how many emails succeeded. Push attempts are auditable in `notification_deliveries` per notification, not per broadcast.
- **The user preferences page has no switch for the broadcast types**, so an ordinary broadcast can be muted only through the API today; a critical one cannot be muted at all (by design).
- **The audience is every active user**: no segmentation, no per-circle targeting.
- **Per-process SSE and push throttle** apply to the inbox/push legs exactly as in [browser-notifications.md](browser-notifications.md#19-known-limitations).
- **A cancel does not recall** anything already delivered.

---

## Document History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | August 2026 | AI Assistant | Initial specification for issue #488: the model, validation, derived notification types and the mandatory critical type, the frozen audience, the CAS-guarded lifecycle, the `broadcast_start`/`broadcast_chunk` job pair (server-only, `skipDedup`, `scheduledFor`), failure/resume/cancel/delete semantics and the `canDelete` veto, the test send, the email template, API, RBAC, admin UI, and known limitations |
