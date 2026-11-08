import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../../../prisma/prisma.service';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, errorMessage, fail, pass } from '../outcome';

// Ported from `DoctorService.checkPgvector` (key `core.pgvector`). READ-ONLY: two
// catalog SELECTs.
// Retirement: kept as an app check; a `memoriahub.db.extensions` check (kvox
// pattern) may absorb it with `pg_trgm` later.

export const PGVECTOR_REMEDY =
  'Use a pgvector-capable Postgres image (pgvector/pgvector:pg16) and re-run migrations; ' +
  'semantic search is unavailable without it.';

export function decidePgvector(extensionPresent: boolean, tablePresent: boolean): DoctorCheckOutcome {
  if (!extensionPresent || !tablePresent) {
    return fail(
      !extensionPresent ? 'pgvector extension is not installed.' : 'media_item_embedding table not found.',
      PGVECTOR_REMEDY,
      { extension: extensionPresent, table: tablePresent },
    );
  }
  return pass('pgvector extension and embedding table present.', { extension: true, table: true });
}

@Injectable()
export class PgvectorDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('core', 'pgvector');
  readonly category = 'core';
  readonly label = 'pgvector extension';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;
  readonly dependsOn = ['db.connection'] as const;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    try {
      const [extRows, tableRows] = await Promise.all([
        this.prisma.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector'
        `,
        this.prisma.$queryRaw<Array<{ t: string | null }>>`
          SELECT to_regclass('public.media_item_embedding')::text AS t
        `,
      ]);
      return decidePgvector(extRows.length > 0, (tableRows[0]?.t ?? null) !== null);
    } catch (err) {
      return fail(errorMessage(err), PGVECTOR_REMEDY);
    }
  }
}
