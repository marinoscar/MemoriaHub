import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DbBackupSystemData, DbBackupSystemTx } from '@marinoscar/platform-api/db-backup';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// DB_BACKUP_SYSTEM_DATA -> a transaction with app.rls_bypass on (RETRO-D4, #580)
// =============================================================================
//
// The one consumer is the Doctor check `backup.rls-bypass`: it counts rows of the
// row-level-security tables through a bypass client and compares that with a
// count over the dump's startup option. The platform binds `PrismaSystemService`
// (`runAsSystem`); MemoriaHub has no system client yet, so this adapter opens a
// transaction whose FIRST statement is `set_config('app.rls_bypass', 'on', true)`
// (transaction-local, never a session `SET`), the platform's RLS contract.
// Read-only use: the check only issues `SELECT count(*)`.
//
// PLATFORM-ADOPTION-SHIM(RETRO-D1): the storage slice brings `PrismaSystemService`
// (with `PrismaService.forOrg`/`runInOrg`); this then delegates to its `runAsSystem`.
// =============================================================================

@Injectable()
export class DbBackupSystemDataAdapter implements DbBackupSystemData {
  constructor(private readonly prisma: PrismaService) {}

  runAsSystem<T>(_reason: 'doctor', fn: (tx: DbBackupSystemTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.rls_bypass', 'on', true)`);
      return fn(tx as unknown as DbBackupSystemTx);
    });
  }
}
