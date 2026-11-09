// =============================================================================
// AI key import: the plan (RETRO-E3, #605) — release N of the two-release order
// =============================================================================
//
// PURE: no I/O, no clock, no key material in or out. It turns what the command
// (`ai-legacy-migrate.ts`) read about each `ai_provider_credentials` row and the
// platform store into one decision per provider:
//
//   imported              the key is written to the platform deployment store
//                         (`credentials`, purpose `ai`, name = provider) and the
//                         slot `ai.providers.<id>` gets `enabled` (+ `baseUrl`)
//   skipped_existing      the platform already holds a key for the provider: the
//                         same one (nothing to do), or a different one, kept
//                         unless `--replace`
//   undecryptable         SECRETS_ENCRYPTION_KEY cannot decrypt the legacy row;
//                         nothing is written for it, the other rows still run
//   unsupported_base_url  the row's `base_url` does not fit the provider's
//                         platform slot; the key is NOT imported (the legacy
//                         reader keeps serving it), so the operator decides
//   failed                anything else (an unregistered provider, an empty key,
//                         or, at apply time, a write or round-trip failure)
//
// The command exits non-zero when any provider ends `undecryptable` or `failed`.
//
// KEY POLICY. MemoriaHub's keys have always been deployment keys serving every
// user. On the platform that is `keyPolicy: 'byok_with_org_fallback'` with
// `deploymentKeyServesOrgs: true` (the platform offers no "deployment key only"
// policy; MemoriaHub stores no per-user keys, so BYOK never wins). The plan sets
// both when it imports at least one key and they are not already so; a stored
// `deploymentKeyServesOrgs: false` is an administrator's choice and is only
// reported.
// =============================================================================

export const AI_IMPORT_OUTCOMES = [
  'imported',
  'skipped_existing',
  'undecryptable',
  'unsupported_base_url',
  'failed',
] as const;
export type AiImportOutcome = (typeof AI_IMPORT_OUTCOMES)[number];

/** The platform key policy that expresses "the deployment key serves every user". */
export const DEPLOYMENT_KEY_POLICY = 'byok_with_org_fallback';

/** What the command learned about one legacy row. Holds no key material. */
export interface LegacyAiKeyFacts {
  rowId: string;
  provider: string;
  last4: string;
  baseUrl: string | null;
  enabled: boolean;
  updatedByUserId: string | null;
  /** `false` when the legacy cipher could not decrypt the row. */
  decrypted: boolean;
  /** `true` when it decrypted to an empty string. */
  empty: boolean;
  /** Whether the platform store already holds a key for the provider, and whether it is the same one. */
  existing: 'none' | 'same' | 'different';
}

export interface AiKeyPlanInput {
  rows: readonly LegacyAiKeyFacts[];
  /** The provider ids MemoriaHub registers with the platform AI slice. */
  registeredProviders: readonly string[];
  /** Why `baseUrl` does not fit the provider's slot, or `null` when it does. */
  baseUrlProblem: (provider: string, baseUrl: string) => string | null;
  /** `--replace`: overwrite a different platform key. */
  replace: boolean;
  /** Ids of the `updated_by_user_id` values that still name a user. */
  existingUserIds: ReadonlySet<string>;
  /** The INITIAL_ADMIN_EMAIL user, the actor when the row names nobody who still exists. */
  fallbackActorId: string | null;
  /** The stored `ai` namespace's policy fields (raw, may be absent). */
  storedPolicy: { keyPolicy?: unknown; deploymentKeyServesOrgs?: unknown };
  /** Providers whose `ai.providers.<id>` slot is stored in the row (not only defaulted on read). */
  storedSlots: ReadonlySet<string>;
}

export interface AiKeyPlanEntry {
  provider: string;
  rowId: string;
  last4: string;
  outcome: AiImportOutcome;
  /** A machine reason for every outcome but a plain `imported`. */
  reason: string | null;
  /** Write the key (an `imported` entry). */
  writeKey: boolean;
  /** Write the slot (with the key, or alone to finish an interrupted earlier run). */
  writeSlot: boolean;
  /** The platform key it overwrites (a `--replace` of a different key). */
  replacesExisting: boolean;
  /** The slot fields to write with the key. */
  slot: { enabled: boolean; baseUrl?: string } | null;
  /** Recorded as `updatedByUserId` and the audit actor. */
  actorUserId: string | null;
}

export interface AiKeyPlan {
  entries: AiKeyPlanEntry[];
  /** Fields of `ai` to set once at least one key was written. Empty when nothing changes. */
  policy: { keyPolicy?: typeof DEPLOYMENT_KEY_POLICY; deploymentKeyServesOrgs?: true };
  /** Things the operator should read, never key material. */
  notes: string[];
}

function entry(
  facts: LegacyAiKeyFacts,
  outcome: AiImportOutcome,
  reason: string | null,
  extra: Partial<AiKeyPlanEntry> = {},
): AiKeyPlanEntry {
  return {
    provider: facts.provider,
    rowId: facts.rowId,
    last4: facts.last4,
    outcome,
    reason,
    writeKey: false,
    writeSlot: false,
    replacesExisting: false,
    slot: null,
    actorUserId: null,
    ...extra,
  };
}

/** Decide, per legacy row, what the import does. */
export function planAiKeyImport(input: AiKeyPlanInput): AiKeyPlan {
  const entries: AiKeyPlanEntry[] = [];
  const notes: string[] = [];

  for (const facts of [...input.rows].sort((a, b) => a.provider.localeCompare(b.provider))) {
    if (!input.registeredProviders.includes(facts.provider)) {
      entries.push(entry(facts, 'failed', 'provider_not_registered'));
      continue;
    }
    if (!facts.decrypted) {
      entries.push(entry(facts, 'undecryptable', 'secrets_encryption_key_mismatch'));
      continue;
    }
    if (facts.empty) {
      entries.push(entry(facts, 'failed', 'empty_key'));
      continue;
    }
    const baseUrl = facts.baseUrl?.trim() ? facts.baseUrl.trim() : null;
    if (baseUrl) {
      const problem = input.baseUrlProblem(facts.provider, baseUrl);
      if (problem) {
        entries.push(entry(facts, 'unsupported_base_url', problem));
        continue;
      }
    }
    const actorUserId =
      facts.updatedByUserId && input.existingUserIds.has(facts.updatedByUserId)
        ? facts.updatedByUserId
        : input.fallbackActorId;
    const slot = { enabled: facts.enabled, ...(baseUrl ? { baseUrl } : {}) };
    if (facts.existing === 'same') {
      // The key is there; an earlier run that stopped between the key and the slot left the slot
      // at its read-time default (off). Finish it, once: a stored slot is never touched again.
      if (!input.storedSlots.has(facts.provider)) {
        entries.push(
          entry(facts, 'imported', 'key_present_slot_completed', { writeSlot: true, slot, actorUserId }),
        );
      } else {
        entries.push(entry(facts, 'skipped_existing', 'same_key_already_stored'));
      }
      continue;
    }
    if (facts.existing === 'different' && !input.replace) {
      entries.push(entry(facts, 'skipped_existing', 'different_key_kept_use_replace'));
      continue;
    }
    entries.push(
      entry(facts, 'imported', facts.existing === 'different' ? 'replaced_existing_key' : null, {
        writeKey: true,
        writeSlot: true,
        replacesExisting: facts.existing === 'different',
        slot,
        actorUserId,
      }),
    );
  }

  const policy: AiKeyPlan['policy'] = {};
  if (entries.some((e) => e.writeKey || e.writeSlot)) {
    if (input.storedPolicy.keyPolicy !== DEPLOYMENT_KEY_POLICY) policy.keyPolicy = DEPLOYMENT_KEY_POLICY;
    if (input.storedPolicy.deploymentKeyServesOrgs === undefined) policy.deploymentKeyServesOrgs = true;
  }
  if (input.storedPolicy.deploymentKeyServesOrgs === false) {
    notes.push(
      'ai.deploymentKeyServesOrgs is false: calls made in an organization will not use the imported ' +
        'deployment keys (left as stored; an administrator set it).',
    );
  }
  if (entries.some((e) => e.outcome === 'unsupported_base_url')) {
    notes.push(
      'ACTION REQUIRED before the release that drops ai_provider_credentials: a provider with ' +
        'unsupported_base_url was not imported and is still served from the legacy row. Re-enter its ' +
        'key and endpoint in the platform admin AI settings (PUT /api/admin/ai/providers/:provider/key).',
    );
  }
  if (entries.some((e) => e.replacesExisting)) {
    notes.push('WARNING: --replace overwrites a platform key that differs from the legacy one.');
  }
  return { entries, policy, notes };
}

/** True when the run must exit non-zero. */
export function planHasErrors(entries: readonly Pick<AiKeyPlanEntry, 'outcome'>[]): boolean {
  return entries.some((e) => e.outcome === 'undecryptable' || e.outcome === 'failed');
}

/** One line per provider plus a summary. Provider, outcome, last4 and a reason; never a key. */
export function formatAiKeyReport(
  entries: readonly AiKeyPlanEntry[],
  policy: AiKeyPlan['policy'],
  notes: readonly string[],
  mode: 'dry-run' | 'apply',
): string[] {
  const verb = mode === 'apply' ? '' : ' (dry run)';
  const lines = entries.map(
    (e) =>
      `  provider=${e.provider} outcome=${e.outcome}${verb} last4=${e.last4}` +
      (e.slot ? ` enabled=${e.slot.enabled}${e.slot.baseUrl !== undefined ? ' baseUrl=set' : ''}` : '') +
      (e.reason ? ` reason=${e.reason}` : ''),
  );
  if (entries.length === 0) lines.push('  ai_provider_credentials holds no rows: nothing to import.');
  const policyParts = Object.entries(policy).map(([k, v]) => `${k}=${String(v)}`);
  if (policyParts.length > 0) lines.push(`  ai policy${verb}: ${policyParts.join(', ')}`);
  const count = (o: AiImportOutcome) => entries.filter((e) => e.outcome === o).length;
  lines.push(
    `  summary: ${AI_IMPORT_OUTCOMES.map((o) => `${o} ${count(o)}`).join(', ')}`,
  );
  for (const note of notes) lines.push(`  ${note}`);
  return lines;
}
