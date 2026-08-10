import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../types/settings.types';

/** Body accepted by `PUT /api/admin/maintenance`. */
export interface SetMaintenanceInput {
  enabled: boolean;
  message?: string;
  allowAdmins?: boolean;
}

/**
 * Resolved maintenance-mode state, as returned by GET /api/admin/maintenance
 * and consumed by MaintenanceGuard.
 */
export interface MaintenanceState {
  /** The effective answer: env override ?? in-memory override ?? persisted. */
  active: boolean;
  /** Operator message shown on the maintenance screen. */
  message: string;
  /** When false, even Admin-role users are blocked. */
  allowAdmins: boolean;
  /** ISO timestamp maintenance was enabled; null when off. */
  startedAt: string | null;
  /** User id that enabled maintenance; null when off / env-forced. */
  startedById: string | null;
  /** The persisted `maintenance.enabled` value, ignoring both overrides. */
  persistedEnabled: boolean;
  /** The process-local override, or null when none is set. */
  inMemoryOverride: boolean | null;
  /** The MAINTENANCE_MODE env override, or null when unset/unrecognized. */
  envOverride: boolean | null;
}

/**
 * Parse the MAINTENANCE_MODE env var — LOCKOUT SAFEGUARD #3 (issue #348).
 *
 * Read on every call rather than cached at construction so a test (and an
 * operator using a process manager that rewrites the environment) sees the
 * current value. Recognizes only explicit `true`/`false`; anything else —
 * including an empty string — means "no override", so the persisted setting
 * governs.
 *
 * It wins over the persisted setting in BOTH directions:
 *  - `true`  forces maintenance ON at boot even when the database is
 *            unreadable and the persisted flag cannot be loaded at all.
 *  - `false` forces it OFF, which is the documented break-glass recovery
 *            from a bad `allowAdmins: false` state: set it, restart, you are
 *            back in. See docs/runbooks/maintenance-mode.md.
 */
function readEnvOverride(): boolean | null {
  const raw = process.env['MAINTENANCE_MODE'];
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

/**
 * Admin-controlled maintenance mode (issue #348).
 *
 * TWO-LAYER STATE, and the reason for each layer:
 *
 *  - PERSISTED (`system_settings.maintenance.*`) is the primary layer and is
 *    non-negotiable for the planned-upgrade use case. An in-memory-only flag
 *    would be cleared by the very container restart the admin enabled it for,
 *    so the app would come back up serving traffic mid-migration — exactly
 *    the failure this feature exists to prevent.
 *
 *  - IN-MEMORY OVERRIDE exists for issue #344's database restore cutover. The
 *    swap phase RENAMES the database out from under the running process, so
 *    for a few seconds the persisted flag lives somewhere momentarily
 *    unreadable — there is no row to read and no row to write. A process-local
 *    boolean is the only layer that still works in that window. After the swap
 *    the restored database carries whatever the flag was at backup time
 *    (normally off), which is the correct end state.
 *
 *  - ENV OVERRIDE (`MAINTENANCE_MODE`) sits above both; see readEnvOverride().
 *
 * Precedence: `env ?? inMemory ?? persisted`.
 */
@Injectable()
export class MaintenanceModeService {
  private readonly logger = new Logger(MaintenanceModeService.name);

  /**
   * Process-local override. `null` means "no override — defer to persisted".
   * Deliberately NOT persisted and NOT restored on boot; see the class doc.
   */
  private inMemoryOverride: boolean | null = null;

  /** Reason recorded alongside an in-memory enable, for getState()/logs. */
  private inMemoryReason: string | null = null;
  private inMemoryStartedAt: string | null = null;
  private inMemoryStartedById: string | null = null;

  /**
   * Process-local `allowAdmins` companion to the override above, `null` when
   * unset (defer to the persisted value).
   *
   * Exists for issue #344's swap window specifically. `allowAdmins` defaults to
   * TRUE — correct for a planned upgrade, where an admin must be able to
   * exercise the app before reopening it — but actively wrong during the few
   * seconds the database is being renamed: there is no database for an admin
   * request to reach, so letting one through produces a confusing hard error
   * rather than the honest 503 everyone else gets. Like the enabled override,
   * it lives only in memory because the persisted setting is inside the
   * database that momentarily does not exist under that name.
   */
  private inMemoryAllowAdmins: boolean | null = null;

  constructor(
    private readonly systemSettings: SystemSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * True when requests should be blocked.
   *
   * Never throws: if the persisted settings cannot be read (the #344 window,
   * or any other database outage) it falls back to the in-memory override and
   * then to "not in maintenance" — failing OPEN rather than bricking the app
   * because a settings read hiccupped. The env override is checked first
   * precisely so an operator can force the answer without a working database.
   */
  async isActive(): Promise<boolean> {
    const env = readEnvOverride();
    if (env !== null) return env;
    if (this.inMemoryOverride !== null) return this.inMemoryOverride;
    return (await this.readPersisted()).enabled;
  }

  /**
   * Full resolved state, including which layer produced the answer.
   * Backs GET /api/admin/maintenance and the guard's 503 body.
   */
  async getState(): Promise<MaintenanceState> {
    const persisted = await this.readPersisted();
    const env = readEnvOverride();
    const active = env ?? this.inMemoryOverride ?? persisted.enabled;

    // An in-memory or env enable has no persisted startedAt/message of its
    // own, so fall back to whatever the in-memory enable recorded.
    const usingInMemory = env === null && this.inMemoryOverride !== null;

    return {
      active,
      message: usingInMemory
        ? (this.inMemoryReason ?? persisted.message)
        : persisted.message,
      allowAdmins:
        usingInMemory && this.inMemoryAllowAdmins !== null
          ? this.inMemoryAllowAdmins
          : persisted.allowAdmins,
      startedAt: usingInMemory
        ? (this.inMemoryStartedAt ?? persisted.startedAt)
        : persisted.startedAt,
      startedById: usingInMemory
        ? (this.inMemoryStartedById ?? persisted.startedById)
        : persisted.startedById,
      persistedEnabled: persisted.enabled,
      inMemoryOverride: this.inMemoryOverride,
      envOverride: env,
    };
  }

  /**
   * Turn maintenance mode ON.
   *
   * Sets the in-memory override FIRST so the block takes effect synchronously
   * even if the persisted write below fails (again: #344's swap window, where
   * the database may already be gone). The persisted write is what makes the
   * flag survive the restart.
   */
  async enable(
    reason: string,
    byUserId: string | null,
    opts: { allowAdmins?: boolean } = {},
  ): Promise<MaintenanceState> {
    const startedAt = new Date().toISOString();

    this.inMemoryOverride = true;
    this.inMemoryReason = reason;
    this.inMemoryStartedAt = startedAt;
    this.inMemoryStartedById = byUserId;
    this.inMemoryAllowAdmins =
      typeof opts.allowAdmins === 'boolean' ? opts.allowAdmins : null;

    this.logger.warn(
      `Maintenance mode ENABLED by ${byUserId ?? 'system'}: ${reason || '(no message)'}`,
    );

    return this.getState();
  }

  /**
   * Turn maintenance mode OFF (clears the in-memory override).
   *
   * Note this does NOT clear a `MAINTENANCE_MODE=true` env override — that one
   * is deliberately un-clearable at runtime; it takes a config change and a
   * restart, which is what makes it a trustworthy boot-time forcing switch.
   */
  async disable(): Promise<MaintenanceState> {
    this.inMemoryOverride = false;
    this.inMemoryReason = null;
    this.inMemoryStartedAt = null;
    this.inMemoryStartedById = null;
    this.inMemoryAllowAdmins = null;

    this.logger.warn('Maintenance mode DISABLED');

    return this.getState();
  }

  /**
   * Drop the process-local override entirely so the persisted setting governs
   * again. Used after a persisted write has landed, and by #344 once its swap
   * window closes.
   */
  clearInMemoryOverride(): void {
    this.inMemoryOverride = null;
    this.inMemoryReason = null;
    this.inMemoryStartedAt = null;
    this.inMemoryStartedById = null;
    this.inMemoryAllowAdmins = null;
  }

  /**
   * Invalidate the settings cache so a toggle written through
   * SystemSettingsService is visible on the very next read rather than up to
   * SETTINGS_CACHE_TTL_MS (5 s) later.
   */
  invalidateCache(): void {
    this.systemSettings.invalidateSettingsCache();
  }

  /**
   * Admin toggle behind `PUT /api/admin/maintenance` — persists the flag AND
   * keeps the in-memory layer consistent with it.
   *
   * Order matters in each direction:
   *  - ENABLING sets the in-memory override FIRST so the block is in force
   *    the instant the call is made, before the (slower, failure-prone)
   *    database write. If the write then fails the site stays down and the
   *    error surfaces to the admin — the safe direction.
   *  - DISABLING persists FIRST and only clears the override on success, so a
   *    failed write never half-opens the site.
   *
   * After a successful write the in-memory override is dropped entirely, so
   * the persisted value becomes the single source of truth again (and so a
   * restart genuinely re-reads it rather than inheriting stale process state).
   */
  async setState(
    input: SetMaintenanceInput,
    byUserId: string,
  ): Promise<MaintenanceState> {
    const current = await this.readPersisted();
    const startedAt = input.enabled
      ? (current.startedAt ?? new Date().toISOString())
      : null;

    if (input.enabled) {
      this.inMemoryOverride = true;
      this.inMemoryReason = input.message ?? current.message;
      this.inMemoryStartedAt = startedAt;
      this.inMemoryStartedById = byUserId;
    }

    await this.systemSettings.patchSettings(
      {
        maintenance: {
          enabled: input.enabled,
          message: input.message ?? current.message,
          allowAdmins: input.allowAdmins ?? current.allowAdmins,
          startedAt,
          startedById: input.enabled ? byUserId : null,
        },
      } as any,
      byUserId,
    );

    // patchSettings already invalidates, but be explicit: a stale 5 s window
    // where the site is "still up" after an admin took it down is exactly the
    // confusion this feature exists to remove.
    this.invalidateCache();

    // Persisted value is authoritative from here on.
    this.clearInMemoryOverride();

    await this.writeAuditEvent(input, byUserId, startedAt);

    this.logger.warn(
      `Maintenance mode ${input.enabled ? 'ENABLED' : 'DISABLED'} by user ${byUserId}` +
        (input.enabled
          ? `: ${(input.message ?? current.message) || '(no message)'}`
          : ''),
    );

    return this.getState();
  }

  /**
   * Audit trail for every toggle. Best-effort: a failed audit write must not
   * undo a maintenance toggle that has already landed, so it is logged rather
   * than rethrown.
   */
  private async writeAuditEvent(
    input: SetMaintenanceInput,
    byUserId: string,
    startedAt: string | null,
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: byUserId,
          action: input.enabled ? 'maintenance:enabled' : 'maintenance:disabled',
          targetType: 'system_settings',
          targetId: 'global',
          meta: {
            enabled: input.enabled,
            message: input.message ?? null,
            allowAdmins: input.allowAdmins ?? null,
            startedAt,
          } as any,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write maintenance audit event: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Read the persisted `maintenance.*` namespace, falling back to the schema
   * defaults on any read failure. Never throws — see isActive().
   */
  private async readPersisted(): Promise<{
    enabled: boolean;
    message: string;
    allowAdmins: boolean;
    startedAt: string | null;
    startedById: string | null;
  }> {
    const defaults = DEFAULT_SYSTEM_SETTINGS.maintenance!;
    try {
      const settings = await this.systemSettings.getSettings();
      const m = settings.maintenance;
      return {
        enabled: m?.enabled ?? defaults.enabled,
        message: m?.message ?? defaults.message,
        allowAdmins: m?.allowAdmins ?? defaults.allowAdmins,
        startedAt: m?.startedAt ?? defaults.startedAt,
        startedById: m?.startedById ?? defaults.startedById,
      };
    } catch (err) {
      this.logger.warn(
        `Could not read persisted maintenance settings, using defaults: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { ...defaults };
    }
  }
}
