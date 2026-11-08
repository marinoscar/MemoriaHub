# Notifications cutover to the platform slice (RETRO-D3, #576)

MemoriaHub's notification center (the bell, the inbox, Web Push, the live stream, broadcasts, the policy and per-user preferences) runs on `@marinoscar/platform-api/notifications` and `@marinoscar/platform-web/notifications`. The move had two phases.

| Phase | Shipped | State after deploy |
|---|---|---|
| 1 | The nine event keys and their renderers (`apps/api/src/notifications-registry/memoriahub.notifications.ts`), the manifest, the `notifications` conformance suite, and the carry-over (`npm run notifications:migrate-legacy`) | No behaviour change: the app's own slice still served everything from the `mh_legacy_*` tables. |
| 2 (platform 0.1.0-next.27, migrations `0041`/`0042` installed) | `NotificationsModule.forRoot` + `BroadcastsModule` mounted with the manifest; producers on `notifyState` / `notifyCounted` / `notify`; email sends on `notifyAddress` / `notifyNow` (`AppEmailSender` deleted); `DB_BACKUP_NOTIFIER` and `IDENTITY_NOTIFIER` on `NotificationsService`; the platform settings namespaces with their `onWrite` dismiss hooks; the packaged bell, inbox store, stream, push sync, service-worker handlers and admin pages; `apps/api/src/notifications/` deleted; RETRO-C8's `retention.appNotifications` policy removed; `notification_purge`, `broadcast_start` and `broadcast_chunk` retired as no-op job types | **The platform serves everything from its own (empty) tables.** Until the carry-over below runs, users see an empty bell and inbox, existing browsers are not subscribed, the admin policy and per-user preferences read as defaults (a user's legacy preferences are read-repaired in memory), and broadcast history is not listed. Run the carry-over in the deploy window. |

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

## The carry-over (operator action, right after the phase-2 deploy)

```bash
npm run notifications:migrate-legacy --workspace=api                 # dry run: counts per table and per type, the settings plan
npm run credentials:migrate-legacy --workspace=api -- --purpose push_vapid            # dry run of the VAPID key move
# after the phase-2 release is deployed (maintenance window recommended):
npm run credentials:migrate-legacy --workspace=api -- --purpose push_vapid --apply
npm run notifications:migrate-legacy --workspace=api -- --apply
```

What `--apply` does, in one transaction, idempotent (keyed on the legacy row id), never modifying a `mh_legacy_*` table:

1. **Push subscriptions** are copied with the same endpoint, keys and failure count (`platform = 'browser'`). With the same VAPID key pair (moved into the credential store by the credentials command; the `webPush` row's `enabled`, `publicKey` and `subject` are read by the platform as they are), no browser re-subscribes.
2. **Broadcasts** are copied (`critical` -> `admin.broadcast_critical`, channel `inbox` -> `browser`, audience = everyone). It refuses while a legacy broadcast is `scheduled` or `sending`. Phase 2 retired the legacy `broadcast_start` / `broadcast_chunk` handlers, so such a broadcast no longer progresses: cancel it in SQL (`UPDATE mh_legacy_notification_broadcasts SET status = 'canceled', canceled_at = now() WHERE status IN ('scheduled','sending')`) and re-create it on `/admin/settings/broadcasts`. Drain or cancel scheduled broadcasts before deploying to avoid this.
3. **Inbox** rows keep their title, link, read and dismissed state, `data` (with `count` and `countAtRead`) and timestamps. Each live review-queue or counted row gets the key the platform writer folds into, so after the cutover a circle with 929 pending duplicate groups is still one row and the next upload grows the same counted row. Of several live upload windows for one circle, only the newest keeps the key; the others are retired exactly as the platform retires a closed window.
4. **Deliveries** are copied with their event key (recipient label `carried over (pre-platform)`).
5. **Policy**: `pushEnabled` -> `channels.push.enabled`, `disabledTypes` -> `disabledEvents` plus `jobs.job_failed` (MemoriaHub's own `media.enrichment_failed` roll-up stays the one bell per failure), RETRO-C8's `retention.appNotifications` when stored, else `retentionDays` / `purgeEnabled`, -> `retention.notifications` and `retention.notificationDeliveries` (only while absent; without either the platform defaults apply: 180 and 90 days). The original stays under `mhLegacyNotifications` in the `global` row.
6. **Preferences**: a muted type (or "all off") mutes `browser` and `push` for its event; a push-only mute mutes `push`. `workflowMicroRuns: true` moves to `memoriahubNotifications.workflowMicroRuns`. The originals are kept, per user, in the `system_settings` row `mh_legacy_notification_preferences`.

## Verify

- The dry run, run again, reports `0 to copy` for every table and `already in the platform shape`.
- Per user, the live unread count matches: `SELECT user_id, count(*) FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL GROUP BY 1` equals the same query on `mh_legacy_notifications` (sample 20 users).
- `/admin/settings/push` -> Test: an existing subscription receives the push without re-subscribing. Doctor `push.vapid` passes.

## Behaviour changes to expect

- **Retention.** The platform inbox purge (`notifications.inbox.purge`, `retention.notifications`) deletes a plain event row (workflow run finished, share expiring, broadcast) by age whether read or not; a STATE or COUNTED row (review queues, uploads, enrichment failures, memories) only once read or dismissed, never while unread, as before. MemoriaHub never aged out any unread row. The default window is 180 days (MemoriaHub's was 30 after resolution); the carry-over keeps the stored window. RETRO-C8's `retention.appNotifications` is no longer read.
- **Inbox page.** `/notifications` has no circle filter and its "Mark all as read" / "Dismiss all" act on every circle (the platform list has no scope filter). `DELETE /api/notifications/:id` is gone (dismiss instead). A circle's notification opens with `?c=<circleId>`, which switches circle on arrival, from the bell, the inbox page or a push.
- **Preferences.** Per event and per channel (in-app, push) on `/settings/notifications`; the workflow micro-run opt-in is a separate card (`memoriahubNotifications.workflowMicroRuns`, off by default).
- **Email.** Circle invitation, membership confirmation and the memory digest are notification events (`circles.invitation`, `circles.membership_confirmed`, `memories.digest`), on by default; a user who turns one off in their preferences stops receiving it.
- **New notifications.** Database backup failures and completed restores now notify `db_backup:read` holders (`db_backup.restore_completed` is mandatory). The identity events (`user.welcome`, `allowlist.invitation`, `security.role_changed`) are declared but default off.
- **Review-queue reconcile** also drains the row of a member demoted to viewer or removed from the circle.
- **Broadcast jobs** are the platform's `admin.broadcast.start` / `admin.broadcast.chunk`; the legacy `broadcast_start`, `broadcast_chunk` and `notification_purge` job types are retired no-ops (a queued row succeeds without doing anything).

## Rollback

Revert the release. The legacy tables were only read, the original policy is in `global.mhLegacyNotifications` (copy it back to `notifications`), the original preferences are in the `mh_legacy_notification_preferences` row (copy each user's value back to `user_settings.value.notifications`), and the legacy VAPID ciphertext is still in the `webPush` row. Rows written to the platform tables after the cutover are not copied back.
