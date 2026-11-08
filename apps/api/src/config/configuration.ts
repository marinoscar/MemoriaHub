import { identityConfiguration } from '@marinoscar/platform-api/identity';

import { buildDatabaseUrl } from './database-url.util';
import { resolveServiceName } from '../common/otel/telemetry-identity';

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

  // Observability
  otel: {
    enabled: process.env.OTEL_ENABLED === 'true',
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: resolveServiceName(),
  },

  // Storage Configuration
  storage: {
    provider: process.env.STORAGE_PROVIDER || 's3',
    s3: {
      bucket: process.env.S3_BUCKET || '',
      region: process.env.S3_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      endpoint: process.env.S3_ENDPOINT || undefined,
      maxAttempts: parseInt(process.env.S3_MAX_ATTEMPTS || '5', 10),
      retryMode: process.env.S3_RETRY_MODE || 'adaptive',
    },
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10737418240', 10), // 10GB default
    allowedMimeTypes: (
      process.env.ALLOWED_MIME_TYPES || 'image/*,application/pdf,video/*'
    ).split(','),
    signedUrlExpiry: parseInt(process.env.SIGNED_URL_EXPIRY || '3600', 10), // 1 hour default
    partSize: parseInt(process.env.STORAGE_PART_SIZE || '10485760', 10), // 10MB default
    // HISTORICAL NAME — this key is now consumed SOLELY by
    // LocalDiskStorageProvider as the filesystem root for the `local` storage
    // provider (STORAGE_PROVIDER=local / storage.activeProvider='local'). Its
    // `backup` name dates from the v0 server-side media backup feature, which
    // has been retired; it has nothing to do with backups any more. Do NOT
    // rename it or the BACKUP_LOCAL_PATH env var without a migration plan —
    // doing so silently relocates the storage root of every deployment running
    // on the local provider, which is a data-availability change.
    backup: {
      localPath: process.env.BACKUP_LOCAL_PATH || '/tmp/memoriahub-backup',
    },
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
