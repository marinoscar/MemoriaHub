// =============================================================================
// Legacy credential migration (RETRO-B4, #617)
// =============================================================================
//
// Moves secrets encrypted by the LEGACY cipher (`legacy-secret-cipher.ts`, one master key, no
// purpose binding) into the platform credential store (`credentials`, per-purpose sub-key).
// The formats differ, so a row is DECRYPTED with the legacy cipher and RE-ENCRYPTED by
// `CredentialsService.setSecret`. The CLI in `scripts/migrate-legacy-credentials.ts` wires this to
// Postgres; everything here takes its collaborators as arguments so it is unit-tested with fixtures.
//
// RULES (each is tested):
//   - Dry run by default. `apply` is explicit.
//   - A secret is never logged, returned or put in a plan: only `deriveHint` (last four characters,
//     or `••••` for a short secret) leaves this module, plus counts and row ids.
//   - Nothing is written unless EVERY row of the requested purposes decrypts. One undecryptable row
//     (wrong `SECRETS_ENCRYPTION_KEY`, tampering) refuses the whole run and names the row id.
//   - Idempotent: a target whose stored secret already equals the legacy plaintext is left alone.
//   - After a write the secret is read back through `getSecret` and compared (round trip). A
//     mismatch fails the run.
//   - The legacy rows are never modified or deleted, so reverting the release restores the old readers.
//   - The non-secret half (baseUrl, enabled) goes to the settings document with SET-IF-ABSENT: a value
//     an admin already saved after cut-over is never overwritten.
//   - `face`, `geo` (RETRO-B4) and `smtp`, `ses` (RETRO-D2, applied by `scripts/migrate-email-settings.ts`)
//     can be applied. `storage` and `push_vapid` have plans (dry run) so RETRO-D1/D3 reuse them; their
//     apply is refused until that slice switches its reader.
// =============================================================================

import { deriveHint } from '@marinoscar/platform-api/credentials';

export const MIGRATION_PURPOSES = ['face', 'geo', 'storage', 'smtp', 'ses', 'push_vapid'] as const;
export type MigrationPurpose = (typeof MIGRATION_PURPOSES)[number];

/** Purposes whose reader already uses the credential store, so `--apply` is allowed. */
export const APPLICABLE_PURPOSES: readonly MigrationPurpose[] = ['face', 'geo', 'smtp', 'ses'];

/** One legacy secret and where it goes. */
export interface LegacyItem {
  purpose: MigrationPurpose;
  /** The legacy row id (or the settings key), for messages. Never a secret. */
  rowId: string;
  /** Human label, e.g. `face_provider_credentials/compreface`. */
  label: string;
  /** The legacy-cipher ciphertext; `null`/`''` means the row holds no secret. */
  ciphertext: string | null;
  /** Credential address; `null` when the row has no target (see `note`). */
  target: { purpose: string; name: string } | null;
  note?: string;
  /** The non-secret half, written to the settings document with set-if-absent. */
  settings?: { path: string[]; value: Record<string, unknown> };
}

export interface LegacySource {
  load(purpose: MigrationPurpose): Promise<LegacyItem[]>;
}

export interface CredentialStore {
  getSecret(purpose: string, name: string): Promise<string | null>;
  setSecret(
    purpose: string,
    name: string,
    secret: string | null | undefined,
    meta?: { label?: string | null; updatedByUserId?: string | null },
  ): Promise<void>;
}

export interface SettingsStore {
  /** The value at `path` in the `global` settings document, or `undefined`. */
  get(path: string[]): Promise<unknown>;
  /** Set `value` at `path`, merging key by key without overwriting existing keys. Returns the keys written. */
  setIfAbsent(path: string[], value: Record<string, unknown>): Promise<string[]>;
}

export type ItemStatus = 'write' | 'unchanged' | 'no-secret' | 'skipped' | 'undecryptable';

export interface PlanEntry {
  item: LegacyItem;
  status: ItemStatus;
  /** `deriveHint` of the plaintext; never the plaintext. */
  hint: string | null;
  /** Keys of the non-secret half that would be written. */
  settingsKeys: string[];
}

export interface Plan {
  purposes: MigrationPurpose[];
  entries: PlanEntry[];
  /** Rows the key cannot decrypt, as `label (id)`. */
  undecryptable: string[];
}

export type Decrypt = (ciphertext: string) => string;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Build the plan: read the legacy rows, decrypt in memory, compare with what is stored. Writes nothing.
 * With `onlyIfAbsent`, a target that already holds ANY secret is left alone (set-if-absent).
 */
export async function buildPlan(
  purposes: readonly MigrationPurpose[],
  source: LegacySource,
  credentials: CredentialStore,
  settings: SettingsStore,
  decrypt: Decrypt,
  options: { onlyIfAbsent?: boolean } = {},
): Promise<Plan> {
  const entries: PlanEntry[] = [];
  const undecryptable: string[] = [];

  for (const purpose of purposes) {
    for (const item of await source.load(purpose)) {
      const settingsKeys = item.settings ? await missingKeys(settings, item.settings) : [];

      if (!item.target) {
        entries.push({ item, status: 'skipped', hint: null, settingsKeys });
        continue;
      }
      if (!item.ciphertext) {
        entries.push({ item, status: 'no-secret', hint: null, settingsKeys });
        continue;
      }

      let plaintext: string;
      try {
        plaintext = decrypt(item.ciphertext);
      } catch {
        // The message of a failed GCM check carries nothing useful and must not be echoed.
        undecryptable.push(`${item.label} (${item.rowId})`);
        entries.push({ item, status: 'undecryptable', hint: null, settingsKeys });
        continue;
      }
      if (plaintext === '') {
        entries.push({ item, status: 'no-secret', hint: null, settingsKeys });
        continue;
      }

      const stored = await credentials.getSecret(item.target.purpose, item.target.name);
      entries.push({
        item,
        // `onlyIfAbsent` (the email carry-over, RETRO-D2): a secret an admin already stored
        // after cut-over is kept, never replaced by the legacy one.
        status: stored === plaintext || (options.onlyIfAbsent && stored !== null) ? 'unchanged' : 'write',
        hint: deriveHint(plaintext),
        settingsKeys,
      });
    }
  }

  return { purposes: [...purposes], entries, undecryptable };
}

async function missingKeys(
  settings: SettingsStore,
  target: NonNullable<LegacyItem['settings']>,
): Promise<string[]> {
  const existing = await settings.get(target.path);
  const present = isPlainObject(existing) ? existing : {};
  return Object.keys(target.value).filter((key) => present[key] === undefined);
}

export interface ApplyResult {
  written: number;
  unchanged: number;
  noSecret: number;
  skipped: number;
  settingsWritten: number;
}

/**
 * Apply a plan. Refuses (throws) when any row is undecryptable or a purpose is not applicable yet;
 * a failed round trip also throws. `decrypt` is called again here so no plaintext lives in the plan.
 */
export async function applyPlan(
  plan: Plan,
  credentials: CredentialStore,
  settings: SettingsStore,
  decrypt: Decrypt,
  log: (line: string) => void = () => undefined,
): Promise<ApplyResult> {
  const blocked = plan.purposes.filter((p) => !APPLICABLE_PURPOSES.includes(p));
  if (blocked.length > 0) {
    throw new Error(
      `Refusing to apply: ${blocked.join(', ')} not applicable yet (its reader still uses the legacy store; ` +
        'RETRO-D1 storage, RETRO-D3 push_vapid run their own migration).',
    );
  }
  if (plan.undecryptable.length > 0) {
    throw new Error(
      `Refusing to apply: SECRETS_ENCRYPTION_KEY cannot decrypt ${plan.undecryptable.join(', ')}. Nothing was written.`,
    );
  }

  const result: ApplyResult = { written: 0, unchanged: 0, noSecret: 0, skipped: 0, settingsWritten: 0 };

  for (const entry of plan.entries) {
    const { item, status } = entry;
    if (status === 'write' && item.target && item.ciphertext) {
      const plaintext = decrypt(item.ciphertext);
      await credentials.setSecret(item.target.purpose, item.target.name, plaintext);
      const back = await credentials.getSecret(item.target.purpose, item.target.name);
      if (back !== plaintext) {
        throw new Error(
          `Round trip failed for ${item.target.purpose}/${item.target.name} (legacy row ${item.rowId}). ` +
            'The stored secret does not equal the legacy one.',
        );
      }
      log(`wrote ${item.target.purpose}/${item.target.name} hint=${entry.hint} (legacy row ${item.rowId})`);
      result.written++;
    } else if (status === 'unchanged') {
      log(`unchanged ${item.target?.purpose}/${item.target?.name} hint=${entry.hint} (legacy row ${item.rowId})`);
      result.unchanged++;
    } else if (status === 'no-secret') {
      result.noSecret++;
    } else {
      result.skipped++;
    }

    if (item.settings && entry.settingsKeys.length > 0) {
      const written = await settings.setIfAbsent(item.settings.path, item.settings.value);
      if (written.length > 0) {
        log(`settings ${item.settings.path.join('.')} set: ${written.join(', ')} (legacy row ${item.rowId})`);
        result.settingsWritten += written.length;
      }
    }
  }
  return result;
}

/** The dry-run report: counts and hints only. */
export function formatPlan(plan: Plan): string[] {
  const lines: string[] = [];
  for (const { item, status, hint, settingsKeys } of plan.entries) {
    const target = item.target ? `${item.target.purpose}/${item.target.name}` : '(no target)';
    const verb =
      status === 'write'
        ? 'would write'
        : status === 'unchanged'
          ? 'already present'
          : status === 'no-secret'
            ? 'no secret'
            : status === 'undecryptable'
              ? 'CANNOT DECRYPT'
              : 'skipped';
    const extra = [
      hint ? `hint=${hint}` : null,
      settingsKeys.length > 0 ? `settings+=${settingsKeys.join(',')}` : null,
      item.note ?? null,
    ].filter(Boolean);
    lines.push(`  [${item.purpose}] ${item.label} (${item.rowId}) -> ${target}: ${verb}${extra.length ? ` (${extra.join('; ')})` : ''}`);
  }
  const count = (s: ItemStatus) => plan.entries.filter((e) => e.status === s).length;
  lines.push(
    `would write ${count('write')}, already present ${count('unchanged')}, no secret ${count('no-secret')}, ` +
      `skipped ${count('skipped')}, undecryptable ${count('undecryptable')}`,
  );
  return lines;
}
