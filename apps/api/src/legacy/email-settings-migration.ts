// =============================================================================
// Email settings migration (RETRO-D2, #570)
// =============================================================================
//
// Moves MemoriaHub's pre-platform email configuration onto the platform email
// slice, so an existing deployment keeps sending with NO admin re-entry:
//
//   legacy (global row, `email.*`)              platform
//   ------------------------------------------  --------------------------------------------
//   provider, enabled, fromAddress, fromName    `email` row: same keys
//   smtpHost, smtpPort, smtpUseTls, smtpUsername `email` row: transports.smtp { host, port, useTls, username }
//   sesRegion (else the S3 credential's region) `email` row: transports.ses.region
//   storage_provider_credentials/s3 access key  `email` row: transports.ses.accessKeyId
//   email.smtpPassword (legacy cipher)          credential smtp/default       (legacy migration, purpose smtp)
//   storage_provider_credentials/s3 secret      credential email_ses/default  (legacy migration, purpose ses)
//
// SES (Open decision 1 of #570): the app's SES used to read the S3 storage key
// pair at send time. The platform SES transport has its own key pair, so the
// S3 pair is COPIED once; from then on the two are independent and the runbook
// says to rotate both together. The copy happens only when a key id exists.
//
// RULES (each is tested):
//   - Dry run by default; `apply` is explicit.
//   - SET-IF-ABSENT, key by key (and field by field inside `transports.<id>`):
//     a value an admin already saved on the platform page is never overwritten,
//     so a second run is a no-op (idempotent).
//   - Null legacy values are dropped, never written (the platform schema has
//     optional, not nullable, fields).
//   - The target row is validated with the platform `emailSettingsSchema`
//     before it is written; an invalid legacy value (a malformed from address)
//     is reported and left out rather than written.
//   - The legacy keys are left untouched, so reverting the release restores
//     the old readers. A later release removes `email.*` from the app namespace.
//   - No secret ever leaves this module: only key names and counts.
// =============================================================================

import { emailSettingsSchema } from '@marinoscar/platform-api/email';

/** The legacy `email.*` block as stored in the `global` row (every field nullable). */
export interface LegacyEmailBlock {
  provider?: string | null;
  enabled?: boolean | null;
  sesRegion?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUseTls?: boolean | null;
  smtpUsername?: string | null;
  fromAddress?: string | null;
  fromName?: string | null;
}

/** The non-secret half of the S3 storage credential the legacy SES path reused. */
export interface LegacyS3Credential {
  accessKeyId: string | null;
  region: string | null;
}

/** The platform `email` row, as JSON. */
export type EmailRowValue = Record<string, unknown>;

/** Reads and writes the platform `email` row. */
export interface EmailRowStore {
  /** The stored value, or `null` when the row does not exist. */
  read(): Promise<EmailRowValue | null>;
  /** Insert or replace the row value (bumping its version). */
  write(value: EmailRowValue): Promise<void>;
}

export interface EmailSettingsPlan {
  /** Whether the legacy block exists at all. */
  legacyPresent: boolean;
  /** The platform row the legacy block maps to (no secrets, nulls dropped). */
  target: EmailRowValue;
  /** The row after a set-if-absent merge over what is stored. */
  merged: EmailRowValue;
  /** Dotted paths the merge would add (`provider`, `transports.smtp.host`, ...). */
  written: string[];
  /** Legacy fields left out because the platform schema refuses them. */
  rejected: string[];
  /** Whether the row exists already. */
  rowExists: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const present = <T>(v: T | null | undefined): v is T =>
  v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '');

/** Map the legacy block (plus the S3 key id and region) to the platform row. Pure. */
export function legacyToPlatformEmail(
  legacy: LegacyEmailBlock | null | undefined,
  s3: LegacyS3Credential | null,
): EmailRowValue {
  const l = legacy ?? {};
  const target: EmailRowValue = {};

  if (l.provider === 'ses' || l.provider === 'smtp') target.provider = l.provider;
  if (typeof l.enabled === 'boolean') target.enabled = l.enabled;
  if (present(l.fromAddress)) target.fromAddress = l.fromAddress.trim();
  if (present(l.fromName)) target.fromName = l.fromName.trim();

  const smtp: Record<string, unknown> = {};
  if (present(l.smtpHost)) smtp.host = l.smtpHost.trim();
  if (typeof l.smtpPort === 'number') smtp.port = l.smtpPort;
  if (typeof l.smtpUseTls === 'boolean') smtp.useTls = l.smtpUseTls;
  if (present(l.smtpUsername)) smtp.username = l.smtpUsername.trim();

  const ses: Record<string, unknown> = {};
  const region = present(l.sesRegion) ? l.sesRegion.trim() : present(s3?.region) ? s3!.region!.trim() : null;
  if (region) ses.region = region;
  if (present(s3?.accessKeyId)) ses.accessKeyId = s3!.accessKeyId!.trim();

  const transports: Record<string, unknown> = {};
  if (Object.keys(smtp).length > 0) transports.smtp = smtp;
  if (Object.keys(ses).length > 0) transports.ses = ses;
  if (Object.keys(transports).length > 0) target.transports = transports;

  // A block holding nothing but the switched-off default carries no configuration:
  // writing it would only create an empty platform row.
  if (Object.keys(target).every((k) => k === 'enabled') && target.enabled !== true) return {};

  return target;
}

/**
 * Drop the target's fields the platform schema refuses, one at a time, so one
 * malformed legacy value (say an invalid from address) never blocks the rest.
 */
export function dropRejectedFields(target: EmailRowValue): { value: EmailRowValue; rejected: string[] } {
  const value: EmailRowValue = JSON.parse(JSON.stringify(target));
  const rejected: string[] = [];
  // The schema needs `provider` and `enabled` to judge the rest; supply the defaults for the check only.
  const probe = () => emailSettingsSchema.safeParse({ provider: null, enabled: false, ...value });
  let result = probe();
  for (let guard = 0; !result.success && guard < 20; guard++) {
    const path = result.error.issues[0]?.path ?? [];
    if (path.length === 0) break;
    let node: Record<string, unknown> | undefined = value;
    for (const key of path.slice(0, -1)) node = isRecord(node?.[key as string]) ? (node![key as string] as Record<string, unknown>) : undefined;
    if (!node) break;
    delete node[path[path.length - 1] as string];
    rejected.push(path.map(String).join('.'));
    result = probe();
  }
  return { value, rejected };
}

/** Set-if-absent merge of `target` over `stored`, recursing into `transports.<id>`. */
export function mergeIfAbsent(
  stored: EmailRowValue | null,
  target: EmailRowValue,
): { value: EmailRowValue; written: string[] } {
  const value: EmailRowValue = stored ? JSON.parse(JSON.stringify(stored)) : {};
  const written: string[] = [];

  for (const [key, v] of Object.entries(target)) {
    if (key === 'transports') continue;
    if (value[key] === undefined) {
      value[key] = v;
      written.push(key);
    }
  }

  const targetTransports = isRecord(target.transports) ? target.transports : {};
  if (Object.keys(targetTransports).length > 0) {
    const transports = isRecord(value.transports) ? value.transports : {};
    for (const [id, settings] of Object.entries(targetTransports)) {
      if (!isRecord(settings)) continue;
      const storedSettings = isRecord(transports[id]) ? (transports[id] as Record<string, unknown>) : {};
      for (const [field, v] of Object.entries(settings)) {
        if (storedSettings[field] === undefined) {
          storedSettings[field] = v;
          written.push(`transports.${id}.${field}`);
        }
      }
      transports[id] = storedSettings;
    }
    value.transports = transports;
  }

  return { value, written };
}

/** Build the plan. Writes nothing. */
export async function buildEmailSettingsPlan(
  legacy: LegacyEmailBlock | null | undefined,
  s3: LegacyS3Credential | null,
  row: EmailRowStore,
): Promise<EmailSettingsPlan> {
  const { value: target, rejected } = dropRejectedFields(legacyToPlatformEmail(legacy, s3));
  const stored = await row.read();
  const { value: merged, written } = mergeIfAbsent(stored, target);
  return {
    legacyPresent: isRecord(legacy),
    target,
    merged,
    written,
    rejected,
    rowExists: stored !== null,
  };
}

/** Apply the plan: write the merged row when the merge adds anything. Returns the paths written. */
export async function applyEmailSettingsPlan(plan: EmailSettingsPlan, row: EmailRowStore): Promise<string[]> {
  if (plan.written.length === 0) return [];
  const parsed = emailSettingsSchema.safeParse({ provider: null, enabled: false, ...plan.merged });
  if (!parsed.success) {
    throw new Error(
      `Refusing to write the email row: ${parsed.error.issues.map((i: { path: PropertyKey[] }) => i.path.map(String).join('.') || '(root)').join(', ')} invalid.`,
    );
  }
  // `provider` and `enabled` are required by the platform row; a legacy block
  // without them is written as "no transport, switched off".
  await row.write({ provider: null, enabled: false, ...plan.merged });
  return plan.written;
}

/** The dry-run report: key paths only, never a value that could be sensitive. */
export function formatEmailSettingsPlan(plan: EmailSettingsPlan): string[] {
  const lines: string[] = [];
  if (!plan.legacyPresent) lines.push('  [settings] no legacy email.* block in the global row; nothing to carry over');
  lines.push(`  [settings] platform email row ${plan.rowExists ? 'exists' : 'absent'}`);
  lines.push(
    plan.written.length > 0
      ? `  [settings] would set: ${plan.written.join(', ')}`
      : '  [settings] nothing to set (already present or nothing to carry over)',
  );
  if (plan.rejected.length > 0) lines.push(`  [settings] left out (refused by the platform schema): ${plan.rejected.join(', ')}`);
  return lines;
}
