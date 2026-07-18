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
import { resolveWorkerMode } from '../enrichment/enrichment-job.worker';
import { SocialMediaOcrService } from '../social-media/social-media-ocr.service';
import { VisualEmbeddingService } from '../dedup/visual-embedding.service';
import { DEFAULT_FACE_VECTOR_BACKEND } from '../face/face-matching.service';
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
    private readonly socialMediaOcr: SocialMediaOcrService,
    private readonly visualEmbeddingService: VisualEmbeddingService,
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
      {
        key: 'ai.socialMedia',
        label: 'Social media detection',
        fn: () => this.checkSocialMedia(settings),
      },
      {
        key: 'ai.duplicateDetection',
        label: 'Duplicate detection (CLIP)',
        fn: () => this.checkDuplicateDetection(settings),
      },
      {
        key: 'ai.pictureEnhancer',
        label: 'AI picture enhancer',
        fn: () => this.checkPictureEnhancer(settings),
      },
      // Face
      { key: 'face.detection', label: 'Face detection provider', fn: () => this.checkFaceDetection(settings) },
      {
        key: 'face.flagConsistency',
        label: 'Face flag consistency',
        fn: () => this.checkFaceFlagConsistency(settings),
      },
      { key: 'face.pgvector', label: 'Face pgvector index', fn: () => this.checkFacePgvector() },
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
      // Worker Nodes (distributed compute fleet)
      { key: 'nodes.registeredCount', label: 'Registered nodes', fn: () => this.checkNodesRegistered() },
      {
        key: 'nodes.heartbeatFreshness',
        label: 'Heartbeat freshness',
        fn: () => this.checkNodesHeartbeat(),
      },
      { key: 'nodes.staleLeases', label: 'Expired leases', fn: () => this.checkNodesStaleLeases() },
      {
        key: 'nodes.capabilityHealth',
        label: 'Node capability health',
        fn: () => this.checkNodesCapabilityHealth(),
      },
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
        checkKeys: [
          'ai.search',
          'ai.tagging',
          'ai.embedding',
          'ai.flagConsistency',
          'ai.socialMedia',
          'ai.duplicateDetection',
          'ai.pictureEnhancer',
        ],
      },
      {
        key: 'face',
        label: 'Face Recognition',
        checkKeys: ['face.detection', 'face.flagConsistency', 'face.pgvector'],
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
      {
        key: 'nodes',
        label: 'Worker Nodes',
        checkKeys: [
          'nodes.registeredCount',
          'nodes.heartbeatFreshness',
          'nodes.staleLeases',
          'nodes.capabilityHealth',
        ],
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
        SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL
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

  /**
   * Face pgvector KNN readiness: when FACE_VECTOR_BACKEND resolves to 'pgvector'
   * (the default), face person/archive matching relies on the trigger-maintained
   * faces.embedding_vec column and its HNSW indexes. Verify the column and the
   * main index exist (and note if the partial archive index is missing); when the
   * backend is 'app' the column is not required, so the check is skipped.
   */
  private async checkFacePgvector(): Promise<CheckOutcome> {
    const backend = process.env['FACE_VECTOR_BACKEND'] ?? DEFAULT_FACE_VECTOR_BACKEND;

    if (backend === 'app') {
      return {
        status: 'skipped',
        message:
          'FACE_VECTOR_BACKEND=app; face matching uses in-app cosine (pgvector column not required).',
      };
    }

    try {
      const [colRows, idxRows] = await Promise.all([
        this.prisma.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok FROM information_schema.columns
          WHERE table_name = 'faces' AND column_name = 'embedding_vec'
        `,
        this.prisma.$queryRaw<Array<{ indexname: string }>>`
          SELECT indexname FROM pg_indexes
          WHERE tablename = 'faces'
            AND indexname IN (
              'faces_embedding_vec_hnsw_idx',
              'faces_embedding_vec_archive_hnsw_idx',
              'faces_embedding_vec_assigned_hnsw_idx'
            )
        `,
      ]);

      const columnPresent = colRows.length > 0;
      const idxNames = new Set(idxRows.map((r) => r.indexname));
      const mainIndexPresent = idxNames.has('faces_embedding_vec_hnsw_idx');
      const archiveIndexPresent = idxNames.has('faces_embedding_vec_archive_hnsw_idx');
      const assignedIndexPresent = idxNames.has('faces_embedding_vec_assigned_hnsw_idx');

      const rollbackHint =
        'Run migrations (npx prisma migrate deploy) to add the face pgvector column/indexes, ' +
        'or set FACE_VECTOR_BACKEND=app to roll back to in-app cosine matching.';

      if (!columnPresent || !mainIndexPresent) {
        return {
          status: 'warning',
          message: !columnPresent
            ? 'FACE_VECTOR_BACKEND=pgvector but faces.embedding_vec column is missing.'
            : 'FACE_VECTOR_BACKEND=pgvector but faces_embedding_vec_hnsw_idx index is missing.',
          actionItem: rollbackHint,
        };
      }

      if (!archiveIndexPresent) {
        return {
          status: 'warning',
          message:
            'faces_embedding_vec_archive_hnsw_idx (partial archive index) is missing; ' +
            'face-auto-archive KNN falls back to the main index and is slower.',
          actionItem: 'Run migrations (npx prisma migrate deploy) to add the partial archive index.',
        };
      }

      if (!assignedIndexPresent) {
        return {
          status: 'warning',
          message:
            'faces_embedding_vec_assigned_hnsw_idx (partial assigned-set index) is missing; ' +
            'person-match KNN falls back to the main index and can be starved by unassigned faces after bulk imports.',
          actionItem:
            'Run migrations (npx prisma migrate deploy) to add the partial assigned-set index.',
        };
      }

      return {
        status: 'ok',
        message: 'faces.embedding_vec column and all three HNSW indexes present.',
      };
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

  private async checkSocialMedia(settings: ResolvedSettings): Promise<CheckOutcome> {
    if (settings.features?.['socialMediaDetection'] !== true) {
      return { status: 'skipped', message: 'Social media detection disabled' };
    }

    if (process.env['SOCIAL_MEDIA_DETECTION_ENABLED'] === 'false') {
      return {
        status: 'warning',
        message:
          'Feature enabled in settings but SOCIAL_MEDIA_DETECTION_ENABLED=false overrides it',
        actionItem: 'Remove or set SOCIAL_MEDIA_DETECTION_ENABLED=true',
      };
    }

    const cfg = settings.socialMedia;

    // Range validation of the socialMedia.* tunables.
    const rangeErrors: string[] = [];
    if (cfg) {
      if (cfg.ocrMaxFrames < 2 || cfg.ocrMaxFrames > 6) {
        rangeErrors.push(`ocrMaxFrames=${cfg.ocrMaxFrames} (expected 2–6)`);
      }
      if (cfg.ocrTimeoutSeconds < 10 || cfg.ocrTimeoutSeconds > 300) {
        rangeErrors.push(`ocrTimeoutSeconds=${cfg.ocrTimeoutSeconds} (expected 10–300)`);
      }
      if (cfg.minConfidence < 0.5 || cfg.minConfidence > 1.0) {
        rangeErrors.push(`minConfidence=${cfg.minConfidence} (expected 0.5–1.0)`);
      }
    }
    if (rangeErrors.length > 0) {
      return {
        status: 'warning',
        message: `Social media detection setting(s) out of range: ${rangeErrors.join(', ')}`,
        actionItem: 'Correct the social media detection parameters in Admin Settings.',
      };
    }

    if (cfg?.ocrEnabled === false) {
      return {
        status: 'ok',
        message: 'Tier-1 (metadata/filename) only — OCR disabled in settings',
      };
    }

    // Feature on + OCR enabled → probe the OCR model availability.
    const ocrStatus = await this.socialMediaOcr.getStatus();
    if (ocrStatus.ocrAvailable && !ocrStatus.degraded) {
      return {
        status: 'ok',
        message: 'Two-tier detection operational (metadata/filename + OCR)',
      };
    }

    return {
      status: 'warning',
      message: 'Running Tier-1 only — OCR model unavailable (degraded)',
      actionItem:
        'Ensure MODELS_DIR/tesseract is writable and traineddata can be fetched or pre-placed',
    };
  }

  private async checkDuplicateDetection(settings: ResolvedSettings): Promise<CheckOutcome> {
    if (settings.features?.['duplicateDetection'] !== true) {
      return { status: 'skipped', message: 'Near-duplicate detection is disabled.' };
    }

    // dedup still functions hash-only when the CLIP model is unavailable, so a
    // degraded runtime is a warning, never an error.
    if (this.visualEmbeddingService.isAvailable()) {
      return {
        status: 'ok',
        message: 'Two-tier operational (CLIP visual embeddings + dHash).',
      };
    }

    return {
      status: 'warning',
      message: 'Running dHash-only — CLIP visual embedding model unavailable (degraded).',
      actionItem:
        'onnxruntime native runtime failed to load; verify the API image uses a glibc base ' +
        '(not Alpine/musl) and MODELS_DIR is writable/reachable.',
    };
  }

  private async checkPictureEnhancer(settings: ResolvedSettings): Promise<CheckOutcome> {
    if (settings.features?.['pictureEnhancement'] !== true) {
      return { status: 'skipped', message: 'AI picture enhancer is disabled.' };
    }

    if (process.env['PICTURE_ENHANCEMENT_ENABLED'] === 'false') {
      return {
        status: 'warning',
        message:
          'Feature enabled in settings but PICTURE_ENHANCEMENT_ENABLED=false overrides it.',
        actionItem: 'Remove or set PICTURE_ENHANCEMENT_ENABLED=true.',
      };
    }

    const enhanceCfg = settings.ai?.features?.enhance;
    const provider = enhanceCfg?.provider ?? null;
    const model = enhanceCfg?.model ?? null;

    // Credential presence for the configured (or default OpenAI) provider.
    const credProvider = provider ?? 'openai';
    const cred = await this.prisma.aiProviderCredential.findUnique({
      where: { provider: credProvider },
    });
    const credentialConfigured = !!cred && cred.enabled;

    if (!credentialConfigured) {
      return {
        status: 'error',
        message: `No enabled ${credProvider} credential configured for enhancement.`,
        actionItem: 'Enable an OpenAI credential in Admin Settings → AI.',
      };
    }

    if (!provider || !model) {
      return {
        status: 'warning',
        message: 'Enhancement feature is on but no enhancement model is selected.',
        actionItem: 'Select an enhancement model in Admin Settings → AI Picture Enhancer.',
      };
    }

    return {
      status: 'ok',
      message: `AI picture enhancer ready (${provider}/${model}).`,
    };
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

  /**
   * Heavy media-compute job types a healthy external worker node must serve
   * for a fleet to substitute for the in-process worker (mode 'system'/'off').
   */
  private static readonly NODE_HEAVY_MEDIA_TYPES = ['face_detection', 'auto_tagging'];

  /**
   * Cheap DB read: online nodes with a fresh heartbeat (same staleness window
   * as the nodes checks) whose eligibleTypes cover at least one heavy media
   * compute type — i.e. nodes that can actually stand in for the worker.
   */
  private async countFreshMediaComputeNodes(): Promise<number> {
    const cutoff = new Date(Date.now() - this.nodeStaleWindowMs());
    return this.prisma.workerNode.count({
      where: {
        status: 'online',
        lastHeartbeatAt: { gte: cutoff },
        eligibleTypes: { hasSome: DoctorService.NODE_HEAVY_MEDIA_TYPES },
      },
    });
  }

  private async checkWorkerEnabled(settings: ResolvedSettings): Promise<CheckOutcome> {
    const mode = resolveWorkerMode();

    if (mode === 'all') {
      return { status: 'ok', message: 'Enrichment worker is enabled (mode: all).' };
    }

    const anyEnrichmentFeatureOn =
      settings.features?.['autoTagging'] === true ||
      settings.features?.['faceRecognition'] === true ||
      settings.features?.['burstDetection'] === true;

    // In 'system' and 'off' modes, media compute depends on an external node
    // fleet — check whether one is actually there and healthy.
    const freshNodes = await this.countFreshMediaComputeNodes();

    if (mode === 'system') {
      if (freshNodes > 0) {
        return {
          status: 'ok',
          message: `Enrichment worker is in system mode; ${freshNodes} healthy worker node(s) serving media compute.`,
        };
      }
      if (anyEnrichmentFeatureOn) {
        return {
          status: 'warning',
          message:
            'Enrichment worker is in system mode but no healthy worker nodes are registered — media enrichment jobs will not be processed.',
          actionItem:
            'Start a worker node (memoriahub node start) or set ENRICHMENT_WORKER_MODE=all.',
        };
      }
      return {
        status: 'warning',
        message:
          'Enrichment worker is in system mode with no healthy worker nodes registered (no enrichment features enabled).',
      };
    }

    // mode === 'off'
    if (freshNodes > 0) {
      return {
        status: 'warning',
        message: `Enrichment worker is off; relying entirely on ${freshNodes} external worker node(s) with no server fallback — server-only jobs (purges, sweeps, insights) will not run.`,
        actionItem:
          'Consider ENRICHMENT_WORKER_MODE=system so server-only jobs keep running on the API tier.',
      };
    }
    if (anyEnrichmentFeatureOn) {
      return {
        status: 'error',
        message:
          'Enrichment worker is off but at least one enrichment feature flag is on, and no healthy worker nodes are registered.',
        actionItem:
          'Set ENRICHMENT_WORKER_MODE=all (or =system with a running node fleet) so enrichment jobs get processed.',
      };
    }
    return { status: 'warning', message: 'Enrichment worker is off.' };
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

  // ===========================================================================
  // Worker Node checks (distributed compute fleet)
  //
  // Pure DB reads only — nodes are optional, so "none registered" is never a
  // failure. The node-reported `capabilities` JSON is treated as untrusted,
  // arbitrary shape and parsed defensively.
  // ===========================================================================

  /** Heartbeat freshness window (ms); mirrors NodesService's NODE_HEARTBEAT_STALE_SECONDS convention. */
  private nodeStaleWindowMs(): number {
    return (Number(process.env['NODE_HEARTBEAT_STALE_SECONDS']) || 60) * 1000;
  }

  private async checkNodesRegistered(): Promise<CheckOutcome> {
    const [total, online] = await Promise.all([
      this.prisma.workerNode.count(),
      this.prisma.workerNode.count({ where: { status: 'online' } }),
    ]);

    if (total === 0) {
      return {
        status: 'skipped',
        message: 'No worker nodes registered (distributed compute is optional).',
      };
    }

    return {
      status: 'ok',
      message: `${total} worker node(s) registered, ${online} online.`,
    };
  }

  private async checkNodesHeartbeat(): Promise<CheckOutcome> {
    const onlineNodes = await this.prisma.workerNode.findMany({
      where: { status: 'online' },
      select: { name: true, lastHeartbeatAt: true },
    });

    if (onlineNodes.length === 0) {
      return { status: 'skipped', message: 'No online worker nodes to check.' };
    }

    const staleMs = this.nodeStaleWindowMs();
    const now = Date.now();
    const stale = onlineNodes.filter(
      (n) => !n.lastHeartbeatAt || now - n.lastHeartbeatAt.getTime() > staleMs,
    );

    if (stale.length === 0) {
      return {
        status: 'ok',
        message: `All ${onlineNodes.length} online node(s) have reported a fresh heartbeat.`,
      };
    }

    const staleNames = stale.map((n) => n.name).join(', ');
    const windowSeconds = Math.round(staleMs / 1000);

    if (stale.length === onlineNodes.length) {
      return {
        status: 'error',
        message: `All ${onlineNodes.length} online node(s) are stale (no heartbeat within ${windowSeconds}s): ${staleNames}.`,
        actionItem:
          'Check that the node machines are awake and networked; they will be marked offline if they stay unreachable.',
      };
    }

    return {
      status: 'warning',
      message: `${stale.length} of ${onlineNodes.length} online node(s) are stale (no heartbeat within ${windowSeconds}s): ${staleNames}.`,
      actionItem: 'Check that the affected node machine(s) are awake and networked.',
    };
  }

  private async checkNodesStaleLeases(): Promise<CheckOutcome> {
    const expired = await this.prisma.enrichmentJob.count({
      where: { status: 'running', leaseExpiresAt: { lt: new Date() } },
    });

    if (expired > 0) {
      return {
        status: 'warning',
        message: `${expired} running job(s) have an expired lease (claiming node likely died).`,
        actionItem:
          'Reset stuck jobs from the Job Queue page (reset-stuck) so they are requeued for another worker or node.',
      };
    }

    return { status: 'ok', message: 'No running jobs with an expired lease.' };
  }

  private async checkNodesCapabilityHealth(): Promise<CheckOutcome> {
    const onlineNodes = await this.prisma.workerNode.findMany({
      where: { status: 'online' },
      select: { name: true, eligibleTypes: true, capabilities: true },
    });

    const reporting = onlineNodes.filter((n) => n.capabilities != null);
    if (reporting.length === 0) {
      return {
        status: 'skipped',
        message: 'No online node has reported a capability summary yet.',
      };
    }

    const degradedNodes: string[] = [];
    for (const node of reporting) {
      const degraded = this.extractDegradedCapabilities(node.capabilities, node.eligibleTypes);
      if (degraded.length > 0) {
        degradedNodes.push(`${node.name} (${degraded.join(', ')})`);
      }
    }

    if (degradedNodes.length > 0) {
      return {
        status: 'warning',
        message: `Node(s) reporting a degraded capability among their eligible job types: ${degradedNodes.join('; ')}.`,
        actionItem:
          'Run `memoriahub node doctor` on the affected machine(s) to resolve the failing capability (e.g. missing model files, ffmpeg, or OCR data).',
      };
    }

    return {
      status: 'ok',
      message: `All ${reporting.length} reporting node(s) advertise healthy capabilities.`,
    };
  }

  /**
   * Best-effort extraction of degraded/error capability names from a node's
   * arbitrary-shaped `capabilities` JSON, filtered to those backing one of the
   * node's advertised `eligibleTypes`. Handles the common shapes the node's
   * `node doctor` output may take: a flat `{ face: 'ok', ocr: 'error' }` map,
   * a `{ name: { status } }` map, or a list/report of `{ key, status }` checks.
   */
  private extractDegradedCapabilities(
    capabilities: unknown,
    eligibleTypes: string[],
  ): string[] {
    const entries = this.collectCapabilityEntries(capabilities);
    const degraded = new Set<string>();

    for (const { name, status } of entries) {
      if (!this.isDegradedStatus(status)) continue;
      if (this.capabilityBacksEligibleType(name, eligibleTypes)) {
        degraded.add(name);
      }
    }

    return [...degraded];
  }

  /** Flatten a capability summary into { name, status } pairs, tolerating several shapes. */
  private collectCapabilityEntries(
    capabilities: unknown,
  ): Array<{ name: string; status: string }> {
    const out: Array<{ name: string; status: string }> = [];
    if (capabilities == null || typeof capabilities !== 'object') return out;

    const consider = (name: unknown, status: unknown): void => {
      if (typeof name !== 'string') return;
      if (typeof status === 'string') out.push({ name, status });
    };

    // Array of checks: [{ key|name, status }, ...]
    if (Array.isArray(capabilities)) {
      for (const item of capabilities) {
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          consider(rec['key'] ?? rec['name'], rec['status']);
        }
      }
      return out;
    }

    const record = capabilities as Record<string, unknown>;

    // Nested report shapes: { checks: [...] } or { capabilities: {...}/[...] }
    if (Array.isArray(record['checks'])) {
      out.push(...this.collectCapabilityEntries(record['checks']));
    }
    if (record['capabilities'] != null && typeof record['capabilities'] === 'object') {
      out.push(...this.collectCapabilityEntries(record['capabilities']));
    }

    // Flat map: { face: 'ok' } or { face: { status: 'error' } }
    for (const [name, value] of Object.entries(record)) {
      if (name === 'checks' || name === 'capabilities') continue;
      if (typeof value === 'string') {
        consider(name, value);
      } else if (value && typeof value === 'object') {
        const rec = value as Record<string, unknown>;
        if (typeof rec['status'] === 'string') {
          consider(name, rec['status']);
        } else if (rec['operational'] === false) {
          // #148: enriched worker-node capability payload — a startup
          // operational self-test that FAILED is a degrade distinct from a
          // merely-absent package (available:false with no operational field).
          consider(name, 'error');
        }
      }
    }

    return out;
  }

  private isDegradedStatus(status: string): boolean {
    const s = status.toLowerCase();
    return s === 'error' || s === 'warning' || s === 'warn' || s === 'degraded' || s === 'fail' || s === 'failed';
  }

  /**
   * Whether a capability name backs at least one of the node's eligible job types.
   * Conservative: when the capability cannot be mapped or the node advertises no
   * eligible types, treat it as relevant so a genuine degradation is not hidden.
   */
  private capabilityBacksEligibleType(name: string, eligibleTypes: string[]): boolean {
    if (eligibleTypes.length === 0) return true;

    const capToJobTypes: Record<string, string[]> = {
      face: ['face_detection', 'video_face_detection'],
      human: ['face_detection', 'video_face_detection'],
      compreface: ['face_detection', 'video_face_detection'],
      clip: ['duplicate_detection', 'duplicate_detection_batch'],
      onnxruntime: ['duplicate_detection', 'duplicate_detection_batch'],
      ocr: ['social_media_detection'],
      tesseract: ['social_media_detection'],
      ffprobe: ['video_face_detection', 'social_media_detection'],
      ffmpeg: ['video_face_detection', 'social_media_detection'],
      sharp: [
        'face_detection',
        'auto_tagging',
        'duplicate_detection',
        'duplicate_detection_batch',
        'thumbnail_regen',
      ],
    };

    const key = Object.keys(capToJobTypes).find((k) => name.toLowerCase().includes(k));
    if (!key) return true; // unknown capability — surface it rather than silently drop

    const backedTypes = capToJobTypes[key];
    return backedTypes.some((t) => eligibleTypes.includes(t));
  }
}
