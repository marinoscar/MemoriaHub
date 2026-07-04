// =============================================================================
// Doctor Service
// =============================================================================
//
// On-demand configuration health sweep for admins. Runs a fixed catalog of
// checks across core infra, auth, storage, AI, face, geo, and the job queue —
// concurrently, with a per-check timeout and exception normalization. No
// result is persisted; every call recomputes the report from scratch.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  SystemSettingsService,
  ResolvedSettings,
} from '../settings/system-settings/system-settings.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { FaceSettingsService } from '../face/face-settings.service';
import { GeoSettingsService } from '../geo/geo-settings.service';
import { StorageSettingsService } from '../storage-settings/storage-settings.service';
import { EnrichmentAdminService } from '../enrichment/enrichment-admin.service';
import { isEnrichmentWorkerEnabled } from '../enrichment/enrichment-job.worker';
import {
  DoctorCheck,
  DoctorCheckStatus,
  DoctorReport,
  DoctorSection,
} from './doctor.types';

/** Result shape returned by an individual check function, before the runCheck wrapper adds key/label/durationMs. */
interface CheckOutcome {
  status: DoctorCheckStatus;
  message: string;
  actionItem?: string;
}

interface CheckDef {
  key: string;
  label: string;
  fn: () => Promise<CheckOutcome>;
}

interface SectionDef {
  key: string;
  label: string;
  checkKeys: string[];
}

/** Per-check timeout — a hung provider call must not hang the whole sweep. */
const CHECK_TIMEOUT_MS = 10_000;

/** Sentinel thrown by the timeout race branch; never surfaced to callers. */
const TIMEOUT_SENTINEL = Symbol('doctor-check-timeout');

@Injectable()
export class DoctorService {
  private readonly logger = new Logger(DoctorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemSettings: SystemSettingsService,
    private readonly aiSettings: AiSettingsService,
    private readonly faceSettings: FaceSettingsService,
    private readonly geoSettings: GeoSettingsService,
    private readonly storageSettings: StorageSettingsService,
    private readonly enrichmentAdmin: EnrichmentAdminService,
  ) {}

  // ---------------------------------------------------------------------------
  // runDiagnostics
  // ---------------------------------------------------------------------------

  async runDiagnostics(): Promise<DoctorReport> {
    const start = Date.now();
    this.logger.debug('Doctor: runDiagnostics started');

    const settings = await this.systemSettings.getSettings();

    const defs: CheckDef[] = [
      // Core
      { key: 'core.database', label: 'Database connectivity', fn: () => this.checkDatabase() },
      { key: 'core.migrations', label: 'Migrations applied', fn: () => this.checkMigrations() },
      { key: 'core.pgvector', label: 'pgvector extension', fn: () => this.checkPgvector() },
      { key: 'core.secretsKey', label: 'Secrets encryption key', fn: () => this.checkSecretsKey() },
      { key: 'core.appUrl', label: 'App URL', fn: () => this.checkAppUrl() },
      // Auth
      { key: 'auth.jwt', label: 'JWT secret', fn: () => this.checkJwtSecret() },
      { key: 'auth.googleOauth', label: 'Google OAuth', fn: () => this.checkGoogleOauth() },
      { key: 'auth.adminBootstrap', label: 'Admin bootstrap', fn: () => this.checkAdminBootstrap() },
      // Storage
      {
        key: 'storage.activeProvider',
        label: 'Active storage provider',
        fn: () => this.checkActiveStorageProvider(settings),
      },
      {
        key: 'storage.liveTest',
        label: 'Storage connectivity',
        fn: () => this.checkStorageLiveTest(settings),
      },
      // AI
      { key: 'ai.search', label: 'AI search provider', fn: () => this.checkAiSearch(settings) },
      { key: 'ai.tagging', label: 'Auto-tagging provider', fn: () => this.checkAiTagging(settings) },
      { key: 'ai.embedding', label: 'Text embedding provider', fn: () => this.checkAiEmbedding(settings) },
      {
        key: 'ai.flagConsistency',
        label: 'Auto-tagging flag consistency',
        fn: () => this.checkAiFlagConsistency(settings),
      },
      // Face
      { key: 'face.detection', label: 'Face detection provider', fn: () => this.checkFaceDetection(settings) },
      {
        key: 'face.flagConsistency',
        label: 'Face flag consistency',
        fn: () => this.checkFaceFlagConsistency(settings),
      },
      // Geo
      { key: 'geo.reverseProvider', label: 'Reverse geocoding', fn: () => this.checkGeoReverseProvider(settings) },
      // Jobs
      {
        key: 'jobs.workerEnabled',
        label: 'Enrichment worker enabled',
        fn: () => this.checkWorkerEnabled(settings),
      },
      { key: 'jobs.queueHealth', label: 'Queue health', fn: () => this.checkQueueHealth() },
      { key: 'jobs.burstConfig', label: 'Burst detection', fn: () => this.checkBurstConfig(settings) },
    ];

    const settled = await Promise.allSettled(defs.map((def) => this.runCheck(def)));

    const checks: DoctorCheck[] = settled.map((result, i) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // Belt-and-suspenders: runCheck already catches everything internally,
      // so this branch should be unreachable in practice.
      const def = defs[i];
      const reason = result.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      return { key: def.key, label: def.label, status: 'error', message, durationMs: 0 };
    });

    const checksByKey = new Map(checks.map((c) => [c.key, c]));

    const sectionDefs: SectionDef[] = [
      {
        key: 'core',
        label: 'Core',
        checkKeys: ['core.database', 'core.migrations', 'core.pgvector', 'core.secretsKey', 'core.appUrl'],
      },
      {
        key: 'auth',
        label: 'Authentication',
        checkKeys: ['auth.jwt', 'auth.googleOauth', 'auth.adminBootstrap'],
      },
      {
        key: 'storage',
        label: 'Storage',
        checkKeys: ['storage.activeProvider', 'storage.liveTest'],
      },
      {
        key: 'ai',
        label: 'AI & Enrichment',
        checkKeys: ['ai.search', 'ai.tagging', 'ai.embedding', 'ai.flagConsistency'],
      },
      {
        key: 'face',
        label: 'Face Recognition',
        checkKeys: ['face.detection', 'face.flagConsistency'],
      },
      {
        key: 'geo',
        label: 'Geo',
        checkKeys: ['geo.reverseProvider'],
      },
      {
        key: 'jobs',
        label: 'Job Queue & Worker',
        checkKeys: ['jobs.workerEnabled', 'jobs.queueHealth', 'jobs.burstConfig'],
      },
    ];

    const sections: DoctorSection[] = sectionDefs.map((sd) => {
      const sectionChecks = sd.checkKeys.map((k) => checksByKey.get(k)!);
      return {
        key: sd.key,
        label: sd.label,
        status: this.worstStatus(sectionChecks.map((c) => c.status)),
        checks: sectionChecks,
      };
    });

    const summary = { ok: 0, warning: 0, error: 0, skipped: 0, total: 0 };
    for (const c of checks) {
      summary[c.status] += 1;
      summary.total += 1;
    }

    const report: DoctorReport = {
      computedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      summary,
      sections,
    };

    this.logger.debug(
      `Doctor: runDiagnostics completed in ${report.durationMs}ms (ok=${summary.ok} warning=${summary.warning} error=${summary.error} skipped=${summary.skipped})`,
    );

    return report;
  }

  // ---------------------------------------------------------------------------
  // worstStatus — precedence error > warning > ok; 'skipped' counts as 'ok'.
  // ---------------------------------------------------------------------------

  private worstStatus(statuses: DoctorCheckStatus[]): DoctorCheckStatus {
    if (statuses.includes('error')) return 'error';
    if (statuses.includes('warning')) return 'warning';
    return 'ok';
  }

  // ---------------------------------------------------------------------------
  // runCheck — timing, exception normalization, and per-check timeout.
  // ---------------------------------------------------------------------------

  private async runCheck(def: CheckDef): Promise<DoctorCheck> {
    const start = Date.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      const outcome = await Promise.race([
        def.fn(),
        new Promise<CheckOutcome>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(TIMEOUT_SENTINEL), CHECK_TIMEOUT_MS);
        }),
      ]);

      return {
        key: def.key,
        label: def.label,
        status: outcome.status,
        message: outcome.message,
        ...(outcome.actionItem ? { actionItem: outcome.actionItem } : {}),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const durationMs = Date.now() - start;

      if (err === TIMEOUT_SENTINEL) {
        return {
          key: def.key,
          label: def.label,
          status: 'error',
          message: 'Check timed out after 10s',
          durationMs,
        };
      }

      // CRITICAL: several test-connectivity services throw (e.g.
      // BadRequestException when credentials are missing) rather than
      // returning { ok: false }. Never let that bubble past the sweep.
      const message = err instanceof Error ? err.message : String(err);
      return { key: def.key, label: def.label, status: 'error', message, durationMs };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  // ===========================================================================
  // Core checks
  // ===========================================================================

  private async checkDatabase(): Promise<CheckOutcome> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', message: 'Database reachable.' };
    } catch (err) {
      return {
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        actionItem: 'Verify POSTGRES_* env vars and that the database is reachable.',
      };
    }
  }

  private async checkMigrations(): Promise<CheckOutcome> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NULL
      `;
      const n = rows[0]?.n ?? 0;
      if (n > 0) {
        return {
          status: 'error',
          message: `${n} migration(s) not fully applied.`,
          actionItem: 'Run `npx prisma migrate deploy`.',
        };
      }
      return { status: 'ok', message: 'All migrations applied.' };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async checkPgvector(): Promise<CheckOutcome> {
    try {
      const [extRows, tableRows] = await Promise.all([
        this.prisma.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector'
        `,
        this.prisma.$queryRaw<Array<{ t: string | null }>>`
          SELECT to_regclass('public.media_item_embedding')::text AS t
        `,
      ]);

      const extensionPresent = extRows.length > 0;
      const tablePresent = (tableRows[0]?.t ?? null) !== null;

      if (!extensionPresent || !tablePresent) {
        return {
          status: 'error',
          message: !extensionPresent
            ? 'pgvector extension is not installed.'
            : 'media_item_embedding table not found.',
          actionItem:
            'Use a pgvector-capable Postgres image (pgvector/pgvector:pg16) and re-run migrations; ' +
            'semantic search is unavailable without it.',
        };
      }

      return { status: 'ok', message: 'pgvector extension and embedding table present.' };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async checkSecretsKey(): Promise<CheckOutcome> {
    const value = process.env['SECRETS_ENCRYPTION_KEY'];
    if (value) {
      try {
        if (Buffer.from(value, 'base64').length === 32) {
          return { status: 'ok', message: 'Secrets encryption key configured.' };
        }
      } catch {
        // fall through to error below
      }
    }
    return {
      status: 'error',
      message: 'SECRETS_ENCRYPTION_KEY is missing or is not a valid base64-encoded 32-byte key.',
      actionItem: 'Set SECRETS_ENCRYPTION_KEY to a base64-encoded 32-byte key (openssl rand -base64 32).',
    };
  }

  private async checkAppUrl(): Promise<CheckOutcome> {
    const appUrl = process.env['APP_URL'];
    if (!appUrl) {
      return { status: 'warning', message: 'APP_URL not set.' };
    }
    if (appUrl.includes('localhost') && process.env['NODE_ENV'] === 'production') {
      return {
        status: 'warning',
        message: 'APP_URL is still localhost in production.',
        actionItem: 'Set APP_URL to the public base URL.',
      };
    }
    return { status: 'ok', message: `APP_URL: ${appUrl}` };
  }

  // ===========================================================================
  // Auth checks
  // ===========================================================================

  private async checkJwtSecret(): Promise<CheckOutcome> {
    const secret = process.env['JWT_SECRET'];
    if (secret && secret.length >= 32) {
      return { status: 'ok', message: 'JWT secret configured.' };
    }
    return {
      status: 'error',
      message: 'JWT_SECRET is missing or shorter than 32 characters.',
      actionItem: 'Set JWT_SECRET to a random string of at least 32 characters.',
    };
  }

  private async checkGoogleOauth(): Promise<CheckOutcome> {
    const configured = !!process.env['GOOGLE_CLIENT_ID'] && !!process.env['GOOGLE_CLIENT_SECRET'];
    if (configured) {
      return { status: 'ok', message: 'Google OAuth configured.' };
    }
    if (process.env['NODE_ENV'] === 'production') {
      return {
        status: 'error',
        message: 'Google OAuth is not configured.',
        actionItem: 'Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      };
    }
    return { status: 'warning', message: 'Google OAuth not configured (dev fallback only).' };
  }

  private async checkAdminBootstrap(): Promise<CheckOutcome> {
    const adminCount = await this.prisma.user.count({
      where: { userRoles: { some: { role: { name: 'admin' } } } },
    });

    if (adminCount === 0) {
      const initialAdminSet = !!process.env['INITIAL_ADMIN_EMAIL'];
      return {
        status: 'warning',
        message: initialAdminSet
          ? 'No admin users found.'
          : 'No admin users found. INITIAL_ADMIN_EMAIL is also not set.',
        actionItem: 'Set INITIAL_ADMIN_EMAIL and have that user sign in.',
      };
    }

    return { status: 'ok', message: `${adminCount} admin user(s).` };
  }

  // ===========================================================================
  // Storage checks
  // ===========================================================================

  private resolveActiveStorageProvider(settings: ResolvedSettings): string {
    return settings.storage?.activeProvider ?? process.env['STORAGE_PROVIDER'] ?? 's3';
  }

  private async checkActiveStorageProvider(settings: ResolvedSettings): Promise<CheckOutcome> {
    const provider = this.resolveActiveStorageProvider(settings);

    if (provider === 'local') {
      return { status: 'ok', message: `Active provider: ${provider}.` };
    }

    const cred = await this.prisma.storageProviderCredential.findFirst({
      where: { provider, enabled: true },
    });

    if (!cred) {
      return {
        status: 'error',
        message: `No enabled credential configured for active storage provider "${provider}".`,
        actionItem: 'Configure a storage provider in Admin Settings → Storage Providers.',
      };
    }

    return { status: 'ok', message: `Active provider: ${provider}.` };
  }

  private async checkStorageLiveTest(settings: ResolvedSettings): Promise<CheckOutcome> {
    const provider = this.resolveActiveStorageProvider(settings);
    const result = await this.storageSettings.testConnection({ provider });

    if (!result.ok) {
      return {
        status: 'error',
        message: result.error ?? 'Storage connectivity test failed.',
        actionItem: 'Fix storage credentials/bucket in Admin Settings → Storage Providers.',
      };
    }

    return {
      status: 'ok',
      message: `Write→read→delete round-trip succeeded (bucket ${result.bucket ?? provider}).`,
    };
  }

  // ===========================================================================
  // AI checks
  // ===========================================================================

  private async checkAiSearch(settings: ResolvedSettings): Promise<CheckOutcome> {
    const cfg = settings.ai?.features?.search;
    if (!cfg?.provider || !cfg?.model) {
      return { status: 'skipped', message: 'AI search not configured.' };
    }

    const result = await this.aiSettings.testProvider({ provider: cfg.provider, model: cfg.model });
    if (!result.ok) {
      return {
        status: 'error',
        message: result.error ?? 'AI search provider test failed.',
        actionItem: 'Check the provider API key and model in Admin Settings → AI.',
      };
    }
    return { status: 'ok', message: `AI search provider "${cfg.provider}" (${cfg.model}) reachable.` };
  }

  private async checkAiTagging(settings: ResolvedSettings): Promise<CheckOutcome> {
    const cfg = settings.ai?.features?.tagging;
    if (!cfg?.provider || !cfg?.model) {
      return { status: 'skipped', message: 'Auto-tagging provider not configured.' };
    }

    const result = await this.aiSettings.testProvider({ provider: cfg.provider, model: cfg.model });
    if (!result.ok) {
      return {
        status: 'error',
        message: result.error ?? 'Auto-tagging provider test failed.',
        actionItem: 'Check the provider API key and model in Admin Settings → AI.',
      };
    }
    return { status: 'ok', message: `Auto-tagging provider "${cfg.provider}" (${cfg.model}) reachable.` };
  }

  private async checkAiEmbedding(settings: ResolvedSettings): Promise<CheckOutcome> {
    const cfg = settings.ai?.features?.embedding;
    if (!cfg?.provider || !cfg?.model) {
      return {
        status: 'skipped',
        message: 'Embeddings not configured; semantic search falls back to filter-only.',
      };
    }

    const result = await this.aiSettings.testEmbedding({});
    if (!result.ok) {
      return {
        status: 'error',
        message: result.error ?? 'Embedding provider test failed.',
        actionItem: 'Check the provider API key and model in Admin Settings → AI.',
      };
    }
    if (result.warning) {
      return { status: 'warning', message: result.warning };
    }
    return { status: 'ok', message: `Embeddings OK (${result.dimensions}-d).` };
  }

  private async checkAiFlagConsistency(settings: ResolvedSettings): Promise<CheckOutcome> {
    const autoTaggingEnabled = settings.features?.['autoTagging'] === true;
    const taggingConfigured = !!settings.ai?.features?.tagging?.provider;

    if (autoTaggingEnabled && !taggingConfigured) {
      return {
        status: 'error',
        message: 'Auto-Tagging is enabled but no tagging provider is configured.',
        actionItem: 'Configure a tagging provider or disable the Auto-Tagging feature flag.',
      };
    }

    if (taggingConfigured && !autoTaggingEnabled) {
      return {
        status: 'warning',
        message: 'Tagging provider configured but the Auto-Tagging feature flag is off.',
        actionItem: 'Enable Auto-Tagging in Admin Settings → Tagging if desired.',
      };
    }

    return { status: 'ok', message: 'Auto-Tagging flag and provider configuration are consistent.' };
  }

  // ===========================================================================
  // Face checks
  // ===========================================================================

  private async checkFaceDetection(settings: ResolvedSettings): Promise<CheckOutcome> {
    const faceRecognitionEnabled = settings.features?.['faceRecognition'] === true;
    const detection = settings.face?.features?.detection;
    const provider = detection?.provider;

    if (faceRecognitionEnabled && !provider) {
      return {
        status: 'error',
        message: 'Face Recognition is enabled but no detection provider is configured.',
        actionItem: 'Configure a face detection provider or disable Face Recognition.',
      };
    }

    if (provider) {
      const result = await this.faceSettings.testProvider({ provider });
      if (!result.ok) {
        return {
          status: 'error',
          message: result.error ?? 'Face detection provider test failed.',
          actionItem: 'Check the provider configuration in Admin Settings → Face.',
        };
      }
      return { status: 'ok', message: `Face detection provider "${provider}" reachable.` };
    }

    return { status: 'skipped', message: 'Face recognition disabled.' };
  }

  private async checkFaceFlagConsistency(settings: ResolvedSettings): Promise<CheckOutcome> {
    const faceRecognitionEnabled = settings.features?.['faceRecognition'] === true;
    const provider = settings.face?.features?.detection?.provider;

    if (provider && !faceRecognitionEnabled) {
      return {
        status: 'warning',
        message: 'Face provider configured but Face Recognition feature flag is off.',
        actionItem: 'Enable Face Recognition in Admin Settings → Face if desired.',
      };
    }

    if (faceRecognitionEnabled) {
      return { status: 'ok', message: 'Face Recognition flag and provider configuration are consistent.' };
    }

    return { status: 'skipped', message: 'Face recognition disabled.' };
  }

  // ===========================================================================
  // Geo checks
  // ===========================================================================

  private async checkGeoReverseProvider(settings: ResolvedSettings): Promise<CheckOutcome> {
    const provider = settings.geo?.reverseProvider ?? process.env['GEO_PROVIDER'] ?? 'offline';
    const result = await this.geoSettings.testProvider({
      provider: provider as 'offline' | 'nominatim' | 'google',
    });

    if (!result.ok) {
      return {
        status: 'error',
        message: result.error ?? 'Reverse geocoding provider test failed.',
        actionItem: 'Configure the geo provider credentials in Admin Settings → Geo.',
      };
    }

    return { status: 'ok', message: `Provider ${provider} responding.` };
  }

  // ===========================================================================
  // Jobs checks
  // ===========================================================================

  private async checkWorkerEnabled(settings: ResolvedSettings): Promise<CheckOutcome> {
    const enabled = isEnrichmentWorkerEnabled();
    if (enabled) {
      return { status: 'ok', message: 'Enrichment worker is enabled.' };
    }

    const anyEnrichmentFeatureOn =
      settings.features?.['autoTagging'] === true ||
      settings.features?.['faceRecognition'] === true ||
      settings.features?.['burstDetection'] === true;

    if (anyEnrichmentFeatureOn) {
      return {
        status: 'error',
        message: 'Enrichment worker is disabled but at least one enrichment feature flag is on.',
        actionItem: 'Set ENRICHMENT_WORKER_ENABLED=true so enrichment jobs get processed.',
      };
    }

    return { status: 'warning', message: 'Enrichment worker is disabled.' };
  }

  private async checkQueueHealth(): Promise<CheckOutcome> {
    const stats = await this.enrichmentAdmin.getStats();

    if (stats.stuckRunning > 0) {
      return {
        status: 'warning',
        message: `${stats.stuckRunning} job(s) stuck running.`,
        actionItem: 'Reset stuck jobs from the Job Queue page.',
      };
    }

    if (stats.byStatus.failed > 0) {
      return {
        status: 'warning',
        message: `${stats.byStatus.failed} failed job(s) in the queue.`,
        actionItem: 'Review and retry failed jobs from the Job Queue page.',
      };
    }

    return {
      status: 'ok',
      message: `Queue healthy (pending ${stats.byStatus.pending}, running ${stats.byStatus.running}).`,
    };
  }

  private async checkBurstConfig(settings: ResolvedSettings): Promise<CheckOutcome> {
    if (settings.features?.['burstDetection'] !== true) {
      return { status: 'skipped', message: 'Burst detection disabled.' };
    }
    return {
      status: 'ok',
      message: 'Burst detection enabled (no provider required; depends on the enrichment worker).',
    };
  }
}
