// =============================================================================
// Storage gauges (RETRO-T3, #628)
// =============================================================================
//
//   app.storage.bytes{provider,kind}  from the latest `insights_snapshots` row
//   app.storage.trash.bytes           same snapshot
//
// NEVER a live SUM over `storage_objects`: the `storage_insights` job computes
// the breakdown on its own schedule (`storage.insights.refreshIntervalHours`)
// and this reads one row by `@@index([createdAt])`. A snapshot computed before
// RETRO-T3 has no breakdown; then the bytes fall back to the photo/video totals
// under provider `other`, and trash bytes are not reported.
// =============================================================================

import type { PrismaService } from '../../../prisma/prisma.service';

export interface StorageReading {
  bytes: Array<{ provider: string; kind: string; bytes: number }>;
  trashBytes: number | null;
}

const toNumber = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** The storage breakdown of the latest ready snapshot, or `null` when there is none. */
export async function readStorageSnapshot(prisma: PrismaService): Promise<StorageReading | null> {
  const snapshot = await prisma.insightsSnapshot.findFirst({
    where: { status: 'ready' },
    orderBy: { createdAt: 'desc' },
    select: { metrics: true },
  });
  const metrics = snapshot?.metrics as Record<string, unknown> | null | undefined;
  if (!metrics || typeof metrics !== 'object') return null;

  const breakdown = metrics['storageBreakdown'];
  if (Array.isArray(breakdown)) {
    return {
      bytes: breakdown
        .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
        .map((row) => ({ provider: String(row['provider']), kind: String(row['kind']), bytes: toNumber(row['bytes']) })),
      trashBytes: metrics['trashBytes'] === undefined ? null : toNumber(metrics['trashBytes']),
    };
  }
  return {
    bytes: [
      { provider: 'other', kind: 'photo', bytes: toNumber(metrics['photoBytes']) },
      { provider: 'other', kind: 'video', bytes: toNumber(metrics['videoBytes']) },
    ],
    trashBytes: null,
  };
}
