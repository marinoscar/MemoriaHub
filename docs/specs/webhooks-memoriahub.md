# Webhooks in MemoriaHub

Status: implemented (RETRO-H4, [#603](https://github.com/marinoscar/MemoriaHub/issues/603), epic [#584](https://github.com/marinoscar/MemoriaHub/issues/584)).

MemoriaHub sends signed HTTP callbacks to receivers its users and administrators register, so a home-automation script, an archiver or a chat bot can react to new photos, deletions, new memories and finished workflow runs instead of polling the API. The machinery (endpoints, the event catalog, signing, the egress guard, delivery jobs, retries, the circuit breaker, the delivery log) is the platform's `@marinoscar/platform-api/webhooks` slice. MemoriaHub adds its events, raises them, and routes the packaged page.

Platform references (EnterpriseAppBase): the [slice README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/webhooks/README.md), the [web README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-web/src/webhooks/README.md), the [spec](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/specs/webhooks.md) and the [operator runbook](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/runbooks/webhooks.md).

## 1. What is mounted

| Piece | Where |
|---|---|
| `WebhooksModule.forRoot({ appName, imports: [WebhooksHostModule] })` | `apps/api/src/platform/webhooks/webhooks.config.ts` |
| `WEBHOOKS_SYSTEM_PRISMA` (the bypass client) | `webhooks-host.module.ts`: the platform's `forSystem` / `runAsSystem` over `PrismaService` until RETRO-D1 brings `PrismaSystemService` ([local exception](../platform-adoption/local-exceptions.md)) |
| MemoriaHub's events | `memoriahub-webhook-events.ts` (registered at import, before the module composes) |
| `MemoriaHubWebhooks`, the one service the write paths call | `memoriahub-webhooks.service.ts`, global through `MemoriaHubWebhooksModule` |
| Credential purpose `webhook_signing` (deployment, organization and user tiers) | `platform/credentials/credential-purposes.manifest.ts` |
| The `webhook` notification channel, `webhooks.endpoint_disabled` and its email | `platform/notifications/notification.manifest.ts` |
| Metrics `app.webhooks.deliveries`, `app.webhooks.delivery.duration`, `app.webhooks.events` | `platform/host-core.config.ts` |
| Permissions `webhooks:*`, `org_webhooks:*`, `system_webhooks:*` | the `webhooks` slice in `app-registrations/permissions.ts`, rendered to `prisma/catalog/permissions.json` |
| Tables `webhook_endpoints`, `webhook_deliveries` | platform migration `0039_add_webhooks`, already installed (`20261108020445_add_webhooks`) |
| Job types `webhooks.deliver`, `webhooks.fanout`, `webhooks.deliveries_purge` | the slice; server-only, type strings permanent |

### Routes and permissions

| Base | Who | Permission (read / write) | Page |
|---|---|---|---|
| `/api/webhooks` | a member's own endpoints | `webhooks:read` / `webhooks:write` (every org role holds both) | `/settings/webhooks` (Settings, `Integrations`) |
| `/api/admin/webhooks` | the deployment's endpoints | `system_webhooks:read` / `system_webhooks:write` (admin) | `/admin/settings/webhooks` (Console, `Operations`) |
| `/api/org/webhooks` | an organization's endpoints | `org_webhooks:read` / `org_webhooks:write` (org admin) | not routed: MemoriaHub runs in single-organization mode |

Each base serves the same eleven routes: list, create, get, change, delete, `rotate-secret`, `test`, an endpoint's `deliveries`, one delivery, `redeliver`, and `events` (the catalog, with each event's JSON Schema and example). The full reference is the OpenAPI document at `/api/docs`.

### Using it (members and administrators)

1. **A member** opens Settings, `Integrations`, `Webhooks` (`/settings/webhooks`). **An administrator** opens the Console, `Operations`, `Webhooks` (`/admin/settings/webhooks`) for deployment endpoints, which are the only ones that receive circle-content events.
2. `New endpoint`: a name, a public `https://` URL and the events (pick single events, a whole group, or everything). Copy the signing secret shown once; it cannot be read again (rotate to get a new one; the old one keeps signing for 24 hours).
3. `Send test event` delivers `webhooks.ping`. Each endpoint's detail lists its deliveries (status, attempts, response snippet) with `Redeliver`.
4. To forward a bell notification, switch on its `Webhook` column on `/settings/notifications` and subscribe an endpoint to `notification.<eventKey>`.
5. An endpoint switched off by the platform shows why ("Paused after repeated failures", "Owner lost access", "Endpoint gone"); fix the receiver, then edit it and save with Enabled on.

## 2. The event catalog

Every key is **permanent**: a receiver subscribes to it by name. Add keys, never rename or remove one. Payloads carry **ids and counts, never content** (no captions, file names, locations, person names, URLs, tokens or secrets); a receiver that needs more reads the API with its own credential. A subscription is an exact key, a group wildcard (`media.*`) or `*`.

| Key | Audience | Permission | Payload (`data`) | Raised by |
|---|---|---|---|---|
| `media.upload.completed` | user (the uploader) | `media:read` | `{ circleId, count, mediaItemIds[≤100], windowStart }` | `MediaService.createMedia`, non-deduplicated path, batched |
| `media.item.created` | system | `media:read` | `{ circleId, count, items[≤100]: { mediaItemId, mediaType, capturedAt, addedById } }` | the same, any uploader, batched |
| `media.item.trashed` | system | `media:read` | `{ circleId, count, mediaItemIds[≤100] }` | `deleteMedia`, `bulkDelete` (which also serves the `move_to_trash` workflow action), burst and duplicate resolutions with `action: 'trash'`; batched |
| `media.item.deleted` | system | `media:read` | `{ circleId, count, mediaItemIds[≤100] }` | `purgeMediaItems`, `purgeMediaItemsBatched` (delete forever, empty trash, the retention purge, the `hard_delete` workflow action); only rows actually removed; batched |
| `memories.memory.created` | system | `media:read` | `{ circleId, count, memoryIds[≤100], types[] }` | `MemoryGenerationHandler` when a pass created memories |
| `workflows.run.completed` | user | `media:read` | `{ runId, workflowId, circleId, status, trigger, succeededCount, failedCount }` | the three terminal transitions (evaluate with no match, evaluate failed for good, the execute-batch finalize) |
| `workflows.run.awaiting_approval` | user | `media:read` | `{ runId, workflowId, circleId, matchedCount }` | `WorkflowEvaluateHandler` moving a run to `awaiting_approval` |

`capturedAt` is the civil capture timestamp (the photographer's wall clock re-encoded as UTC, see [date-model.md](date-model.md)) as known when the item was registered; EXIF read later is not reflected. `status` is `completed`, `completed_with_errors` or `failed`; `trigger` is `manual`, `scheduled` or `on_media_enriched`.

The workflow-run recipient is resolved like the bell's `workflows.run_completed`: the run's starter, or for a `scheduled` run the workflow's creator (each falls back to the other). Unlike the bell, `on_media_enriched` micro-runs are not skipped: a webhook subscription is an explicit opt-in, and the `trigger` field lets a receiver filter them.

A permanently failed enrichment job is the platform's built-in `jobs.job.failed` (system); MemoriaHub registers no `media.enrichment.failed`. The platform also registers `nodes.node.offline` and `nodes.node.event`.

Examples (invented ids):

```json
{ "circleId": "0f8b2c1e-4d5a-4b6c-9e7f-1a2b3c4d5e6f", "count": 1,
  "items": [{ "mediaItemId": "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e", "mediaType": "photo",
              "capturedAt": "2025-12-24T18:30:00.000Z", "addedById": "3c3c3c3c-4d4d-4e5e-8f6f-7a7a7a7a7a7a" }] }
```

```json
{ "runId": "4d4d4d4d-5e5e-4f6f-9a7a-8b8b8b8b8b8b", "workflowId": "5e5e5e5e-6f6f-4a7a-8b8b-9c9c9c9c9c9c",
  "circleId": "0f8b2c1e-4d5a-4b6c-9e7f-1a2b3c4d5e6f", "status": "completed", "trigger": "manual",
  "succeededCount": 42, "failedCount": 0 }
```

### Audience: why circle content is `system`

An `org` endpoint would receive events from circles its owner is not a member of: circles are app-owned until Epic I, and the fan-out's permission re-check cannot express circle membership. So circle-content events (`media.item.*`, `memories.memory.created`) are delivered only to deployment endpoints (administrators). A member's own events (their uploads, runs they started) are `user` events on their own endpoints. Per-circle subscriptions arrive with Epic I.

### Forwarded notifications

Four MemoriaHub notifications carry the `webhook` channel, so a member can forward them to their own endpoints as `notification.<eventKey>` (rendered the way the bell renders them): `notification.media.upload_completed`, `notification.memories.ready`, `notification.workflows.run_completed` and `notification.shares.expiring`. The member switches the channel per event on `/settings/notifications`; an enabled user endpoint must subscribe to the key. An endpoint the platform switches off (`circuit_open`, `gone`, `owner_lost_access`) notifies its owner with `webhooks.endpoint_disabled` (bell and email).

## 3. When an event is raised

**After the write commits, never inside a transaction.** Every call site raises its event after the triggering statement (or `$transaction`) returned; a rolled-back write raises nothing (`test/webhooks/emit-after-commit.spec.ts`). `MemoriaHubWebhooks` never throws into its caller.

**Media is batched.** A 4 000-file import must not fan out 4 000 deliveries to every endpoint. `MediaService` and the review services hand each item to `MemoriaHubWebhooks` synchronously, with no I/O; a `WebhookBatcher` keeps one open batch per event and circle (and per uploader for `media.upload.completed`) and closes it at **100 ids or 60 seconds** after its first entry. A closed batch becomes **one** `webhooks.fanout` job (a single insert); the fan-out job finds the subscribed endpoints and queues one `webhooks.deliver` job per endpoint. A 1 000-file import therefore yields 10 `media.item.created` and 10 `media.upload.completed` deliveries per subscribed endpoint (`test/webhooks/memoriahub-webhooks.service.spec.ts`, `webhooks.db.spec.ts`).

Open batches live in the API process: `onApplicationShutdown` flushes them, but a crash loses the open window (at most 100 ids per bucket). Media events are therefore at-most-once; a receiver that needs completeness reconciles through the API (`GET /api/media`).

**Memories and workflow runs** are raised from their job handlers after the terminal write, re-reading the committed rows; at most 100 memory ids per event.

**Nobody listening costs nothing.** Before queuing or emitting, `MemoriaHubWebhooks` checks (cached 30 s, one read in flight) whether any enabled endpoint subscribes to the key; a deployment without webhooks queues no job.

## 4. Delivery, signing and safety (the platform's)

- **Signing.** Standard Webhooks headers `webhook-id` (the event id, identical across retries and redeliveries), `webhook-timestamp` and `webhook-signature` (`v1,<base64>` HMAC-SHA256; two entries during a 24 h rotation overlap). The secret (`whsec_...`) is shown once, on create and on rotate, and lives in the credential store (purpose `webhook_signing`), never in a column, a log or a response.
- **Retries.** 30 s, 2 m, 10 m, 30 m, 1 h, 2 h, 4 h, 6 h, 6 h (jittered; `Retry-After` honoured up to 24 h), ten attempts, then `dead`. 20 consecutive failures open the circuit and switch the endpoint off; `410 Gone` switches it off at once. Redeliver from the delivery drawer.
- **Egress guard (SSRF).** https only, no userinfo, ports 80, 443, 8443 and 1024 and above; every address the host resolves to must be public unicast, checked at create and again at every send, and the connection is pinned to the checked address. Redirects are never followed.
- **Ownership.** The event's permission (`media:read`) is re-checked for the endpoint's owner at every fan-out; an owner who lost it has the endpoint switched off (`owner_lost_access`).
- **Retention.** Deliveries are purged after 30 days (`webhooks.deliveries_purge`, queued daily).

## 5. Verifying a delivery (receiver snippet)

Verify over the **raw, unparsed** body, reject stale timestamps (the helper's default tolerance is 300 s), and deduplicate on `webhook-id`:

```ts
import { verifyWebhookSignature } from '@marinoscar/platform-contract/webhooks';

const SECRET = process.env.RECEIVER_SIGNING_SECRET!; // whsec_..., copied when the endpoint was created
const seen = new Set<string>();

export async function handle(headers: Record<string, string>, rawBody: string): Promise<number> {
  const ok = await verifyWebhookSignature({
    secret: SECRET,
    id: headers['webhook-id'],
    timestamp: headers['webhook-timestamp'],
    body: rawBody,
    signatureHeader: headers['webhook-signature'],
  });
  if (!ok) return 401;
  if (seen.has(headers['webhook-id'])) return 200; // a retry or redelivery of an event already handled
  seen.add(headers['webhook-id']);

  const event = JSON.parse(rawBody) as { id: string; type: string; data: unknown };
  if (event.type === 'media.item.created') {
    // event.data.items: [{ mediaItemId, mediaType, capturedAt, addedById }]
  }
  return 200; // answer within 10 s; do slow work after answering
}
```

The helper needs only Web Crypto. Any Standard Webhooks library verifies the same headers.

## 6. Operations

- **No environment variable, no migration.** The egress policy is a `forRoot` option: a deployment that must call an internal receiver adds its host to `allowedHosts` in `webhooks.config.ts` (never `allowPrivateTargets` outside development). Delivery needs outbound HTTPS from the API process to each receiver.
- **Observability.** Span `webhooks.deliver` per attempt; metrics `app.webhooks.deliveries` (`outcome`, `event_group`), `app.webhooks.delivery.duration`, `app.webhooks.events` (`queued`, `no_match`, `invalid`, `unknown`); no endpoint, URL, user or organization label. Log lines name the delivery id, outcome, status and the receiver's host only, never a path, payload, secret or signature. The jobs dashboard shows `webhooks.fanout` and `webhooks.deliver`.
- **Rollback.** Revert the change: pending fan-out and delivery jobs fail closed (their handlers are gone), endpoints stay in the tables, inert.

## 7. Tests

| Spec | Proves |
|---|---|
| `apps/api/test/conformance.spec.ts` (`webhooks`) | routes enforce exactly their tier's permission, signatures verify, the egress guard, secret secrecy, no HTTP outside the delivery job, no cross-owner/scope/org access |
| `apps/api/test/webhooks/memoriahub-webhook-events.spec.ts` | the keys, audiences and permissions; each example against its schema; the catalog per scope with JSON Schema; a signed `workflows.run.completed` delivery verified with `verifyWebhookSignature`; private targets refused |
| `apps/api/test/webhooks/memoriahub-webhooks.service.spec.ts` | batching (1 000 uploads, 10 events per key), the window, the subscription short cut, recipient resolution, never throws |
| `apps/api/test/webhooks/emit-after-commit.spec.ts` | no event for a rolled-back trash resolution or a failed purge |
| `apps/api/test/webhooks/webhooks.db.spec.ts` | real Postgres: 150 uploads become two fan-out jobs and two deliveries per endpoint; a replayed fan-out inserts nothing |
| `apps/web/src/__tests__/platform/webhooks.test.tsx`, `config/*` | the cards, the routes and their permissions, each scope's route family |
