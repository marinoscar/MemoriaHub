import { Injectable } from '@nestjs/common';
import type { DbBackupSystemData, DbBackupSystemTx } from '@marinoscar/platform-api/db-backup';

import { PrismaSystemService } from '../../prisma/prisma-system.service';

// =============================================================================
// DB_BACKUP_SYSTEM_DATA -> PrismaSystemService.runAsSystem (RETRO-D4, #580; RETRO-D1, #563)
// =============================================================================
//
// The one consumer is the Doctor check `backup.rls-bypass`: it counts rows of the
// row-level-security tables through a bypass client and compares that with a
// count over the dump's startup option. Read-only use: the check only issues
// `SELECT count(*)`. Since RETRO-D1 it runs on the system pool with the named
// reason (`doctor`), like the platform's own binding.
// =============================================================================

@Injectable()
export class DbBackupSystemDataAdapter implements DbBackupSystemData {
  constructor(private readonly system: PrismaSystemService) {}

  runAsSystem<T>(reason: 'doctor', fn: (tx: DbBackupSystemTx) => Promise<T>): Promise<T> {
    return this.system.runAsSystem(reason, (tx) => fn(tx as unknown as DbBackupSystemTx));
  }
}
