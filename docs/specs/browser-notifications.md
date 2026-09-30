# Browser Notifications, Web Push and the Live Stream

| Field | Value |
|-------|-------|
| **Epic** | #481 |
| **Children** | #482 (PWA shell + service worker) · #483 (VAPID config + subscriptions) · #484 (channel layer, dispatch, policy, delivery audit) · #485 (SSE stream + in-page toast) · #486 (client capability model + subscription sync) · #487 (admin policy page + push test/diagnostics) · #488 ([admin broadcasts](notification-broadcasts.md)) · #489 (this documentation) |
| **Version** | 1.0 |
| **Last Updated** | August 2026 |
| **Status** | Implemented |
| **Code** | `apps/api/src/notifications/` (`notification-channels.ts`, `notification-dispatch.service.ts`, `notification-policy.service.ts`, `notification-stream.service.ts`, `push/`), `apps/web/src/sw.ts`, `apps/web/pwa/`, `apps/web/src/services/{sse,notificationStream,pushSubscription,browserNotifications,pushConfig,pushDiagnostics}.ts`, `apps/web/src/hooks/{useNotifications,useNotificationCapability,usePushSubscriptionSync,useNotificationClickHandling}.ts` |
| **Builds on** | [Notification Center](notifications.md) (the inbox model, the three write primitives, per-type preferences) |
| **Runbook** | [VAPID keys](../runbooks/vapid-keys.md) |

This spec documents what the code in this repository does. The feature was ported from EnterpriseAppBase (EAB) onto MemoriaHub's existing Notification Center; where the two differ (there is no notification registry, no email channel per type, and no environment-variable VAPID fallback here) the difference is called out.

---

## Table of Contents

1. [Overview and Platform Facts](#1-overview-and-platform-facts)
2. [The PWA Shell and Service Worker](#2-the-pwa-shell-and-service-worker)
3. [The Channel Layer](#3-the-channel-layer)
4. [Dispatch](#4-dispatch)
5. [The Push Channel](#5-the-push-channel)
6. [Delivery Audit and Purge](#6-delivery-audit-and-purge)
7. [Admin Policy](#7-admin-policy)
8. [Per-User Push Preferences](#8-per-user-push-preferences)
9. [VAPID Configuration Storage](#9-vapid-configuration-storage)
10. [The Client Config Endpoint](#10-the-client-config-endpoint)
11. [The Live Stream (SSE)](#11-the-live-stream-sse)
12. [Client Capability Model](#12-client-capability-model)
13. [Subscription Sync, Rotation and Logout](#13-subscription-sync-rotation-and-logout)
14. [Toasts: Suppression and Dedup](#14-toasts-suppression-and-dedup)
15. [Click Handling](#15-click-handling)
16. [Test Push and Diagnostics](#16-test-push-and-diagnostics)
17. [RBAC and API Surface](#17-rbac-and-api-surface)
18. [Rejected Alternatives](#18-rejected-alternatives)
19. [Known Limitations](#19-known-limitations)

---

## 1. Overview and Platform Facts

The Notification Center ([notifications.md](notifications.md)) writes one `notifications` row per fact. Epic #481 adds a **channel layer** on top of it without changing that model:

| Channel | What it is | Written by |
|---|---|---|
| `inbox` | The `notifications` row itself: the bell and `/notifications`. | The existing `NotificationsService` primitives, unchanged. |
| `push` | A Web Push to the user's registered browsers, so the alert arrives while the app is closed. | `NotificationDispatchService` **after** the inbox row has committed. |

Two further surfaces ride on the same committed row: a live SSE stream that updates the bell without waiting for a poll (section 11), and an in-page OS toast (section 14).

Platform facts that shape the design:

- **Android Chrome's Notifications API is service-worker-only.** `new Notification()` throws there; `registration.showNotification()` is the only path. The service worker is therefore load-bearing, not a nicety.
- **iOS/iPadOS 16.4+ grants notifications and Push only to an installed web app** (Add to Home Screen). In a Safari tab `window.Notification` is undefined even though `serviceWorker` exists. The manifest's `display: 'standalone'` is what makes the app installable.
- **Web Push requires HTTPS** (a secure context). Over plain HTTP the APIs cannot exist.
- **A service worker cannot authenticate.** The access token is memory-only in the page and the HttpOnly refresh cookie rotates on every use; a worker that refreshed on its own would burn the one-shot refresh token behind the page's back.

The notification row is always the durable surface. Push, the stream and toasts are decoration: each degrades silently and none can fail the action that produced the notification.

## 2. The PWA Shell and Service Worker

Files: `apps/web/pwa/manifest.ts`, `apps/web/pwa/service-worker.ts`, `apps/web/src/sw.ts`, `apps/web/nginx.conf`, `apps/web/src/components/pwa/{UpdatePrompt,InstallPrompt}.tsx`.

### 2.1 Build: `injectManifest`, not `generateSW`

`buildServiceWorkerOptions()` (`pwa/service-worker.ts`) configures `vite-plugin-pwa` with `strategies: 'injectManifest'`, `srcDir: 'src'`, `filename: 'sw.ts'`. `generateSW` writes the whole worker from config and leaves nowhere to put the `push`, `notificationclick` and `pushsubscriptionchange` handlers. `injectManifest` keeps one reviewable hand-written worker and only substitutes the precache list in. `VitePWA` also emits `manifest.webmanifest` from `buildManifest()`, replacing the old `public/site.webmanifest`.

- `registerType: 'prompt'`: a new worker installs and **waits**. Auto-activation would reload the page under a user mid-session, discarding unsaved edits, and the loaded page would request chunk filenames the new revision has rotated away. `UpdatePrompt.tsx` shows a Snackbar and posts `{ type: 'SKIP_WAITING' }`, which `sw.ts` answers with `skipWaiting()`. There is deliberately no top-level `skipWaiting()`.
- `injectRegister: null`: the React tree owns registration (`useRegisterSW` in `UpdatePrompt`, mounted in `App.tsx` outside `<Routes>`). With `'auto'` the plugin would also inject a second registration script.
- `devOptions.enabled: true`, `type: 'module'`, `navigateFallback: 'index.html'`: the worker is exercised against `npm run dev`.

### 2.2 Manifest

`buildManifest()` produces `id: '/'`, `start_url: '/'`, `scope: '/'`, `display: 'standalone'`, `orientation: 'any'`, a `theme_color`/`background_color` pair, and icons under `public/icons/` (`icon-192`, `icon-512`, two maskable sizes, and a white-silhouette `badge-72.png` with `purpose: 'monochrome'`, which Android draws in the status bar using only its alpha channel). `MANIFEST_APP_NAME` and `THEME_COLOR` are restated in `pwa/manifest.ts` rather than imported from `src/` because `tsconfig.node.json` is a composite project a `src/` file cannot join; `src/__tests__/pwa/manifest.test.ts` asserts they equal `APP_NAME` and the light palette's `primary.main`, and that every icon path exists on disk.

### 2.3 Nothing under `/api` is ever cached

Cache Storage is origin-scoped, survives logout and is not partitioned per account, so a cached authenticated response would be readable by the next person to sign in on a shared device. Three independent guards hold this:

1. `globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}']` matches only `dist/`, which is built entirely from `apps/web` (the API is a separate service nginx mounts at `/api`). Never add `json` or anything API-shaped.
2. There is **no runtime caching strategy** in `sw.ts`.
3. The SPA navigation fallback (`NavigationRoute` bound to the precached `/index.html`) carries `denylist: [/^\/api\//]`. That keeps the worker out of the API URL space, so `/api/docs` (Scalar), the public-share byte proxy and the long-lived notification stream are never swapped for the SPA shell or pinned to the worker. Do not narrow it to individual paths.

`service-worker.test.ts` greps `sw.ts` for `fetch(` and `'/api/` to enforce that the worker never calls the API.

### 2.4 nginx

- `apps/web/nginx.conf` sets `Cache-Control: no-cache` on exact-match locations for `/sw.js`, `/registerSW.js` and `/manifest.webmanifest` (an exact `=` location beats the regex block that would otherwise serve `sw.js` as `immutable` for a year). The browser re-fetches the worker script to discover updates, so an immutable `sw.js` is a deploy users may never receive. Everything the worker precaches is content-hashed (`assets/*-<hash>.js`) and stays immutable.
- The manifest is served with `default_type application/manifest+json` inside an empty `types {}` block: stock `mime.types` has no `.webmanifest` entry and the outer proxy sends `X-Content-Type-Options: nosniff`.
- The outer proxies (`infra/nginx/nginx.conf`, `nginx.prod.conf`) send **no Content-Security-Policy**. If one is ever added it must allow `worker-src 'self'` (or a `script-src 'self'` to fall back to) and `manifest-src 'self'`, or `/sw.js` silently fails to register and Web Push never works.

### 2.5 Install prompt

`InstallPrompt.tsx` covers only browsers that fire `beforeinstallprompt` (Chrome, Edge). It is hidden when the app already runs standalone and remembers a dismissal in `localStorage` (`pwa_install_dismissed`, every access wrapped in try/catch). iOS Safari fires no such event and exposes no install API, so iOS is handled by the capability model's walkthrough (section 12), not here.

## 3. The Channel Layer

`notification-channels.ts` declares, for every `NotificationType`, which channels it may travel over. It is an exhaustive `Record<NotificationType, NotificationChannelDescriptor>`, so adding an enum value is a compile error until someone decides its channels.

```ts
interface NotificationChannelDescriptor {
  readonly channels: readonly ('inbox' | 'push')[]; // inbox first
  readonly mandatory: boolean;
}
```

Every type is `{ channels: ['inbox', 'push'], mandatory: false }` except **`admin_broadcast_critical`**, which is `mandatory: true` (see [notification-broadcasts.md](notification-broadcasts.md)). The helpers are `channelDescriptor`, `supportsChannel`, `isMandatoryType` and `pushCapableTypes()`.

**`mandatory` exempts the type's INBOX row** from both the admin `disabledTypes` switch and the user's own per-type preference, because the row is the guarantee the user is told. It never exempts push (which still needs an active VAPID pair, a subscription and the push preferences) and never exempts the in-page toast.

## 4. Dispatch

`NotificationsService` writes the inbox row exactly as before. After the write has **committed**, it hands the row to `NotificationDispatchService.dispatch(row, reason, options)`.

### 4.1 Hook points

| Write path | Dispatched? | `reason` |
|---|---|---|
| `emit()` | yes, always (skipPush honoured) | `created` |
| `upsertState()` creating a new live row | yes | `created` |
| `upsertState()` refreshing an existing live row in place | **no** (it would push the same queue every hour) | n/a |
| A read STATE row re-marked unread because its count grew (`markStatesUnreadByIds`) | yes | `reunread` |
| `upsertCountedEvent()` creating a row | yes | `created` |
| `upsertCountedEvent()` incrementing a row **and** the caller opted into re-unread | yes | `incremented` |

Every dispatch happens after the producer's write and any `$transaction` around it, never inside one.

### 4.2 Contract: post-commit, fire-and-forget, never throws

`dispatch()` returns `void` synchronously; its background promise carries a terminal `.catch()` and never rejects. A push provider being down cannot fail, slow or roll back the action that produced the notification. In-flight dispatches are tracked in a `Set` and drained (bounded at 5 s) in `onModuleDestroy`, so a deploy does not cut a half-written delivery row.

`NotificationDispatchOptions.skipPush` can only **remove** a channel, never add one past policy or preferences. Admin broadcasts use it when the push channel was not selected.

### 4.3 Gate order (cheapest first)

1. **Admin policy**: `isPushAllowed(type, policy)`: the type supports push, `pushEnabled` is on, and the type is not in `disabledTypes`.
2. **User push preference**: `NotificationPreferencesService.isPushEnabled(userId, type)` (section 8).
3. **Throttle**: at most one push per notification **id** per `PUSH_THROTTLE_MS` (5 minutes), held in an in-process `Map` (bounded at 10,000 entries with expiry sweep, then a wholesale clear). A counted row incremented 4,000 times by an import therefore produces a handful of pushes, not 4,000. The slot is claimed **synchronously before any `await`**, so a burst of concurrent increments of one row cannot all pass the check before the first stamps it. If nothing is then sent (no active VAPID, or the user has no subscription) the slot is released so a push becomes possible the moment the user subscribes.
4. **VAPID active and at least one subscription** for the user.
5. **Send**, recording a `notification_deliveries` row (`queued`, then `sent` or `failed`).

After the decision, dispatch emits an in-process event `notification.dispatched` (`NotificationDispatchedEvent`: `userId`, the row as `NotificationItemDto`, `reason`, `pushed`, `toast`) that the stream service publishes to the user's open tabs (section 11). `toast` is `isToastAllowed(type, policy)`; `pushed` is true only when at least one endpoint accepted the push.

### 4.4 Inbox gate

The inbox gate every write path applies is `isInboxDeliverable`: `NotificationPolicyService.isInboxAllowed(type)` (mandatory types exempt) **and** the user's per-type preference (`NotificationPreferencesService.isEnabled`, which also exempts mandatory types). A suppressed type writes no row, so there is nothing to dispatch.

## 5. The Push Channel

`PushNotificationChannel.deliver(row, vapid?)` sends an encrypted payload for an **already-written** `notifications` row to every push subscription its owner has. Unlike EAB's channel it writes no notification row of its own: one logical notification is one row, and the push payload references its id.

### 5.1 Payload

Built by `buildPushPayload` and sent as JSON:

| Field | Value |
|---|---|
| `id` | the `notifications` row id |
| `title` | truncated to 200 characters |
| `body` | truncated to 1,000 characters (empty string when null) |
| `link` | `sanitizePushLink(row.link)`: root-relative only; anything else (absolute URL, `//host`, `/\host`, control characters, relative path, empty) falls back to `/notifications` |
| `tag` | the notification id, so a browser replaces rather than stacks a re-pushed counted row |
| `type`, `circleId` | so the page can label and switch circle |
| `icon`, `badge` | `/icons/icon-192.png`, `/icons/badge-72.png` |

`PUSH_TTL_SECONDS` is 24 hours; each send has a 10 s timeout. VAPID details are passed **per call** (`options.vapidDetails`), never through the global `webpush.setVapidDetails`, which would race a concurrent key rotation.

### 5.2 Endpoint pruning rules

Every subscription is attempted in parallel (`Promise.allSettled`); one dead endpoint never stops the others.

| Outcome | Bookkeeping |
|---|---|
| Accepted | `failureCount = 0`, `lastSuccessAt = now` |
| HTTP 404 or 410 | the endpoint is gone for good: **row deleted immediately** |
| Anything else (401/403/429/5xx/timeout/DNS) | `failureCount++`; row **deleted at `MAX_PUSH_FAILURE_COUNT` (5)** |

This tolerates a push service's bad minute while ensuring a dead endpoint (including every subscription orphaned by a key rotation that never re-subscribes) cannot accumulate forever. The result is `success` when at least one endpoint accepted; `error` is a counts-only summary that never contains a body, a key or an endpoint. `deliver()` never throws.

### 5.3 Subscription service

`PushSubscriptionService` is the user-facing half of `push_subscriptions`:

- `subscribe()` upserts **by endpoint** (unique on its own). Re-subscribing an endpoint under a different signed-in user **moves the row** to that user, so a shared machine stops receiving the previous owner's pushes. `failureCount` resets to 0 on update. **409** when no VAPID pair is active. `userAgent` is stored truncated to 512 characters. The DTO requires an `https://` endpoint and non-empty `p256dh`/`auth`.
- `unsubscribe(userId, endpoint)` is one ownership-scoped `deleteMany`. A missing endpoint and someone else's endpoint are indistinguishable (**404**).

## 6. Delivery Audit and Purge

`notification_deliveries` is an audit/diagnostic record, not a queue: one row per (notification, non-inbox channel) attempt, today only `channel = 'push'`. It answers "why did this user never get pushed?".

| Column | Notes |
|---|---|
| `notification_id`, `user_id` | Both FKs are **SetNull**: the audit outlives an inbox row purge and a user deletion |
| `type` | `NotificationType` |
| `channel` | text, `'push'` |
| `status` | `NotificationDeliveryStatus`: `queued` \| `sent` \| `failed` |
| `provider_message_id` | on success holds the counts summary (`"2/3 sent, 1 failed, 0 pruned"`), not a provider id |
| `error` | truncated to 1,000 characters; counts-only |

Indexes: `(user_id, type)`, `(status, created_at)`, `(created_at)`. Migration `20260814010000_add_notification_deliveries`.

**Purge.** `NotificationPurgeHandler` (the nightly `notification_purge` job) gained a third pass: it deletes `notification_deliveries` older than `notifications.retentionDays` **by `created_at` alone**, in 5,000-row batches. Unlike notifications, deliveries are machine records with no read state, so age decides. The FK is SetNull, so pass order does not matter. The same `notifications.purgeEnabled` switch governs it.

## 7. Admin Policy

`NotificationPolicyService` reads three keys of the `notifications` namespace of the `global` `system_settings` row, **through `PrismaService` directly** (not `SystemSettingsService`: `NotificationsModule` imports nothing and `SettingsModule` already imports it):

| Setting | Default | Effect |
|---|---|---|
| `notifications.browserEnabled` | `true` | `false` withholds the in-page browser toast (the stream's `toast` flag). Inbox rows are unaffected. |
| `notifications.pushEnabled` | `true` | `false` stops every Web Push, **mandatory types included**. |
| `notifications.disabledTypes` | `[]` | Suppresses the push channel for a listed type, and its **inbox row too unless the type is mandatory**. Array replaced wholesale on write. Max 50 entries. |

Pure predicates (`isInboxAllowed`, `isPushAllowed`, `isToastAllowed`, `policyChannels`) are exported alongside the service. `readNotificationPolicy` normalizes a stored blob and never throws (`!== false` for the booleans; unknown type names are filtered out).

- **Cached 5 s** (`NOTIFICATION_POLICY_CACHE_TTL_MS`), because the gate runs per recipient in hot producer loops. `SystemSettingsService.invalidateSettingsCache()` also invalidates this cache, so an admin policy change applies immediately on the writing process (other API processes still wait out the TTL).
- **Fails open**: an unreadable policy resolves to "everything on". A transient database fault must never silently mute notifications.
- `disabledTypes` gates **new** writes, and adding a type also **dismisses its live rows app-wide** (mandatory types excepted) through `NotificationsService.dismissTypesGlobally`, in the same transaction as the settings write (batched, 5 000 rows per statement; the unread-count caches are dropped after commit). Only newly disabled types are swept, so an ordinary save opens no transaction. Re-enabling a type does not restore dismissed rows; `review_queue_*` rows are recreated by the next reconcile, event rows are not. See also [notifications.md section 8.4](notifications.md#84-dismiss-on-disable-is-transactional-with-the-settings-write).

### 7.1 Four hand-maintained copies

`notifications.{browserEnabled, pushEnabled, disabledTypes}` must be edited in four places, or a `PATCH /api/system-settings` validates in unit tests and silently no-ops (or the value is stored but never returned):

1. `systemSettingsSchema` (validation + defaults), `common/schemas/settings.schema.ts`
2. `systemSettingsPatchSchema` (the all-optional twin), same file
3. `patchSystemSettingsSchema`, the **wire DTO** in `settings/dto/update-system-settings.dto.ts`, which strips unknown keys
4. the hand-written merge in `SystemSettingsService.patchSettings`

(`common/types/settings.types.ts` carries the TypeScript type and `DEFAULT_SYSTEM_SETTINGS` as a fifth touch point.) The admin page (`/admin/settings/notifications`) PATCHes only these three keys; the API merges the namespace field by field, so the retention knobs edited on the Storage page are untouched.

## 8. Per-User Push Preferences

Stored in `user_settings.value.notifications.push`:

```jsonc
{ "notifications": { "push": { "enabled": false, "types": { "upload_completed": false } } } }
```

- **Absent means enabled**, exactly like the inbox switches: `push.enabled` and every `push.types` key are `.optional()` with no `.default()`. A newly added `NotificationType` is therefore opt-out, and no migration was needed.
- `resolveNotificationPreferences` computes `push.types[t] = push.enabled !== false && push.types[t] !== false`. It is deliberately **not** ANDed with the inbox switches: the dispatcher only pushes a row the inbox gate already let through, so the inbox gate applies by construction, and disabling push can never be mistaken for disabling (and dismissing) the inbox type.
- PATCH merges field-wise: `push.enabled: null` and a `push.types[t]: null` delete that key (restoring the default); `push: null` clears the whole sub-namespace. `z.partialRecord` is used for `types` because in zod v4 `z.record(z.enum([...]))` is exhaustive.
- The user page (`NotificationSettings.tsx`) offers a per-type **Push** switch only for types in `GET /api/notifications/config` -> `pushTypes`, disables every push switch when the deployment has push off, when the inbox master is off, or when that type's inbox switch is off, and re-enabling writes `null` rather than pinning `true`. The push switches are per **account**; a device's browser permission never disables them, it only decides whether pushes can be delivered on that device.
- The mandatory type's inbox row ignores the preferences (section 3), but its push honours them.

## 9. VAPID Configuration Storage

Runtime-configured, **no environment variables**. This diverges deliberately from EAB, whose config falls back to `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`. This repository's rule is that storage, AI, Web Push and SMTP are configured at runtime in the admin UI and never get environment variables, because two sources of truth is the failure that rule prevents. No row means "not configured", full stop; the sole deployment dependency is `SECRETS_ENCRYPTION_KEY`.

**Storage.** A `system_settings` row with `key = 'webPush'`, a **separate row** from `global`. `GET /api/system-settings` and every `SystemSettingsService` read touch only `global`, so the encrypted private key can never ride out on the generic settings response. The only readers are `PushConfigService` and `PushTestService`'s source diagnostics. The shape (`storedPushConfigSchema`, parsed with `safeParse` so a corrupted row degrades to "push off" rather than a 500 on the page that repairs it):

| Field | Notes |
|---|---|
| `enabled` | admin switch |
| `publicKey` | base64url VAPID public key (returned to clients) |
| `subject` | `mailto:` address or `https://` URL; `null` falls back to `mailto:admin@example.com` |
| `privateKeyEncrypted` | AES-256-GCM ciphertext (`encryptSecret`, keyed by `SECRETS_ENCRYPTION_KEY`), same scheme as `email.smtpPassword`. **Never returned by any endpoint** |
| `privateKeyLast4` | for the admin's "which key" display |
| `updatedAt`, `updatedById` | last write |

**Active-config resolution** (`resolveActiveVapidConfig`, the one place every sender asks): no row, an invalid row, `enabled: false`, an incomplete key pair, or a private key that cannot be decrypted (wrong `SECRETS_ENCRYPTION_KEY`) all resolve to `null`, uniformly meaning "push is off", each logged distinctly. Otherwise `{ publicKey, privateKey, subject }`. There is no fallback of any kind.

**Actions** (`PushConfigService`; each writes an `audit_events` row `push_config:<action>` whose `meta` carries only `enabled`/`subject`, never a key):

| Action | Route | Behaviour |
|---|---|---|
| generate | `POST /api/admin/push-config/generate` | First-time only; **409** if any key half exists. Enables push. |
| update | `PUT /api/admin/push-config` | `{ enabled?, subject? }`. Never mints keys: enabling with no key pair is **409**. Disabling retains the keys. |
| rotate | `POST /api/admin/push-config/rotate` | Body `{ confirmation: 'ROTATE' }`. Replaces the pair, keeps `enabled`. **409** when nothing is configured. |
| remove | `DELETE /api/admin/push-config` | Body `{ confirmation: 'REMOVE' }` (a deliberately different word). Deletes the row. |

`GET /api/admin/push-config` returns `PushConfigAdminView` (`enabled`, `publicKey`, `subject`, `effectiveSubject`, `configured`, `active`, `privateKeyStatus { configured, last4, updatedAt }`, `settingsError`, `updatedAt`, `updatedById`). A compile-time check (`PUSH_CONFIG_ADMIN_VIEW_CARRIES_NO_SECRET`) fails the build if a secret-named field is added to the view. Rotating or removing does **not** delete `push_subscriptions` rows; see section 13 and the [runbook](../runbooks/vapid-keys.md) for what happens to them.

## 10. The Client Config Endpoint

`GET /api/notifications/config` (any authenticated user; the users push reaches are exactly the users who cannot read system settings):

```ts
interface NotificationClientConfig {
  pushEnabled: boolean;          // an active VAPID pair exists AND policy.pushEnabled
  vapidPublicKey: string | null; // applicationServerKey; null when push is off
  browserEnabled: boolean;       // admin toast switch
  pushTypes: NotificationType[]; // push-capable types the policy lets travel; [] when push is off
}
```

The admin kill switch hides push entirely, so a client never spends the one-shot browser permission prompt on a channel that cannot deliver. It exposes the public key only. Clients treat `config === null` as "not known yet", never "disabled" (`config?.browserEnabled === false`, `config?.pushEnabled === true`), or the disabled state would flicker in on every load.

## 11. The Live Stream (SSE)

`GET /api/notifications/stream` (`@Sse('stream')`, bare `@Auth()`), backed by `NotificationStreamService`.

### 11.1 Frames

Every payload carries a `type` discriminator.

| SSE `event:` | `data` | Meaning |
|---|---|---|
| `notification` | `{ type:'notification', notification, unreadCount?, toast, pushed, reason }` | A notification was written, re-marked unread or incremented. `notification` has the `GET /api/notifications` item shape; `reason` is `created` \| `reunread` \| `incremented`; `unreadCount` is the badge after the write (omitted if unreadable). |
| `sync` | `{ type:'sync' }` | The caller's rows changed in another tab (read, dismiss, read-all, dismiss-all or delete, published by the controller); refetch. |
| `ping` | `{ type:'ping' }` | Keep-alive, on open and every `HEARTBEAT_INTERVAL_MS` (25 s). Ignore it. |

`ping` is a **named event**, not an SSE comment: this Nest version's `SseStream` has no comment support (a `{ comment }` message is written as an empty `id:` frame), and a named event is explicit on the wire and unambiguous for fetch-based parsers. The first ping is sent on subscribe so response headers commit immediately (the SSE writer defers them until the first message), letting the client's `onopen` fire and a buffering proxy flush.

### 11.2 Auth

The route uses the ordinary bearer `@Auth()`: `Authorization: Bearer`, the user taken from the access token and never from a parameter. There is **no query-string token**: a URL is written verbatim into nginx access logs, browser history and `Referer`, which would turn a live credential into something replayable from a log file. Native `EventSource` cannot send headers, so the web app uses a fetch-based client (`services/sse.ts`).

### 11.3 Per-user isolation is structural

`subscribers` is a `Map<userId, Set<Subscriber>>` and `publish(userId, ...)` writes to exactly one bucket; no method reaches more than one user, and the key is the `user_id` of the row just written (or the JWT of the user who just mutated their own rows). A single shared `Subject` with a per-connection `.filter()` was rejected as one deleted predicate away from broadcasting everyone's notifications to every tab. A listener on `notification.dispatched` returns immediately if the user has no open connection, so the unread-count read (cached ~2 s per user) only happens for users with a tab open.

### 11.4 Caps and shutdown

`MAX_CONNECTIONS_PER_USER = 10`: past the cap the **oldest** connection is completed (it reconnects if still wanted), bounding memory against a runaway reconnect loop. `onModuleDestroy` completes every stream so clients reconnect to the new instance instead of hanging.

### 11.5 Interceptor exemption

The global `TransformInterceptor` wraps every response in `{ data, meta }` with a `map()`, which for an Observable would run once **per event**. It returns `next.handle()` untouched when `Reflect.getMetadata(SSE_METADATA, handler)` is set, so this and any future `@Sse()` route is correct automatically.

### 11.6 nginx

Both `infra/nginx/nginx.conf` and `nginx.prod.conf` have a dedicated `location /api/notifications/stream` (longest-prefix match beats `/api`): `proxy_buffering off`, `proxy_cache off`, `chunked_transfer_encoding off`, `add_header X-Accel-Buffering no`, `proxy_set_header Connection ''` (the `/api` block forces `Connection "upgrade"`; SSE is plain HTTP), `proxy_read_timeout 1h` and `proxy_send_timeout 1h`. Buffering is invisible against port 3000, so verify through the proxy.

### 11.7 Client behaviour

`connectSse` (`services/sse.ts`) reconnects with exponential backoff (1 s base, 30 s cap, jittered so tabs do not reconnect in the same millisecond, forgiving the backoff only if a connection held for 10 s). A **401 is the expected failure** (the stream outlives a 15-minute token): it renews once via `api.refreshToken()` and reconnects immediately with no backoff, stopping if renewal fails. Any other non-OK response is a plain retry. The `useNotifications` store opens **one** stream per tab (reference-counted like the poller):

- While the stream is open the 60 s badge poll is replaced by a 5-minute safety net (`STREAM_SAFETY_POLL_MS`); when it drops, the store falls straight back to 60 s polling.
- Every connect **and reconnect** refetches the count (and the panel list if it was opened), because nothing published during a gap is replayed.
- A `notification` frame is applied in place: replace the row if loaded, prepend a new one, and take the frame's `unreadCount` when present (otherwise move optimistically and reconcile with one debounced count read).
- Hidden tabs keep the stream open (only the poll pauses): a hidden tab is exactly where an OS toast is useful.

### 11.8 What SSE is not

It is a liveness nudge, not a delivery guarantee. There is no replay buffer and no `Last-Event-ID` support, deliberately: the table is the source of truth and rows are written before anything is published. A missed frame is a missed toast, never a stale badge.

## 12. Client Capability Model

`useNotificationCapability` layers eight states over `useBrowserNotificationPermission` (which still owns "what is `Notification.permission` right now?"). The union exists because `unsupported` used to conflate situations with unrelated remedies. `resolveNotificationCapability(inputs)` is a pure function, tested as a table; the precedence is the behaviour, ordered outermost obstacle first:

| # | State | Condition | Remedy shown |
|---|---|---|---|
| 1 | `admin-disabled` | `config.browserEnabled === false` | none; every downstream remedy is unactionable |
| 2 | `insecure-context` | `window.isSecureContext === false` (only an explicit `false` counts) | serve over HTTPS |
| 3 | `unsupported` | neither `Notification` nor `serviceWorker` exists | none |
| 4 | `ios-needs-install` | iOS/iPadOS (including an iPad claiming to be a Mac) and not standalone | Share, then Add to Home Screen |
| 5-8 | `denied` / `default` / `sw-unavailable` / `granted` | decided together from the permission | see below |

Permission arms: `denied` and `default` are reported **regardless of the worker**; `granted` with no service-worker registration is `sw-unavailable`; `granted` with one is `granted`. `sw-unavailable` deliberately sits with the permission arms and not above them: ranking a missing worker above `default` would hide the permission button from exactly the user who needs it and make the page-level `new Notification()` fallback unreachable. It is **degraded, not blocked** (the one problem state that leaves its control enabled). Check 3 requires **both** APIs missing so that an iOS Safari tab (no `Notification`, but `serviceWorker`) reaches state 4 instead of being told its browser is incapable.

Every environment probe (`readIsSecureContext`, `readHasNotificationApi`, `readHasServiceWorkerApi`, `readIsIos`, `readIsStandalone`) is non-throwing and feature-detects by access inside `try`, because hardened browsers define these objects and throw on touching them.

**Where it is used.** `usePushSubscriptionSync` (mounted in the app shell, `Layout.tsx`) consumes it and drives the one **auto-prompt**: when push is enabled, the browser toast switch is not off and the capability is `default`, the shell asks for permission once per page load (`claimAutoPermissionPrompt()` returns true once per load, so StrictMode double effects and remounts cannot prompt twice). `NotificationPermissionBanner` (app-wide, for `default`, `denied` and `ios-needs-install`; dismissal kept per capability in `sessionStorage`) and the Notifications card on `/settings` offer the same action by button, plus the Add-to-Home-Screen walkthrough (`AddToHomeScreenPanel`). The buttons still matter: Firefox ignores a request with no user gesture, Safari may throw, and a denial is effectively permanent, so nothing may prompt in a loop.

## 13. Subscription Sync, Rotation and Logout

`services/pushSubscription.ts` is the page half of push. It never throws; every failure is `console.warn`ed and swallowed.

- **Sync on every boot** (`syncPushSubscription(vapidPublicKey)`): a no-op unless permission is already `granted`; otherwise it waits (bounded at 10 s) for `navigator.serviceWorker.ready`, then subscribes if there is no subscription and POSTs `subscription.toJSON()` to `/api/notifications/push/subscriptions`. The POST is an idempotent upsert by endpoint, so re-sending an unchanged subscription costs one request and repairs every drift: a row deleted after a 410, a subscription the worker's `pushsubscriptionchange` replaced but could not report (no token), a browser shared between accounts. Concurrent callers share one in-flight sync.
- **Key rotation**: if the existing subscription's `applicationServerKey` **definitely** differs from the current key, the page calls `subscription.unsubscribe()` first (a browser refuses to subscribe with a different key while the old subscription exists) and subscribes afresh. A browser that does not expose `options.applicationServerKey` counts as a match, because re-subscribing on every boot would mint a new endpoint each time and orphan the previous row. So after `rotate`, a device recovers **the next time the app is opened with permission granted**; a device that is never reopened stays silent, and its stale row is pruned by the failure-count rule (section 5.2).
- **Service-worker `pushsubscriptionchange`**: `sw.ts` best-effort resubscribes with the old subscription's options, then posts `{ type: 'push-subscription-change', resubscribed }` to open windows; `usePushSubscriptionSync` re-syncs on that message. The worker does not call the API (no token).
- **Logout**: `AuthContext.logout` calls `removePushSubscription()` **before** `POST /auth/logout` (it needs the still-valid access token): `DELETE /api/notifications/push/subscriptions` for this browser's endpoint, then a local `subscription.unsubscribe()` so the push service stops accepting messages for the endpoint even if the server call failed. Bounded at 3 s so it cannot hold logout hostage. The next sign-in's boot sync subscribes afresh for whoever that is; and the server-side move-on-upsert (section 5.3) covers a browser that was never logged out cleanly.

## 14. Toasts: Suppression and Dedup

A `notification` frame may raise an OS toast (`showAppNotification`) only when **all** hold: the frame's `toast` is true (admin `browserEnabled` and type not in `disabledTypes`); permission is `granted` (never requested from an incoming event); the row is unread; the tab is **not** both visible and focused (a focused user already sees the bell move); the id is new to this tab (or the frame is a `reunread`, so a counted row toasts once, not per increment); and **not** (`pushed` and this browser holds an active subscription for the current VAPID key), in which case the service worker's `push` handler already shows it. That last check is `hasActivePushSubscription(vapidPublicKey)`, cached 30 s and dropped on every sync/removal; any failure answers `false` (the page shows its own toast).

`showAppNotification` tries the **service worker first** (`registration.showNotification`, via `getRegistration()`, never `.ready`, which never settles on a page with no worker), then falls back to `new Notification()`. The order is the fix, not a preference: the page constructor throws on Android Chrome, so trying it first would work on every desktop and never on Android.

**Cross-tab dedup.** The stream publishes to every tab, so four tabs get four frames. Before showing, the SW path asks `registration.getNotifications({ tag: notification.id })`, which reads the OS tray through the registration shared by every tab of the origin, and skips if one exists. `tag` is the notification id (also set on the page path), so the browser collapses duplicates. Cross-tab leader election was rejected as far more machinery than the problem deserves. `renotify` is deliberately not set, which would restore the duplicate alerting the tag suppresses.

**A push is always shown, even with a focused tab.** In `sw.ts` `handlePush`, every path (including JSON-parse failure, which shows a generic "New notification") ends in an awaited `showNotification`. If a push event settles without one, Chrome substitutes its own "This site has been updated in the background" notification and repeated violations can cost the origin its push permission. Suppressing the push for a focused client would be exactly that "silent push".

## 15. Click Handling

`notificationclick` (`sw.ts`) is the only place a click on a worker-shown notification can be handled, and it may arrive with no page open. It closes the notification first (so the OS cannot deliver a second click while async work is in flight), then:

- **A window is open** (`matchAll({ type:'window', includeUncontrolled:true })`; uncontrolled so a tab open before the worker installed is not mistaken for a cold open): prefer one already on the link's path, focus it, and post `{ type: 'notification-click', id, link, circleId }`. `useNotificationClickHandling` marks the row read and switches circle, on the page's own token. The bell, the inbox page and this handler share one `useOpenNotificationTarget` hook (mark read, circle switch, navigate); it only navigates to root-relative links.
- **No window**: `clients.openWindow(link + '?n=<id>&c=<circleId>')` (`c` only when the row has a circle). The booting app marks the row read, switches to that circle (membership-guarded) and strips both parameters.

`link` is re-validated with `isInternalLink` (a single-leading-slash path) before it feeds a navigation; anything else becomes `/`. The circle switch is guarded by a membership check, mirroring the bell (see [notifications.md section 9.2](notifications.md#92-circle-switch-before-navigate)). A page-raised toast's `onclick` (page path only, since an SW toast returns no handle) marks read and calls the same open handler.

## 16. Test Push and Diagnostics

`POST /api/admin/push-config/test` (`push:write`, because it performs a real signed send and can prune the caller's own dead subscriptions) sends a real push to the **calling admin's own** subscriptions only and always returns 200; a failed send is the diagnostic. It writes no `notifications` or `notification_deliveries` row and is **not a queue job** (it does not outlive its request: a handful of devices in parallel, each capped by a 10 s socket timeout). It keeps endpoint bookkeeping (success clears `failureCount`; 404/410 prunes) but deliberately does **not** increment `failureCount` on other errors, so an admin clicking Test repeatedly while debugging a bad key cannot prune their own healthy devices. Each run writes an `audit_events` row `push_config:test` with counts and hosts only.

The optional body `{ endpoint?, applicationServerKey? }` lets the page report whether this browser's endpoint is registered and whether its subscription key matches the server's. The response (`PushTestResponse`) carries four checks and the resulting `overall` (`sent` \| `partial` \| `failed` \| `not_configured` \| `no_subscriptions`):

1. `config`: is a pair active, is the public key a real uncompressed P-256 point, does the stored private key derive it, is the subject valid.
2. `browser`: is this endpoint registered for the caller; was it created against the key active now.
3. `subscriptions[]`: per device, a `pushService` host, an endpoint **preview** (host plus last 8 characters), `isThisBrowser`, and the send result (`sent` \| `failed` \| `pruned` \| `skipped`, status code, truncated response body, duration).
4. `types[]`: per push-capable type, `mandatory`, `policyAllows`, `preferenceAllows`.

Plus plain-English `hints[]` (config, then browser, then delivery, then routing). The response type is compile-time checked to carry no `privateKey`, `p256dh`, `auth`, `keys` or full `endpoint`.

The test payload carries `test: true`. `sw.ts` always shows it (obeying the critical rule) and posts `{ type: 'push-test-received', id, receivedAt, shown, hadFocusedClient, error? }` to every window client; the page attaches its listener **before** the API call because the push can arrive before the HTTP response. `PushTestPanel` on `/admin/settings/push` runs a seven-step client walkthrough (`services/pushDiagnostics.ts`: `support`, `permission`, `service-worker`, `subscription`, `register`, `server-test`, `delivery`; ack timeout 20 s, service-worker wait 10 s) that points at the link in the chain that broke, plus a "Show local notification" check and a "Copy diagnostics" report (`buildDiagnosticsReport`, safe to paste into an issue). The hint text is keyed in the [runbook's troubleshooting table](../runbooks/vapid-keys.md#troubleshooting).

## 17. RBAC and API Surface

**New permissions** (seeded in `prisma/seed.ts`, granted to the `admin` role only): `push:read`, `push:write`, plus `broadcasts:read` / `broadcasts:write` (see [notification-broadcasts.md](notification-broadcasts.md)). The user-facing routes below carry a bare `@Auth()` like the rest of the notification API: they are personal, scoped to `@CurrentUser('id')`, and there is nothing an Admin permission would protect.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/notifications/stream` | any authenticated | SSE stream (section 11) |
| `GET` | `/api/notifications/config` | any authenticated | `NotificationClientConfig` (section 10) |
| `POST` | `/api/notifications/push/subscriptions` | any authenticated | Upsert this browser's subscription; `201`; `409` when push is not enabled |
| `DELETE` | `/api/notifications/push/subscriptions` | any authenticated | Body `{ endpoint }`; `204`; `404` if not the caller's |
| `GET` | `/api/admin/push-config` | Admin + `push:read` | Admin view (no private key) |
| `PUT` | `/api/admin/push-config` | Admin + `push:write` | `{ enabled?, subject? }` |
| `POST` | `/api/admin/push-config/generate` | Admin + `push:write` | First key pair; enables push |
| `POST` | `/api/admin/push-config/rotate` | Admin + `push:write` | `{ confirmation: 'ROTATE', subject? }` |
| `DELETE` | `/api/admin/push-config` | Admin + `push:write` | `{ confirmation: 'REMOVE' }` |
| `POST` | `/api/admin/push-config/test` | Admin + `push:write` | Test push + diagnostics |

`stream`, `config` and the `push/subscriptions` routes are declared before `:id` in the controller so they are never captured by it. The admin UI: `/admin/settings/push` (card gated on `push:read`; writes disabled with a reason without `push:write`; rotate/remove use one typed-confirmation dialog whose two literals differ so one cannot confirm the other) and `/admin/settings/notifications` (card gated on `system_settings:read`; a batched save because `disabledTypes` is one array replaced wholesale; every stored suppression stays listed even if the type catalog does not know it, so a suppression can never become un-liftable from the one page that lifts it). Both are registry cards in `adminSections.tsx`.

## 18. Rejected Alternatives

| Alternative | Why not |
|---|---|
| `generateSW` | No place for the `push`/`notificationclick`/`pushsubscriptionchange` handlers; `importScripts` splits one worker across two files that cannot see each other |
| `registerType: 'autoUpdate'` | Reloads the page under the user, discarding unsaved work, for a deploy they had no part in |
| Service worker calling the API (mark-read, resubscribe) | It cannot authenticate; acquiring a token would burn the rotating refresh cookie and log the user out |
| Runtime caching of any `/api` response | Cache Storage outlives the session and is not per-account |
| `?token=` on the stream URL | Credentials in nginx logs, history and `Referer` |
| Native `EventSource` | Cannot send an `Authorization` header |
| One shared SSE `Subject` with a per-connection filter | A cross-user leak one deleted predicate away, with no error anywhere |
| SSE comment heartbeat | This Nest version cannot emit comments; a named `ping` event is explicit |
| Suppress push for a focused tab | The "silent push" Chrome penalizes |
| Cross-tab leader election for toasts | `getNotifications({ tag })` reads the registration-wide tray with nothing to coordinate |
| Environment-variable VAPID fallback (EAB) | Two sources of truth |
| A separate push notification row (EAB's channel wrote its own) | One logical notification is one row; the push references its id |
| `webpush.setVapidDetails` | Global state races a concurrent rotation |
| A four-state capability | iOS-needs-install, insecure context, admin-disabled and no-worker all rendered as "unsupported" with different remedies |

## 19. Known Limitations

- **SSE and the push throttle are per API process.** With several replicas a tab on replica A sees nothing published on replica B (the client's 5-minute safety poll and refetch-on-reconnect cover it), and the 5-minute push throttle is per replica.
- **The policy cache is per API process**: a settings write invalidates it on the writing process only; other replicas see the change within the 5 s TTL.
- **No delivery statistics UI.** `notification_deliveries` is queryable but only the diagnostics panel surfaces delivery outcomes, for the admin's own devices.
- **`push` requires a service-worker-capable, HTTPS origin and, on iOS, an installed app** (section 12); nothing in this repo can work around that.
- **Rotation is disruptive** by design: devices that never reopen the app go silent until pruned.

---

## Document History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | August 2026 | AI Assistant | Initial specification for epic #481 (issues #482-#488), documenting the shipped PWA shell and service worker, the channel layer and dispatcher, the push channel and its pruning rules, delivery audit and purge, admin policy, per-user push preferences, runtime VAPID storage, the config endpoint, the SSE stream, the client capability model, subscription sync, toast dedup, click handling and diagnostics |
