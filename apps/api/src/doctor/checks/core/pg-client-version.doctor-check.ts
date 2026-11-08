import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DoctorCheckRegistry,
  type DoctorCheck,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../../../prisma/prisma.service';
import {
  compareClientToServer,
  PG_VERSION_ACTION_ITEM,
  pgVersionMismatchMessage,
  readPgClientMajor,
  readServerMajor,
} from '../../../db-backup/pg-version.util';
import { DOCTOR_CHECK_TIMEOUT_MS, checkId, fail, pass, warn } from '../outcome';

// Ported from `DoctorService.checkPgClientVersion` (key `core.pgClientVersion`,
// issue #364). `pg_dump`/`pg_restore` must not be OLDER than the server.
// READ-ONLY: one `SELECT current_setting(...)` and a `pg_dump --version` spawn.
//
// Ladder: fail on a positively established mismatch (client older than server);
// warn when pg_dump is unreadable (backup/restore unavailable, nothing else is
// affected) or the server version is unreadable; pass otherwise.

export function decidePgClientVersion(
  clientMajor: number | null,
  serverMajor: number | null,
): DoctorCheckOutcome {
  if (clientMajor === null) {
    return warn(
      'Could not read the pg_dump version (binary missing from PATH or unreadable). ' +
        'Database backup and restore are unavailable; nothing else is affected.',
      PG_VERSION_ACTION_ITEM,
    );
  }

  const verdict = compareClientToServer(clientMajor, serverMajor);

  if (verdict === 'client_older') {
    return fail(pgVersionMismatchMessage(clientMajor, serverMajor!), PG_VERSION_ACTION_ITEM, {
      clientMajor,
      serverMajor,
    });
  }

  // The app's own connection is failing: `db.connection` reports that, so this
  // is a warning and not a second failure.
  if (verdict === 'unknown') {
    return warn(
      `pg_dump is PostgreSQL ${clientMajor}, but the server version could not be read for comparison.`,
      'Fix the database connection (see the Database connection check), then run the Doctor again.',
      { clientMajor },
    );
  }

  return pass(`pg_dump ${clientMajor} >= server ${serverMajor}.`, { clientMajor, serverMajor });
}

@Injectable()
export class PgClientVersionDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = checkId('core', 'pg-client-version');
  readonly category = 'core';
  readonly label = 'PostgreSQL client version';
  readonly timeoutMs = DOCTOR_CHECK_TIMEOUT_MS;

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const [clientMajor, serverMajor] = await Promise.all([
      readPgClientMajor(),
      this.readServerVersionMajor(),
    ]);
    return decidePgClientVersion(clientMajor, serverMajor);
  }

  /** `server_version_num` (e.g. 170010) reduced to its major; null on failure. */
  private async readServerVersionMajor(): Promise<number | null> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ num: number }>>`
        SELECT current_setting('server_version_num')::int AS num
      `;
      return readServerMajor(rows[0]?.num ?? null);
    } catch {
      return null;
    }
  }
}
