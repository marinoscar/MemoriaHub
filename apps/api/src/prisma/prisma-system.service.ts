import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  runAsSystem,
  systemScopeExtension,
  type RlsTransactionOptions,
  type SystemAccessReason,
} from '@marinoscar/platform-api/core';

import { buildBaseDatabaseUrl } from '../config/database-url.util';
import '../app-registrations/system-access-reasons';

// =============================================================================
// The system (row-level-security bypass) client (RETRO-D1, #563)
// =============================================================================
//
// A SEPARATE, small connection pool whose every transaction sets
// `app.rls_bypass = 'on'` transaction-locally (`set_config(..., true)` as the
// first statement), for the few reviewed paths that must cross organizations:
// the storage slice's stale-upload sweep and stranded-object count
// (`STORAGE_SYSTEM_DATA`), the db-backup Doctor count (`DB_BACKUP_SYSTEM_DATA`)
// and the global `thumbnail_repair` sweep. Each acquisition names a registered
// `SystemAccessReason`, recorded on the active span.
//
// Why its own pool: a bypass flag can never leak into a request connection of
// the main pool, even through a bug that forgot a transaction boundary.
//
// Who may inject it: the files listed in
// `test/tenancy/system-injection-boundary.spec.ts` (ALLOWLIST). Anything else
// goes through `PrismaService.forOrg` / `runInOrg`.
// =============================================================================

/** The pool size: the bypass paths are rare and short. */
export const SYSTEM_POOL_MAX = 4;

/** `application_name` of the pool, so `pg_stat_activity` tells the two pools apart. */
export const SYSTEM_APPLICATION_NAME = 'memoriahub-system';

@Injectable()
export class PrismaSystemService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaSystemService.name);

  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: buildBaseDatabaseUrl(),
        max: SYSTEM_POOL_MAX,
        application_name: SYSTEM_APPLICATION_NAME,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(`System database pool connected (${SYSTEM_APPLICATION_NAME}, max ${SYSTEM_POOL_MAX})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * A client whose every operation lifts row-level security for its own
   * transaction.
   *
   * @param reason - why; must be a registered `SystemAccessReason`.
   */
  asSystem(reason: SystemAccessReason) {
    this.logger.debug(`System database access: ${reason}`);
    return this.$extends(systemScopeExtension(this, reason));
  }

  /** One interactive transaction with row-level security lifted. */
  runAsSystem<R>(
    reason: SystemAccessReason,
    fn: (tx: Prisma.TransactionClient) => Promise<R>,
    options: RlsTransactionOptions = {},
  ): Promise<R> {
    this.logger.debug(`System database access: ${reason}`);
    return runAsSystem(this, reason, fn as (tx: unknown) => Promise<R>, options);
  }
}

/** The client {@link PrismaSystemService.asSystem} returns. */
export type SystemPrismaClient = ReturnType<PrismaSystemService['asSystem']>;
