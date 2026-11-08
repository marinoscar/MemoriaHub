import { identityConfiguration } from '@marinoscar/platform-api/identity';
import { jobsConfiguration } from '@marinoscar/platform-api/jobs';

import { buildDatabaseUrl } from './database-url.util';
import { resolveServiceName } from '../common/otel/telemetry-identity';
import { legacyJobsEnv } from '../platform/jobs/legacy-env';

function identityKeys() {
  return identityConfiguration({
    ...process.env,
    DEVICE_PAT_EXPIRY_DAYS: process.env.DEVICE_PAT_EXPIRY_DAYS ?? process.env.DEVICE_PAT_TTL_DAYS,
  });
}

export default () => {
  // Individual PostgreSQL variables (kept for the `database` config object shape)
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || '5432';
  const user = process.env.POSTGRES_USER || 'postgres';
  const password = process.env.POSTGRES_PASSWORD || 'postgres';
  const dbName = process.env.POSTGRES_DB || 'appdb';
  const ssl = process.env.POSTGRES_SSL === 'true';

  // Construct DATABASE_URL (base + connection-pool params) from the shared helper
  const databaseUrl = buildDatabaseUrl();

  // Set DATABASE_URL for Prisma
  process.env.DATABASE_URL = databaseUrl;

  return {
    // Application
    nodeEnv: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    appUrl: process.env.APP_URL || 'http://localhost:3535',

    // Database
    database: {
      host,
      port: parseInt(port, 10),
      user,
      password,
      name: dbName,
      ssl,
      url: databaseUrl,
    },

  // The identity slice's keys (RETRO-B2, #611): `jwt`, `auth`, `google`,
  // `initialAdminEmail`, `deviceAuth` and `tenancy`, built from the same
  // variables by `@marinoscar/platform-api/identity`. The device-flow PAT
  // lifetime is MemoriaHub's `DEVICE_PAT_TTL_DAYS` (the Android pairing and the
  // CLI's login contract); the platform names it `DEVICE_PAT_EXPIRY_DAYS`, which
  // wins when both are set.
  ...identityKeys(),

  // The jobs slice's keys (RETRO-C1, #575): `jobs.*` (retry, rate-limit, worker pool, reaper) and
  // `nodes.*` (the fleet's crons), built from the `JOBS_*` variables. The old `ENRICHMENT_*` names are
  // translated for one release by `legacyJobsEnv` (deprecation warning per variable; JOBS_* wins).
  ...jobsConfiguration(legacyJobsEnv()),

  // The db-backup slice (RETRO-D4, #580): whether this process schedules backups.
  // Same meaning as before the slice: anything but `false` schedules.
  dbBackup: {
    scheduleEnabled: process.env.DB_BACKUP_SCHEDULE_ENABLED !== 'false',
  },

  // Observability
  otel: {
    enabled: process.env.OTEL_ENABLED === 'true',
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: resolveServiceName(),
  },

  // Storage deployment limits (RETRO-D1, #563). The object store itself (driver,
  // bucket, region, endpoint, keys, the local root) is runtime configuration: the
  // `storage` system-settings namespace and the credential store, edited at
  // /admin/settings/storage. `STORAGE_PROVIDER`, `S3_*`, `AWS_ACCESS_KEY_ID`,
  // `AWS_SECRET_ACCESS_KEY`, `S3_MAX_ATTEMPTS`, `S3_RETRY_MODE` and
  // `BACKUP_LOCAL_PATH` are no longer read; `scripts/migrate-storage-settings.ts`
  // copies their values once (runbook: docs/runbooks/storage-configuration.md).
  storage: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10737418240', 10), // 10GB default
    allowedMimeTypes: (
      process.env.ALLOWED_MIME_TYPES || 'image/*,application/pdf,video/*'
    ).split(','),
    signedUrlExpiry: parseInt(process.env.SIGNED_URL_EXPIRY || '3600', 10), // 1 hour default
    partSize: parseInt(process.env.STORAGE_PART_SIZE || '10485760', 10), // 10MB default
  },

  logLevel: process.env.LOG_LEVEL || 'info',

  // Geo Services
  geo: {
    provider: process.env.GEO_PROVIDER || 'offline',
    nominatimBaseUrl: process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org',
    forwardSearchEnabled: process.env.GEO_FORWARD_SEARCH_ENABLED === 'true',
    forwardProvider: process.env.GEO_FORWARD_PROVIDER || 'nominatim',
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  },
  };
};
