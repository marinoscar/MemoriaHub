// =============================================================================
// Import `media_shares` as platform link grants (RETRO-I4, #578)
// =============================================================================
//
// Every public share becomes a link grant through the sharing slice's
// `importLegacyToken`: `grantee_kind = 'link'`, `role = 'viewer'`, the target as
// `resource_type` / `resource_id` (`media_item` or `album`), `expires_at`,
// `revoked_at`, `created_at` kept, `created_by_id` as `granted_by_id`, the
// organization of the shared record. The token is stored as `lnk_<old token>`
// (SHA-256 hash + ciphertext under SECRETS_ENCRYPTION_KEY), so an old URL
// `/s/<token>` keeps opening through the web redirect to `/s#lnk_<token>`.
// Revoked and expired shares are imported too, with their timestamps (they stay
// "not available", and the history is not lost).
//
// IDEMPOTENT: a share whose `lnk_` token hash already has a grant is skipped, so
// a re-run imports nothing twice. The `share_expiring` notification stamps
// (`data.shareId` of `shares.expiring` rows) are re-keyed from the share id to
// the grant id, so an expiry warned about before the cutover is not warned about
// again (re-runnable as well).
//
// `media_shares` is read with raw SQL: the Prisma model is gone, and the table
// itself is dropped by migration 20261109100000_i4_media_shares_to_link_grants
// AFTER this import (the migration refuses to run while a row is not imported).
//
// Runs inside ONE system transaction (`runAsSystem('migration-tooling', ...)`,
// scripts/import-media-shares.ts): every share imports, or none does.
// =============================================================================

import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

/** The event key of the `share_expiring` notification (MEMORIAHUB_EVENT_KEYS.shareExpiring). */
export const SHARE_EXPIRING_EVENT_KEY = 'shares.expiring';

/** One `media_shares` row, with the organization of its target. */
export interface LegacyShareRow {
  id: string;
  token: string;
  targetType: 'media_item' | 'album';
  resourceId: string | null;
  orgId: string | null;
  createdById: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface MediaSharesPlan {
  total: number;
  byState: { active: number; expired: number; revoked: number };
  byTargetType: { media_item: number; album: number };
  /** Shares that already have a link grant (by token hash), by share id -> grant id. */
  alreadyImported: Map<string, string>;
  toImport: LegacyShareRow[];
  /** Shares that cannot be imported (malformed token, missing target): reported, never imported. */
  invalid: Array<{ id: string; reason: string }>;
}

export interface MediaSharesImportResult {
  imported: number;
  skipped: number;
  invalid: number;
  /** `shares.expiring` notifications whose `data.shareId` now names the grant. */
  rekeyedNotifications: number;
}

/** The token as `importLegacyToken` stores it. */
export function importedToken(token: string): string {
  return `lnk_${token}`;
}

/**
 * The lookup hash the sharing slice stores in `grants.link_token_hash`: SHA-256 hex of the
 * full `lnk_` token (the slice's `hashLinkToken`, which its index does not export; the
 * contract migration's guard computes the same in SQL).
 */
export function linkTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A clear MemoriaHub share token: 32 random bytes in base64url (43 characters). */
const LEGACY_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function stateOf(row: Pick<LegacyShareRow, 'revokedAt' | 'expiresAt'>, now: Date): 'active' | 'expired' | 'revoked' {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && row.expiresAt <= now) return 'expired';
  return 'active';
}

/** Whether `media_shares` still exists (it is dropped by the contract migration). */
export async function mediaSharesTableExists(tx: Prisma.TransactionClient): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ exists: boolean }>>`SELECT to_regclass('public.media_shares') IS NOT NULL AS exists`;
  return rows[0]?.exists === true;
}

/** Reads every share and decides what the import would do. Writes nothing. */
export async function planMediaSharesImport(tx: Prisma.TransactionClient, now: Date = new Date()): Promise<MediaSharesPlan | null> {
  if (!(await mediaSharesTableExists(tx))) return null;

  const rows = await tx.$queryRaw<LegacyShareRow[]>`
    SELECT s.id::text                                       AS "id",
           s.token                                          AS "token",
           s.target_type::text                              AS "targetType",
           COALESCE(s.media_item_id, s.album_id)::text      AS "resourceId",
           COALESCE(mi.org_id, al.org_id)::text             AS "orgId",
           s.created_by_id::text                            AS "createdById",
           s.expires_at                                     AS "expiresAt",
           s.revoked_at                                     AS "revokedAt",
           s.created_at                                     AS "createdAt"
    FROM media_shares s
    LEFT JOIN media_items mi ON mi.id = s.media_item_id
    LEFT JOIN albums al ON al.id = s.album_id
    ORDER BY s.created_at, s.id`;

  const plan: MediaSharesPlan = {
    total: rows.length,
    byState: { active: 0, expired: 0, revoked: 0 },
    byTargetType: { media_item: 0, album: 0 },
    alreadyImported: new Map(),
    toImport: [],
    invalid: [],
  };

  const hashes = rows.filter((r) => LEGACY_TOKEN.test(r.token)).map((r) => linkTokenHash(importedToken(r.token)));
  const existing = hashes.length
    ? await tx.$queryRaw<Array<{ id: string; hash: string }>>`
        SELECT id::text AS "id", link_token_hash AS "hash" FROM grants
        WHERE grantee_kind = 'link' AND link_token_hash IN (${Prisma.join(hashes)})`
    : [];
  const grantByHash = new Map(existing.map((g) => [g.hash, g.id]));

  for (const row of rows) {
    plan.byState[stateOf(row, now)] += 1;
    plan.byTargetType[row.targetType] += 1;
    if (!LEGACY_TOKEN.test(row.token)) {
      plan.invalid.push({ id: row.id, reason: 'token is not 43 base64url characters' });
      continue;
    }
    const grantId = grantByHash.get(linkTokenHash(importedToken(row.token)));
    if (grantId) {
      plan.alreadyImported.set(row.id, grantId);
      continue;
    }
    if (!row.resourceId || !row.orgId) {
      plan.invalid.push({ id: row.id, reason: 'the shared item or album no longer exists' });
      continue;
    }
    plan.toImport.push(row);
  }
  return plan;
}

/** The signature of the platform's `importLegacyToken` (injected for tests). */
export type ImportLegacyToken = (
  tx: unknown,
  input: {
    orgId: string;
    resourceType: string;
    resourceId: string;
    role: string;
    token: string;
    grantedById?: string | null;
    expiresAt?: Date | null;
    revokedAt?: Date | null;
    createdAt?: Date;
  },
) => Promise<{ grantId: string; token: string }>;

/** Imports `plan.toImport` and re-keys the `share_expiring` stamps of every share. */
export async function applyMediaSharesImport(
  tx: Prisma.TransactionClient,
  plan: MediaSharesPlan,
  importToken: ImportLegacyToken,
): Promise<MediaSharesImportResult> {
  const grantByShare = new Map(plan.alreadyImported);
  for (const row of plan.toImport) {
    const imported = await importToken(tx, {
      orgId: row.orgId!,
      resourceType: row.targetType,
      resourceId: row.resourceId!,
      role: 'viewer',
      token: row.token,
      grantedById: row.createdById,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    });
    grantByShare.set(row.id, imported.grantId);
  }

  let rekeyedNotifications = 0;
  for (const [shareId, grantId] of grantByShare) {
    rekeyedNotifications += await tx.$executeRaw`
      UPDATE notifications
      SET data = jsonb_set(data, '{shareId}', to_jsonb(${grantId}::text))
      WHERE event_key = ${SHARE_EXPIRING_EVENT_KEY}
        AND data->>'shareId' = ${shareId}`;
  }

  return {
    imported: plan.toImport.length,
    skipped: plan.alreadyImported.size,
    invalid: plan.invalid.length,
    rekeyedNotifications,
  };
}
