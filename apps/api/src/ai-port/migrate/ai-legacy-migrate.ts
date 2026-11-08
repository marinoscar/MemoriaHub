// Declares the credential purposes (`ai` among them) `CredentialsService.setSecret` checks. First.
import '../../platform/credentials/credential-purposes.manifest';

import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import { parseArgs } from 'node:util';

import {
  AI_CREDENTIAL_PURPOSE,
  aiCredentialLabel,
  aiCredentialName,
  getAiProviderDefinition,
} from '@marinoscar/platform-api/ai';
import { CredentialsService } from '@marinoscar/platform-api/credentials';

import { PrismaService } from '../../prisma/prisma.service';
import { MEMORIAHUB_AI_PROVIDER_IDS } from '../../platform/ai/ai-providers';
import { decryptLegacyAiKey } from './legacy-cipher';
import {
  formatAiKeyReport,
  planAiKeyImport,
  planHasErrors,
  type AiKeyPlan,
  type AiKeyPlanEntry,
  type LegacyAiKeyFacts,
} from './ai-legacy-plan';

// =============================================================================
// AI key import: ai_provider_credentials -> platform deployment keys
// (RETRO-E3, #605) — RELEASE N of the two-release order
// =============================================================================
//
// An OPERATOR COMMAND, run once per deployment after upgrading to release N:
//
//     npm run ai:migrate-keys --workspace=api -- [--dry-run] [--apply] [--replace]
//     (in the image: node dist/ai-port/migrate/ai-legacy-migrate.js ...)
//
// For each `ai_provider_credentials` row: decrypt with the read-only legacy
// cipher, write the key to the platform credential store at
// (`ai`, `<provider>`) — the deployment tier `AiKeyResolver` and
// `AiConfigService.getOrgKey` read — read it back (round trip), set
// `ai.providers.<id>.enabled` (and `baseUrl`) and write the audit row
// `ai_config:set_key`. See `ai-legacy-plan.ts` for every decision.
//
// WHY NOT `AiConfigAdminService.setKey`. It VERIFIES the key with a live
// provider call first and needs the application graph. A carry-over must not
// depend on the provider answering, and must reproduce the stored key exactly,
// so it writes through `CredentialsService.setSecret` (the issue's documented
// fallback) with the same label and audit action `setKey` uses.
//
// SAFETY
//   - Dry run is the default and writes nothing.
//   - Set-if-absent: a provider that already has a platform key is skipped
//     (`--replace` overwrites a DIFFERENT one, with a warning). Re-running
//     `--apply` changes nothing.
//   - `ai_provider_credentials` is only READ. Release N+1 drops it; until then
//     the legacy reader (`AiDeploymentKeySource`) falls back to it for any
//     provider the platform store lacks, so reverting release N loses nothing.
//   - One bad row (undecryptable, unsupported endpoint) never stops the others.
//   - No key is ever printed, logged, put in argv or env: the report carries
//     provider, outcome and last4 only. Exit 1 on `undecryptable`/`failed`.
//   - Not a queue job: no HTTP request or cron starts it (as in kvox).
// Runbook: docs/runbooks/ai-platform-migration.md.
// =============================================================================

/** The `system_settings` row the `ai` namespace lives in. */
export const SYSTEM_SETTINGS_ROW_KEY = 'global';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Why `baseUrl` cannot go into the provider's platform slot, or `null`. */
export function baseUrlProblem(provider: string, baseUrl: string): string | null {
  const def = getAiProviderDefinition(provider);
  if (!def) return 'provider_not_registered';
  if (!('baseUrl' in def.settingsSchema.shape)) return 'provider_slot_has_no_base_url';
  // The slot's own schema decides (an http Azure endpoint, credentials in a URL, ...).
  return def.settingsSchema.partial().safeParse({ baseUrl }).success ? null : 'base_url_rejected_by_provider_slot';
}

export interface AiKeyImportDeps {
  prisma: PrismaService;
  credentials: CredentialsService;
  log?: (line: string) => void;
}

export interface AiKeyImportOptions {
  apply: boolean;
  replace: boolean;
}

export interface AiKeyImportResult {
  entries: AiKeyPlanEntry[];
  policy: AiKeyPlan['policy'];
  notes: string[];
  lines: string[];
  exitCode: number;
}

async function readAiNamespace(prisma: PrismaService): Promise<Record<string, unknown>> {
  const row = await prisma.systemSettings.findUnique({ where: { key: SYSTEM_SETTINGS_ROW_KEY } });
  const value = isRecord(row?.value) ? row!.value : {};
  return isRecord(value['ai']) ? (value['ai'] as Record<string, unknown>) : {};
}

/**
 * Mutates the stored `ai` namespace of the `global` row under a row lock. The
 * platform's `ai` read salvages every field it is not given, so writing one
 * slot or one policy field leaves the rest of the namespace (and MemoriaHub's
 * `features`) exactly as stored.
 */
async function updateAiNamespace(
  prisma: PrismaService,
  mutate: (ai: Record<string, unknown>) => void,
  actorUserId: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ value: unknown }>>`
      SELECT value FROM system_settings WHERE key = ${SYSTEM_SETTINGS_ROW_KEY} FOR UPDATE`;
    if (rows.length === 0) {
      throw new Error('The system_settings "global" row does not exist yet; start the API once, then re-run.');
    }
    const doc: Record<string, unknown> = isRecord(rows[0]!.value) ? structuredClone(rows[0]!.value) : {};
    const ai: Record<string, unknown> = isRecord(doc['ai']) ? (doc['ai'] as Record<string, unknown>) : {};
    mutate(ai);
    doc['ai'] = ai;
    await tx.$executeRaw`
      UPDATE system_settings
         SET value = ${JSON.stringify(doc)}::jsonb, version = version + 1, updated_at = now(),
             updated_by_user_id = ${actorUserId}::uuid
       WHERE key = ${SYSTEM_SETTINGS_ROW_KEY}`;
  });
}

/** Runs the import. `apply: false` writes nothing. Never returns or logs key material. */
export async function runAiKeyImport(deps: AiKeyImportDeps, opts: AiKeyImportOptions): Promise<AiKeyImportResult> {
  const { prisma, credentials } = deps;
  const log = deps.log ?? (() => undefined);

  const rows = await prisma.aiProviderCredential.findMany({ orderBy: { provider: 'asc' } });

  // Plaintext lives only in this map, only for this call.
  const plaintexts = new Map<string, string>();
  const facts: LegacyAiKeyFacts[] = [];
  for (const row of rows) {
    let decrypted = false;
    let plaintext = '';
    try {
      plaintext = decryptLegacyAiKey(row.encryptedKey);
      decrypted = true;
    } catch {
      // A failed GCM check carries nothing useful and must not be echoed.
    }
    let existing: LegacyAiKeyFacts['existing'] = 'none';
    const stored = await credentials.getSecret(AI_CREDENTIAL_PURPOSE, aiCredentialName(row.provider));
    if (stored !== null) existing = decrypted && stored === plaintext ? 'same' : 'different';
    if (decrypted && plaintext !== '') plaintexts.set(row.provider, plaintext);
    facts.push({
      rowId: row.id,
      provider: row.provider,
      last4: row.last4,
      baseUrl: row.baseUrl,
      enabled: row.enabled,
      updatedByUserId: row.updatedByUserId,
      decrypted,
      empty: decrypted && plaintext === '',
      existing,
    });
  }

  const userIds = [...new Set(rows.map((r) => r.updatedByUserId).filter((id): id is string => !!id))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true } })
    : [];
  const adminEmail = process.env['INITIAL_ADMIN_EMAIL']?.trim().toLowerCase();
  const admin = adminEmail
    ? await prisma.user.findFirst({ where: { email: { equals: adminEmail, mode: 'insensitive' } }, select: { id: true } })
    : null;
  const ai = await readAiNamespace(prisma);

  const plan = planAiKeyImport({
    rows: facts,
    registeredProviders: MEMORIAHUB_AI_PROVIDER_IDS,
    baseUrlProblem,
    replace: opts.replace,
    existingUserIds: new Set(users.map((u) => u.id)),
    fallbackActorId: admin?.id ?? null,
    storedPolicy: { keyPolicy: ai['keyPolicy'], deploymentKeyServesOrgs: ai['deploymentKeyServesOrgs'] },
  });

  const entries = plan.entries.map((e) => ({ ...e }));
  let policyWritten: AiKeyPlan['policy'] = opts.apply ? {} : plan.policy;

  if (opts.apply) {
    for (const e of entries) {
      if (!e.writeKey) continue;
      const plaintext = plaintexts.get(e.provider);
      if (!plaintext) {
        Object.assign(e, { outcome: 'failed', reason: 'key_unavailable', writeKey: false });
        continue;
      }
      try {
        const label = aiCredentialLabel(getAiProviderDefinition(e.provider)?.label ?? e.provider);
        await credentials.setSecret(AI_CREDENTIAL_PURPOSE, aiCredentialName(e.provider), plaintext, {
          label,
          updatedByUserId: e.actorUserId,
        });
        const back = await credentials.getSecret(AI_CREDENTIAL_PURPOSE, aiCredentialName(e.provider));
        if (back !== plaintext) {
          Object.assign(e, { outcome: 'failed', reason: 'round_trip_mismatch', writeKey: false });
          continue;
        }
        const slot = e.slot!;
        await updateAiNamespace(
          prisma,
          (value) => {
            const providers = isRecord(value['providers']) ? (value['providers'] as Record<string, unknown>) : {};
            const current = isRecord(providers[e.provider]) ? (providers[e.provider] as Record<string, unknown>) : {};
            providers[e.provider] = { ...current, ...slot };
            value['providers'] = providers;
          },
          e.actorUserId,
        );
        await prisma.auditEvent.create({
          data: {
            actorUserId: e.actorUserId,
            action: 'ai_config:set_key',
            targetType: 'ai_config',
            targetId: e.provider,
            meta: { provider: e.provider, source: 'legacy_import', replaced: e.replacesExisting },
          },
        });
        log(`ai:migrate-keys provider=${e.provider} outcome=${e.outcome} last4=${e.last4}`);
      } catch (err) {
        // The error class only: a driver message could echo a parameter.
        Object.assign(e, {
          outcome: 'failed',
          reason: `write_failed:${err instanceof Error ? err.constructor.name : 'unknown'}`,
          writeKey: false,
        });
      }
    }

    if (entries.some((e) => e.outcome === 'imported') && Object.keys(plan.policy).length > 0) {
      const actor = entries.find((e) => e.outcome === 'imported')?.actorUserId ?? null;
      await updateAiNamespace(prisma, (value) => Object.assign(value, plan.policy), actor);
      await prisma.auditEvent.create({
        data: {
          actorUserId: actor,
          action: 'ai_config:update',
          targetType: 'ai_config',
          targetId: 'ai',
          meta: { source: 'legacy_import', changedFields: Object.keys(plan.policy) },
        },
      });
      policyWritten = plan.policy;
    }
  }

  plaintexts.clear();
  const lines = formatAiKeyReport(entries, policyWritten, plan.notes, opts.apply ? 'apply' : 'dry-run');
  return { entries, policy: policyWritten, notes: plan.notes, lines, exitCode: planHasErrors(entries) ? 1 : 0 };
}

export const USAGE = `Usage: npm run ai:migrate-keys --workspace=api -- [--dry-run | --apply] [--replace]

Copies every ai_provider_credentials key into the platform deployment AI key store
(purpose "ai"), sets ai.providers.<id>.enabled (and baseUrl), and makes the
deployment keys serve every user (ai.keyPolicy byok_with_org_fallback).

  --dry-run   (default) report what would happen; write nothing
  --apply     write the keys (set-if-absent), verify each by reading it back
  --replace   overwrite a platform key that differs from the legacy one (warns)

Needs SECRETS_ENCRYPTION_KEY (the key that encrypted the legacy rows) and the
API's database settings. Prints provider, outcome and last4 only. Exit 1 when a
row is undecryptable or failed. ai_provider_credentials is never modified.
See docs/runbooks/ai-platform-migration.md.
`;

export function parseCli(argv: string[]): { apply: boolean; replace: boolean; help: boolean } {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      replace: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.apply && values['dry-run']) throw new Error('--apply and --dry-run are mutually exclusive.');
  return { apply: values.apply === true, replace: values.replace === true, help: values.help === true };
}

/** The entry point. Returns the process exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ReturnType<typeof parseCli>;
  try {
    args = parseCli(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // A checkout's .env files, when present; a container already has its environment.
  loadDotenv({ path: resolve(__dirname, '..', '..', '..', '.env'), quiet: true });
  loadDotenv({ path: resolve(__dirname, '..', '..', '..', '..', '..', 'infra', 'compose', '.env'), quiet: true });

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    // PrismaService is the app's Prisma client; the store only needs its `credential` delegate.
    const credentials = new CredentialsService(prisma as never);
    const result = await runAiKeyImport(
      { prisma, credentials, log: (line) => process.stdout.write(`${line}\n`) },
      { apply: args.apply, replace: args.replace },
    );
    process.stdout.write(`${args.apply ? 'APPLY' : 'DRY RUN'}: ai_provider_credentials -> platform AI keys\n`);
    for (const line of result.lines) process.stdout.write(`${line}\n`);
    if (!args.apply) process.stdout.write('Dry run only. Re-run with --apply to write.\n');
    return result.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
