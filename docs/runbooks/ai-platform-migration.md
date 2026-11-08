# Runbook: Move the AI provider keys to the platform key store (RETRO-E3)

**Audience:** the operator of a MemoriaHub deployment upgrading to the release that ships
`npm run ai:migrate-keys` (RETRO-E3 release N, issue #605, epic #589).
**Run it once per deployment**, after the upgrade to release N and **before** the upgrade to release
N+1.

> **Order matters, and the last step cannot be undone.**
>
> 1. **Release N** (this one) adds the import. Take a database backup, run the command with
>    `--dry-run`, then `--apply`, and confirm the report (section 4) shows no `undecryptable`, no
>    `failed` and no `unsupported_base_url`.
> 2. **Release N+1** runs `DROP TABLE "ai_provider_credentials";` during `prisma:migrate` and deletes
>    the import, the legacy cipher and the legacy key reader.
>
> After release N+1 the old table does not exist. The only way back to a key that was not imported is
> to restore the backup from step 1 of section 3.

Source of truth for every claim below:

- `apps/api/src/ai-port/migrate/ai-legacy-migrate.ts`: the command (compiled into `dist/`).
- `apps/api/src/ai-port/migrate/ai-legacy-plan.ts`: the pure plan (one decision per provider).
- `apps/api/src/ai-port/migrate/legacy-cipher.ts`: the read-only (decrypt-only) legacy cipher.
- `apps/api/src/ai-port/ai-deployment-key-source.ts`: the legacy key reader the app uses meanwhile.
- `apps/api/test/ai/ai-legacy-migrate.db.spec.ts`: every behaviour here, against a real PostgreSQL.

It is an operator command, not a queue job: no request or schedule starts it, so the job-queue rule
does not apply (the kvox precedent).

## 1. What changes, and what never does

MemoriaHub's AI keys have always been **deployment keys** (one per provider, used for every user and
every background job). Before release N they live in `ai_provider_credentials` (`provider` unique,
`encrypted_key` in the pre-platform cipher, `base_url`, `last4`, `enabled`). The platform keeps the
deployment key in the encrypted credential store at purpose `ai`, name `<provider>`: the address
`PUT /api/admin/ai/providers/:provider/key` writes, and `AiKeyResolver` (deployment tier) and
`AiConfigService.getOrgKey` read.

For each `ai_provider_credentials` row, `--apply`:

| Writes | Where |
|---|---|
| the key, re-encrypted in the platform envelope, then read back and compared (round trip) | `credentials` (purpose `ai`, name = provider), label `AI provider key (<label>)`, `updatedByUserId` = the row's last editor, else the `INITIAL_ADMIN_EMAIL` user |
| `enabled` = the row's `enabled`; `baseUrl` = the row's `base_url` (when set and the provider slot accepts it) | `system_settings` `global` row, `ai.providers.<provider>` |
| one audit row per key | `audit_events` `ai_config:set_key` (`meta.source: "legacy_import"`) |

Once at least one key is written, it also makes the deployment keys serve every user, which is what
MemoriaHub has always done: `ai.keyPolicy = "byok_with_org_fallback"` (the platform has no
"deployment key only" policy; MemoriaHub stores no per-user keys, so a user key never wins) and
`ai.deploymentKeyServesOrgs = true` when it is not set (a stored `false` is kept and reported). One
`ai_config:update` audit row records it. Every other field of the `ai` namespace, including
MemoriaHub's `ai.features.*` selections, keeps its stored value.

**Never touched:** `ai_provider_credentials` (no row is modified or deleted; release N+1 drops the
table), the platform kill switch `ai.enabled` (off by default; see
[AI configuration](ai-configuration.md)), user and organization keys (MemoriaHub has none).

**Not verified with the provider.** The import stores the key exactly as it was; it does not call the
provider (the platform's admin `setKey` would, and a carry-over must not depend on the provider
answering). Verify afterwards (section 5).

## 2. What keeps working, before and after

The app reads keys through `AiDeploymentKeySource` (PLATFORM-ADOPTION-SHIM(#605)): **the platform key
first** (with its slot's `enabled` and `baseUrl`), **then the legacy row** (logging one warning per
provider per process: "served from the legacy ai_provider_credentials table"). So every AI feature
(tagging, video tagging, search, embeddings, the enhancer, transcription, memory titles), the AI
Doctor checks, the worker-node per-job credential for `auto_tagging` / `video_auto_tagging`
(PLATFORM-ADOPTION-SHIM(#1083)) and `GET /api/ai/settings` work before the import, after it, and
after a revert of release N.

Keys are now changed only in the platform store: `PUT /api/ai/credentials/:provider` and
`DELETE /api/ai/credentials/:provider` answer **410** (`details.reason: "AI_LEGACY_KEY_WRITES_GONE"`,
`details.route` names the replacement). Use `PUT|DELETE /api/admin/ai/providers/:provider/key`
(`ai_config:write`; the PUT verifies the key with the provider before storing it). Until RETRO-E4
ships the platform admin AI pages, the Save and Remove buttons for keys on `/admin/settings/ai` show
that 410; call the route from the API reference (`/api/docs`) or `curl` instead. A provider's on/off
switch for a platform key is `ai.providers.<id>.enabled` (`PUT /api/admin/ai/config`).

## 3. Procedure

1. **Back up the database** (`/admin/settings/db-backup`, or `pg_dump`), and keep the archive until
   release N+1 has run for a while. Rehearse first on a restored copy (the RETRO-A5 rehearsal database
   is ideal) when you can.
2. **Dry run** (writes nothing):

   ```bash
   # in the API container (production image: dist/)
   npm run ai:migrate-keys --workspace=api -- --dry-run
   # in a development checkout (no build needed)
   npm run ai:migrate-keys:dev --workspace=api -- --dry-run
   ```

   It needs `SECRETS_ENCRYPTION_KEY` (the key that encrypted the legacy rows) and the API's
   `POSTGRES_*` settings; a checkout's `apps/api/.env` and `infra/compose/.env` are loaded when
   present. No key is passed on the command line or in the environment.
3. **Read the report** (section 4). Fix every `undecryptable` and `failed` line, and decide each
   `unsupported_base_url`, before going on.
4. **Apply:**

   ```bash
   npm run ai:migrate-keys --workspace=api -- --apply
   ```

5. **Verify** (section 5).
6. Only then **upgrade to release N+1**.

## 4. The report

One line per provider, then a summary. It carries the provider, the outcome, `last4` and a reason,
never a key, an endpoint or a ciphertext:

```text
APPLY: ai_provider_credentials -> platform AI keys
  provider=anthropic outcome=imported last4=8765 enabled=false
  provider=openai outcome=imported last4=4321 enabled=true baseUrl=set
  ai policy: keyPolicy=byok_with_org_fallback, deploymentKeyServesOrgs=true
  summary: imported 2, skipped_existing 0, undecryptable 0, unsupported_base_url 0, failed 0
```

| Outcome | Meaning | What to do |
|---|---|---|
| `imported` | Key written and read back; slot written. Reason `replaced_existing_key` with `--replace`; `key_present_slot_completed` when an earlier run stopped after the key and before the slot | Nothing |
| `skipped_existing` | The platform already holds a key: the same one (`same_key_already_stored`) or a different one (`different_key_kept_use_replace`) | Nothing, or `--replace` (section 6) |
| `undecryptable` | `SECRETS_ENCRYPTION_KEY` cannot decrypt the row (wrong key, edited row). Nothing written for it; the other rows still run | Run with the key the deployment had when the row was written; or re-enter that key with `PUT /api/admin/ai/providers/:provider/key` |
| `unsupported_base_url` | The row's `base_url` is not accepted by the provider's platform slot (reason names why). The key is **not** imported, so the app keeps serving it from the legacy row | Before release N+1: store the key and endpoint through `PUT /api/admin/ai/config` and `PUT /api/admin/ai/providers/:provider/key` |
| `failed` | `provider_not_registered` (MemoriaHub registers `openai` and `anthropic` only), `empty_key`, `round_trip_mismatch`, `write_failed:<Error class>` | Re-enter the key through the platform route, or fix the cause and re-run |

The command logs one line per written provider (`ai:migrate-keys provider=... outcome=... last4=...`)
and exits **1** when any line is `undecryptable` or `failed` (**2** for a bad flag), **0** otherwise.
`--apply` refuses before writing anything when the `system_settings` `global` row does not exist
(start the API once first).

## 5. Verify

1. Run the command again with `--apply`: every line must read `skipped_existing` with reason
   `same_key_already_stored`, and the summary must show nothing imported (a re-run is a no-op).
2. `POST /api/admin/ai/providers/:provider/test` for each imported provider (the platform's own probe
   with the stored key; always 200, read `ok`).
3. `/admin/settings/ai` shows each provider configured with its `last4`; **Test** passes for the search
   and tagging models; **Test embedding** reports 1536 dimensions.
4. Tag one photo and run one agentic search. The API log no longer shows "served from the legacy
   ai_provider_credentials table" for the imported providers.
5. Doctor (`/admin/settings/doctor`): the `memoriahub.ai.*` checks are as before.

## 6. Re-running, and `--replace`

The default is set-if-absent: a provider whose platform key already exists is skipped, so the command
can be re-run at any time. `--replace` overwrites a platform key that **differs** from the legacy one
(an administrator stored a new key after the import, then the old one is wanted back); the report
warns. A platform key equal to the legacy one is never rewritten.

## 7. Rollback

- **Release N:** revert to the previous release. Nothing was destroyed: the legacy rows are untouched
  and the previous release reads only them. The platform credentials, slots and policy the import
  wrote are ignored by it (and harmless if left).
- **Release N+1:** the table is gone. Restore the backup taken in step 1 of section 3 and redeploy
  release N.
