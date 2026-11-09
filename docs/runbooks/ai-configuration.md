# Runbook: AI configuration (platform AI slice, RETRO-E1)

**Applies to:** the release that mounts the platform AI slice (RETRO-E1, issue #595) and later; the
admin pages are the platform's since RETRO-E4 (#607). RETRO-E2 moves the features themselves.
**Code:** `apps/api/src/platform/ai/` (composition: `ai.config.ts`, `ai-host.module.ts`, the `ai`
settings extension), `apps/api/src/ai-port/` (the legacy provider adapter, `AiSettingsService` and,
since RETRO-E4, the feature-selection routes `/api/admin/memoriahub-ai/*`), `apps/web/src/platform/ai/`
(the admin AI page bindings, RETRO-E4).
**Platform reference:** the EnterpriseAppBase runbook `docs/runbooks/ai-configuration.md` and the slice
README `packages/platform-api/src/ai/README.md`. This page says what applies to MemoriaHub today.

## Where each AI setting is (since RETRO-E4, #607)

| Setting | Page | API | Permission |
|---|---|---|---|
| AI on/off (the platform kill switch), key policy, provider slots, limits, hosted tools | `/admin/settings/ai` (the platform `AiConfigPage`; card **AI**, visible while AI is off) | `GET\|PUT /api/admin/ai/config` | `ai_config:read` / `ai_config:write` |
| A provider's deployment key (write-only; the card shows the last four characters) | `/admin/settings/ai`, the provider card: **Save key**, **Test**, **Remove key** | `PUT\|DELETE /api/admin/ai/providers/:provider/key`, `POST /api/admin/ai/providers/:provider/test` | `ai_config:write` |
| Which provider and model serve each MemoriaHub feature (agentic search, photo and video tagging, search-by-meaning embeddings, the Picture Enhancer, memory titles, video speech-to-text) | `/admin/settings/ai`, section **MemoriaHub AI features** at the bottom | `GET /api/admin/memoriahub-ai/features`, `PUT /api/admin/memoriahub-ai/features/{search,tagging,embedding,enhance,memories,transcription}`, `GET /api/admin/memoriahub-ai/models?provider=&capability=chat\|embedding\|image\|transcription`, `POST /api/admin/memoriahub-ai/test`, `POST /api/admin/memoriahub-ai/test/embedding` | `ai_config:read` / `ai_config:write` |
| Model catalogue | `/admin/settings/ai/models` (card **AI Models**, hidden while AI is off) | `GET /api/admin/ai/models`, `POST /api/admin/ai/models/refresh`, `PATCH /api/admin/ai/models/:id` | `ai_config:read` / `ai_config:write` |
| Usage of the platform AI routes | `/admin/settings/ai/usage` (card **AI Usage**, hidden while AI is off) | `GET /api/admin/ai/usage` | `ai_config:read` |
| Tag vocabulary and the tagging switches | `/admin/settings/tagging` | `/api/tag-labels` (vocabulary), `PATCH /api/system-settings` (flags) | `ai_config:read\|write` (vocabulary), `system_settings:*` (flags) |
| Picture Enhancer readiness | `/admin/settings/enhancer` | `GET /api/admin/memoriahub-ai/enhance/status` (was `/api/admin/ai/enhance/status`) | `system_settings:read` |

**Retired:** MemoriaHub's `/admin/settings/ai` page (`AiSettingsPage`), the routes `GET /api/ai/settings`,
`GET /api/ai/settings/models`, `POST /api/ai/test`, `POST /api/ai/test/embedding`,
`PUT /api/ai/features/*`, `PUT|DELETE /api/ai/credentials/:provider`, and the permission pair
`ai_settings:read|write` (removed from the manifest and the catalog; `ai_config:read|write` replaces it
on every route and card). Old web bundles that call a retired route get a `404`: reload the page.

**MemoriaHub's features still ignore the platform switch.** They run on the legacy adapter
(`src/ai-port/`, until RETRO-E2) with the deployment key saved on the provider card, whether "AI enabled"
is on or off; the MemoriaHub section says so. Turning AI on shows the AI Models and AI Usage cards and
opens the platform consumer routes; usage of MemoriaHub's own features is not on the usage page yet.

### After upgrading to RETRO-E4

1. Run the usual update (the seed upserts; `ai_config:*` is already granted to `admin` since RETRO-E1).
2. Optional clean-up: the seed never deletes, so the retired pair stays in `role_permissions` and
   `permissions` (nothing checks it). To remove it:
   `DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE name IN ('ai_settings:read','ai_settings:write'));`
   then `DELETE FROM permissions WHERE name IN ('ai_settings:read','ai_settings:write');`. Rehearse on a
   restored backup first. Rollback: re-run the previous release's seed, which re-adds them.
3. Check `/admin/settings/ai`: each provider card shows its key as configured (keys imported by
   `npm run ai:migrate-keys` in RETRO-E3, or saved here), and the MemoriaHub section shows the same
   selections as before (the stored `ai.features.*` row is unchanged).

## What changed in the RETRO-E1 release

| | Before | After (E1) |
|---|---|---|
| Provider SDKs | `openai` and `@anthropic-ai/sdk` imported in `apps/api/src/ai/providers/` and declared by `apps/api` | Imported only inside `@marinoscar/platform-ai-providers`; none in `apps/` (the `ai-no-sdk-leak` conformance suite proves it) |
| MemoriaHub's AI features (tagging, video tagging, semantic and agentic search, memory titles, the picture enhancer, transcription) | SDK-backed providers, keys from `ai_provider_credentials` | **Same keys, same settings, same admin page**; the calls run through the platform's provider adapters (`src/ai-port/`) |
| Platform AI routes | none | Mounted: `GET /api/ai/config`, `/api/ai/*` (responses, runs, embeddings, images, audio, realtime, keys, features, usage) and `/api/admin/ai/*` |
| Kill switch | none | `ai.enabled`, **off by default**. It governs ONLY the platform routes above; MemoriaHub's own features do not consult it until RETRO-E2 |
| `ai` settings namespace | MemoriaHub's own (`features.*` only) | The platform's (`enabled`, `keyPolicy`, `providers`, `defaults`, `limits`, ...) plus MemoriaHub's `features.*`, same names and shapes; nothing in the stored row is rewritten |
| Permissions | `ai_settings:read`/`ai_settings:write` (admin) | Unchanged for the old routes; new: `ai_config:read`/`ai_config:write` (admin), `ai:use` (org: `org_admin`, `contributor`; not `viewer`), `org_ai_config:read`/`org_ai_config:write` (`org_admin`). The seed writes them on the next update |
| Admin model listing | `GET /api/ai/models?provider=&capability=` | `GET /api/ai/settings/models?provider=&capability=` (same answer). The platform owns `GET /api/ai/models` now (a user's usable models) |
| OpenAI wire API | Chat Completions | Responses API (an `openai` credential whose `baseUrl` is not OpenAI's still uses Chat Completions, through the platform's OpenAI-compatible adapter) |

## After the upgrade

Nothing to do. There is no data migration in this release: the keys stay in `ai_provider_credentials`
(RETRO-E3 imports them into the platform key store in two releases), and the feature selections stay in
`ai.features.*`. Run the usual update (`update.sh` runs the seed, which adds the new permission ids and
their grants).

Check that AI still works:

1. `/admin/settings/ai`: the providers show as configured, **Test** passes for the search and tagging
   models, **Test embedding** reports 1536 dimensions for `text-embedding-3-small`.
2. Tag one photo (`Re-run AI tagging` on an item) and run one agentic search.
3. Doctor (`/admin/settings/doctor`): the `memoriahub.ai.*` checks are unchanged. Two platform checks are
   new, `ai.enabled` and `ai.providers` (which depends on it); both read **skip** while the platform kill
   switch is off, which is expected in this release.

## Key migration (RETRO-E3, release N)

From RETRO-E3 release N the deployment keys move from `ai_provider_credentials` to the platform key
store. Run `npm run ai:migrate-keys --workspace=api -- --dry-run`, then `--apply`, **before** upgrading
to the release that drops the old table; the procedure, the report and the rollback are in
[AI platform migration](ai-platform-migration.md). Keys are changed only through
`PUT|DELETE /api/admin/ai/providers/:provider/key`, which since RETRO-E4 is the provider card of
`/admin/settings/ai`; "Re-enter the key" in the troubleshooting table below means that card.

## Do not turn the platform kill switch on yet

Since RETRO-E4 the switch is on `/admin/settings/ai` (the platform page). Turning it on only opens the
platform's consumer routes and shows the AI Models and AI Usage cards; nothing in MemoriaHub calls those
routes until RETRO-E2, and MemoriaHub's own features run either way. There is no harm in turning it on,
but there is no benefit yet either: leaving it off keeps the consumer routes closed.

To verify the switch is off: `GET /api/ai/config` answers `enabled: false`, and any other `/api/ai/*`
platform route answers `403` with `details.reason: "AI_DISABLED"`. `/api/admin/ai/*` stays reachable to an
administrator either way (it is deliberately not behind the switch).

## Emergency: stop all AI calls

The platform kill switch does **not** stop MemoriaHub's own features in this release. To stop them:

1. Turn the feature flags off at `/admin/settings/*`: `features.autoTagging` (photos and videos),
   `features.pictureEnhancement`, `features.memories` (titles fall back to templates). Agentic and
   semantic search stop when no `ai.features.search` / `ai.features.embedding` selection is set.
2. Or remove the provider's key on its card on `/admin/settings/ai` (and its legacy row, if
   `npm run ai:migrate-keys` has not been applied): every call for that provider fails.
3. Worker nodes fetch a per-job key for `auto_tagging` and `video_auto_tagging`; disabling the credential
   stops those too (see the node row in `docs/platform-adoption/local-exceptions.md`).

## Rate limits

A provider throttle still defers the job instead of charging an attempt: the adapter turns the
platform's `AI_RATE_LIMITED` into status `429` with a `retry-after` header, and Anthropic's `529`
(overloaded) keeps status `529`. Both are what the queue's rate-limit classifier reads.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| A model picker of the MemoriaHub AI features section is empty | The provider offers no model for that feature (Anthropic has no image-edit, embedding or speech-to-text model), or a stale web bundle calls a retired route (`404`) | Pick OpenAI for those features; reload the page |
| A MemoriaHub feature shows "has no enabled deployment key" | No key for that provider in the platform store or the legacy row | Save the key on the provider's card on `/admin/settings/ai` |
| Tagging fails with "Invalid API key" | The stored key was rejected by the provider | Re-enter the key on the provider card of `/admin/settings/ai` |
| Tagging fails with "Model not found: <model>" | The selected model id does not exist for the key | Pick another model in the MemoriaHub AI features section of `/admin/settings/ai` |
| An OpenAI-compatible endpoint (custom `baseUrl`) stopped working | It must speak Chat Completions | Unchanged from before; check the endpoint |
| `POST /api/ai/responses` answers `403 AI_DISABLED` | Expected: the platform kill switch is off in this release | Nothing to do |
| `/api/admin/ai/*` answers `403` for an administrator | The seed has not run since the upgrade, so `ai_config:*` is not granted yet | Run the update (or the seed) again |

## Rollback

Revert to the previous release: the SDK providers return, the platform routes disappear. No data was
changed, so nothing needs restoring. The new permission rows the seed added are harmless if left.
