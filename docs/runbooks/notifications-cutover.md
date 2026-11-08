# Notifications cutover to the platform slice (RETRO-D3, #576)

MemoriaHub's notification center (the bell, the inbox, Web Push, the live stream, broadcasts, the policy and per-user preferences) moves onto `@marinoscar/platform-api/notifications`. The move has two phases because the pinned platform version cannot hold MemoriaHub's inbox yet.

| Phase | Ships | State after deploy |
|---|---|---|
| 1 (this change) | The nine event keys and their renderers (`apps/api/src/notifications-registry/memoriahub.notifications.ts`), the manifest (`apps/api/src/platform/notifications/notification.manifest.ts`, not imported at runtime), the `notifications` conformance suite, and the carry-over (`npm run notifications:migrate-legacy`) | **No behaviour change.** The app's own slice still serves `/api/notifications`, push, the stream and broadcasts from the `mh_legacy_*` tables. Nothing to do after deploy. |
| 2 (after the 0.1.0-next.27 bump, PR #653) | `NotificationsModule.forRoot` + `BroadcastsModule` mounted, producers on `notifyState` / `notifyCounted` / `notify`, the app slice deleted, the platform web components | The platform serves everything; the carry-over below runs in the cutover window. |

Why phase 2 needs the bump: platform 0.1.0-next.22's inbox has no `data`, `dismissed_at`, `updated_at`, scope or dedup columns, no STATE or COUNTED writes, no dismiss routes and no settings `onWrite` hook. Those arrive in 0.1.0-next.26/27 (platform migration `0041_notifications_state_counted`). See [local exceptions](../platform-adoption/local-exceptions.md) for the shim each one removes.

## The event keys (permanent)

| Legacy `NotificationType` | Platform event key | Fold |
|---|---|---|
| `review_queue_bursts` | `review.bursts` | STATE, per circle |
| `review_queue_duplicates` | `review.duplicates` | STATE, per circle |
| `review_queue_location_suggestions` | `review.location_suggestions` | STATE, per circle |
| `review_queue_enhancements` | `review.enhancements` | STATE, per circle |
| `upload_completed` | `media.upload_completed` | COUNTED, per circle, 15-minute window |
| `enrichment_failed` | `media.enrichment_failed` | COUNTED, deployment-wide, per `jobType`, no window |
| `workflow_run_completed` | `workflows.run_completed` | one row per run |
| `share_expiring` | `shares.expiring` | one row per expiry (`data.notifiedFor`) |
| `memories_ready` | `memories.ready` | COUNTED, per circle, 24-hour window |
| `admin_broadcast` | `admin.broadcast` (platform) | one row per broadcast |
| `admin_broadcast_critical` | `admin.broadcast_critical` (platform, mandatory) | one row per broadcast |

A key is never renamed: a user who muted the old key would silently start receiving the new one, and their history would be orphaned.

## The carry-over (phase 2 cutover window)

```bash
npm run notifications:migrate-legacy --workspace=api                 # dry run: counts per table and per type, the settings plan
npm run credentials:migrate-legacy --workspace=api -- --purpose push_vapid            # dry run of the VAPID key move
# after the phase-2 release is deployed and no legacy broadcast is scheduled or sending:
npm run credentials:migrate-legacy --workspace=api -- --purpose push_vapid --apply    # phase 2 enables push_vapid there
npm run notifications:migrate-legacy --workspace=api -- --apply
```

What `--apply` does, in one transaction, idempotent (keyed on the legacy row id), never modifying a `mh_legacy_*` table:

1. **Push subscriptions** are copied with the same endpoint, keys and failure count (`platform = 'browser'`). With the same VAPID key pair (moved into the credential store by the credentials command; the `webPush` row's `enabled`, `publicKey` and `subject` are read by the platform as they are), no browser re-subscribes.
2. **Broadcasts** are copied (`critical` -> `admin.broadcast_critical`, channel `inbox` -> `browser`, audience = everyone). It refuses while a legacy broadcast is `scheduled` or `sending`: cancel it or let it finish first.
3. **Inbox** rows keep their title, link, read and dismissed state, `data` (with `count` and `countAtRead`) and timestamps. Each live review-queue or counted row gets the key the platform writer folds into, so after the cutover a circle with 929 pending duplicate groups is still one row and the next upload grows the same counted row. Of several live upload windows for one circle, only the newest keeps the key; the others are retired exactly as the platform retires a closed window.
4. **Deliveries** are copied with their event key (recipient label `carried over (pre-platform)`).
5. **Policy**: `pushEnabled` -> `channels.push.enabled`, `disabledTypes` -> `disabledEvents` plus `jobs.job_failed` (MemoriaHub's own `media.enrichment_failed` roll-up stays the one bell per failure), `retentionDays` / `purgeEnabled` -> `retention.notifications` and `retention.notificationDeliveries` (only while absent). The original stays under `mhLegacyNotifications` in the `global` row.
6. **Preferences**: a muted type (or "all off") mutes `browser` and `push` for its event; a push-only mute mutes `push`. `workflowMicroRuns: true` moves to `memoriahubNotifications.workflowMicroRuns`. The originals are kept, per user, in the `system_settings` row `mh_legacy_notification_preferences`.

## Verify

- The dry run, run again, reports `0 to copy` for every table and `already in the platform shape`.
- Per user, the live unread count matches: `SELECT user_id, count(*) FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL GROUP BY 1` equals the same query on `mh_legacy_notifications` (sample 20 users).
- `/admin/settings/push` -> Test: an existing subscription receives the push without re-subscribing. Doctor `push.vapid` passes.

## Behaviour changes to expect

- The platform inbox purge (`notifications.inbox.purge`) deletes rows by age whether read or not; MemoriaHub never aged out an unread row.
- Broadcast jobs are the platform's `admin.broadcast.start` / `admin.broadcast.chunk`; legacy `broadcast_start` / `broadcast_chunk` rows must be drained before the window.

## Rollback

Revert the release. The legacy tables were only read, the original policy is in `global.mhLegacyNotifications` (copy it back to `notifications`), the original preferences are in the `mh_legacy_notification_preferences` row (copy each user's value back to `user_settings.value.notifications`), and the legacy VAPID ciphertext is still in the `webPush` row. Rows written to the platform tables after the cutover are not copied back.
