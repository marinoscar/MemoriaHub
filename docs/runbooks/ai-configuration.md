# Runbook: AI configuration (platform AI slice, RETRO-E1)

**Applies to:** the release that mounts the platform AI slice (RETRO-E1, issue #595) and later, until
RETRO-E2/E3/E4 finish the move.
**Code:** `apps/api/src/platform/ai/` (composition: `ai.config.ts`, `ai-host.module.ts`, the `ai`
settings extension), `apps/api/src/ai-port/` (the legacy provider adapter), `apps/api/src/ai/` (the
old admin routes, still serving the AI settings page).
**Platform reference:** the EnterpriseAppBase runbook `docs/runbooks/ai-configuration.md` and the slice
README `packages/platform-api/src/ai/README.md`. This page says what applies to MemoriaHub today.

## What changed in this release

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
[AI platform migration](ai-platform-migration.md). Until RETRO-E4, keys are changed only through
`PUT|DELETE /api/admin/ai/providers/:provider/key` (the key buttons on `/admin/settings/ai` answer
410); "Re-enter the key" in the troubleshooting table below means that route.

## Do not turn the platform kill switch on yet

`/admin/settings/ai` in this release is still MemoriaHub's own page; the platform's admin pages arrive
with RETRO-E4. Turning `ai.enabled` on (with `PATCH /api/system-settings` `{"ai":{"enabled":true}}`) only
opens the platform's consumer routes, which nothing in MemoriaHub calls yet, and which also need the
storage slice's `PrismaService.forOrg` (RETRO-D1) to record usage. Leave it off until RETRO-E2/E4.

To verify the switch is off: `GET /api/ai/config` answers `enabled: false`, and any other `/api/ai/*`
platform route answers `403` with `details.reason: "AI_DISABLED"`. `/api/admin/ai/*` stays reachable to an
administrator either way (it is deliberately not behind the switch).

## Emergency: stop all AI calls

The platform kill switch does **not** stop MemoriaHub's own features in this release. To stop them:

1. Turn the feature flags off at `/admin/settings/*`: `features.autoTagging` (photos and videos),
   `features.pictureEnhancement`, `features.memories` (titles fall back to templates). Agentic and
   semantic search stop when no `ai.features.search` / `ai.features.embedding` selection is set.
2. Or disable the provider credential on `/admin/settings/ai` (`enabled` off): every call for that
   provider fails with "Provider is disabled".
3. Worker nodes fetch a per-job key for `auto_tagging` and `video_auto_tagging`; disabling the credential
   stops those too (see the node row in `docs/platform-adoption/local-exceptions.md`).

## Rate limits

A provider throttle still defers the job instead of charging an attempt: the adapter turns the
platform's `AI_RATE_LIMITED` into status `429` with a `retry-after` header, and Anthropic's `529`
(overloaded) keeps status `529`. Both are what the queue's rate-limit classifier reads.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| The AI settings page shows no models in a picker | It still calls the old listing; a stale web bundle calls `GET /api/ai/models` (now the platform route, which answers the signed-in user's usable models, empty while the kill switch is off) | Reload the page so the new bundle (calling `/api/ai/settings/models`) is used |
| Tagging fails with "Invalid API key" | The stored key was rejected by the provider | Re-enter the key on `/admin/settings/ai` |
| Tagging fails with "Model not found: <model>" | The selected model id does not exist for the key | Pick another model on `/admin/settings/ai` |
| An OpenAI-compatible endpoint (custom `baseUrl`) stopped working | It must speak Chat Completions | Unchanged from before; check the endpoint |
| `POST /api/ai/responses` answers `403 AI_DISABLED` | Expected: the platform kill switch is off in this release | Nothing to do |
| `/api/admin/ai/*` answers `403` for an administrator | The seed has not run since the upgrade, so `ai_config:*` is not granted yet | Run the update (or the seed) again |

## Rollback

Revert to the previous release: the SDK providers return, the platform routes disappear. No data was
changed, so nothing needs restoring. The new permission rows the seed added are harmless if left.
