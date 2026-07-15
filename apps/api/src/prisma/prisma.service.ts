import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { buildBaseDatabaseUrl, resolvePoolConfig } from '../config/database-url.util';

/**
 * Builds the BASE PostgreSQL connection string (no Prisma pool query params),
 * falling back to DATABASE_URL when already provided.
 *
 * The runtime pool sizing is applied separately, as `pg.PoolConfig` fields
 * passed to the adapter (see the constructor) — NOT via URL query params. The
 * `@prisma/adapter-pg` adapter runs on a real `pg.Pool`, and `pg` ignores
 * Prisma's `connection_limit`/`pool_timeout` URL params (those only affect the
 * Prisma query engine used by the CLI/migration path). So we hand pg the base
 * URL and configure `max`/`connectionTimeoutMillis` explicitly.
 */
function buildConnectionString(): string {
  return buildBaseDatabaseUrl();
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // Pass a pg.PoolConfig OBJECT (not a bare string) so the runtime pg pool is
    // actually sized — `max` is the real connection_limit for the adapter, and
    // `connectionTimeoutMillis` is pg's pool-acquisition timeout.
    const { max, connectionTimeoutMillis } = resolvePoolConfig();
    const adapter = new PrismaPg({
      connectionString: buildConnectionString(),
      max,
      connectionTimeoutMillis,
    });
    super({
      adapter,
      // Raise the interactive-transaction budget above Prisma's 5s default.
      // Under bulk-import load the default timeout expired ("expired
      // transaction") and the pool starved ("Unable to start a transaction in
      // the given time"). timeout = max wall-clock a tx body may run;
      // maxWait = max time to wait for a pooled connection to start the tx.
      transactionOptions: {
        timeout: parseInt(process.env.PRISMA_TX_TIMEOUT_MS || '15000', 10),
        maxWait: parseInt(process.env.PRISMA_TX_MAX_WAIT_MS || '5000', 10),
      },
      // perceptualHash is an internal 64-bit dHash field used exclusively by
      // burst detection. It is not part of the public API surface and is omitted
      // globally to keep MediaItem responses clean. Burst detection code that
      // needs it reads it via an explicit `select`, which overrides this omit.
      omit: {
        mediaItem: {
          perceptualHash: true,
        },
      },
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');

    // Log queries in development
    if (process.env.NODE_ENV === 'development') {
      // @ts-ignore - Prisma event typing
      this.$on('query', (e: any) => {
        this.logger.debug(`Query: ${e.query}`);
        this.logger.debug(`Duration: ${e.duration}ms`);
      });
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }

  /**
   * Clean database for testing
   */
  async cleanDatabase() {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('cleanDatabase only allowed in test environment');
    }

    const tablenames = await this.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname='public'
    `;

    for (const { tablename } of tablenames) {
      if (tablename !== '_prisma_migrations') {
        await this.$executeRawUnsafe(
          `TRUNCATE TABLE "public"."${tablename}" CASCADE;`,
        );
      }
    }
  }
}
