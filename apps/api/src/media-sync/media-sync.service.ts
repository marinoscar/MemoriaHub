import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CircleRole, Prisma, type MediaSyncDevice, type MediaSyncDiagnosticReport, type MediaSyncRun } from '@prisma/client';

import type { AuthCredentialInfo } from '../auth/decorators/auth-credential.decorator';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { staticLogger } from '../common/logger/logger.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  type CheckinInput,
  type CheckinResult,
  type CheckinRunInput,
  type ConfigResult,
  type DeviceView,
  inventorySchema,
  type InventoryFolder,
  type MediaSyncConfig,
  type MediaSyncStats,
  type RegisterDeviceInput,
  type ReportCreatedView,
  type ReportSummaryView,
  type ReportView,
  type RunView,
  statsSchema,
  type UpdateConfigInput,
  type UploadDiagnosticsInput,
} from './dto/media-sync.dto';
import { applyCommand, applyPatch, defaultConfig, readConfig } from './media-sync-config';
import { mediaSyncRefusal } from './media-sync-refusal';
import {
  AUDIT_COMMAND,
  AUDIT_CONFIG_UPDATED,
  AUDIT_TARGET_TYPE,
  CONFIG_WRITE_ATTEMPTS,
  LAST_ERROR_MAX,
  MEDIA_SYNC_REASONS,
  type MediaSyncCommand,
  REPORTS_KEPT_PER_DEVICE,
  RUNS_KEPT_PER_DEVICE,
} from './media-sync.constants';

// =============================================================================
// MediaSyncService — the Android Media Sync device API (epic #498, issue #505)
// =============================================================================
//
// The server is the hub between the phone's native Media Sync module and the
// web: the phone registers and reports state (counts, folder inventory, runs,
// diagnostics); the web AND the phone's native screens edit a versioned
// DESIRED CONFIG and issue commands; the phone pulls the config on every
// check-in.
//
// OWNERSHIP. Owner-scoped everywhere: another user's device is a 404, never a
// 403, so ids cannot be probed.
//
// PAIRING. The phone pairs through the device flow and gets a PAT; it then
// registers (`POST /devices`, upsert on (user, installationId)) WITH that PAT,
// and the row links the PAT's id (`@AuthCredential()`). Re-pairing with a new
// PAT revokes the previously linked one in the same transaction; unpairing
// revokes the linked one. `tokenExpiresAt` comes from it.
//
// PAT SCOPING. A PAT linked to a device may write (config, commands,
// check-in, diagnostics, unpair) only THAT device: any other id is a 404, so
// one phone can never reconfigure another. A check-in must come from the
// device's own PAT. JWT (web) callers manage all of their own devices.
//
// CONFIG VERSIONING. Every desired-config change bumps `configVersion` with
// an optimistic compare-and-swap on the current version (retried), so two
// concurrent edits can never lose one another's change or reuse a version.
// The phone reports `appliedConfigVersion`; `configPending` is the gap.
//
// RETENTION. The newest {@link RUNS_KEPT_PER_DEVICE} runs and
// {@link REPORTS_KEPT_PER_DEVICE} diagnostics reports per device, trimmed in
// the inserting transaction.
//
// ⚠ NEVER LOG TOKENS. The check-in log line carries ids and counts only.
// =============================================================================

type Tx = Prisma.TransactionClient;

type DeviceWithPat = MediaSyncDevice & { pat: { expiresAt: Date; revokedAt: Date | null } | null };

const WITH_PAT = { pat: { select: { expiresAt: true, revokedAt: true } } } as const;

type CurrentRelease = { packageName: string; versionCode: number } | null;

/** The caller as the config validation needs it. */
export interface MediaSyncCaller {
  id: string;
  permissions: string[];
}

/**
 * Whether the server's current release is an update for this device. It
 * applies when the device reports no package (an older app) or the same
 * package; `updateAvailable` needs the installed versionCode to be known and
 * lower.
 */
export function updateStatus(
  device: { packageName: string | null; appVersionCode: number | null },
  release: CurrentRelease,
): { latestVersionCode: number | null; updateAvailable: boolean } {
  if (!release || (device.packageName && device.packageName !== release.packageName)) {
    return { latestVersionCode: null, updateAvailable: false };
  }
  return {
    latestVersionCode: release.versionCode,
    updateAvailable: device.appVersionCode !== null && device.appVersionCode < release.versionCode,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class MediaSyncService {
  private readonly logger = new Logger(MediaSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembership: CircleMembershipService,
  ) {}

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  /**
   * Registers (or re-registers) the caller's phone; must be called with the
   * phone's PAT (400 `PAT_REQUIRED` otherwise). A revoked device comes back
   * active. A new row gets the default config targeting the user's personal
   * circle. Two concurrent first registrations of one installation converge
   * on one row (the loser of the unique-index race retries as an update).
   */
  async register(
    userId: string,
    input: RegisterDeviceInput,
    credential: AuthCredentialInfo | null,
    now: Date = new Date(),
  ): Promise<{ device: DeviceView; created: boolean }> {
    if (credential?.kind !== 'pat') {
      throw mediaSyncRefusal(
        HttpStatus.BAD_REQUEST,
        MEDIA_SYNC_REASONS.PAT_REQUIRED,
        'Register a device with the personal access token issued to it by the device flow',
      );
    }
    const tokenId = credential.tokenId;
    const targetCircleId = await this.defaultTargetCircle(userId);

    for (let attempt = 1; ; attempt++) {
      try {
        const { device, created, repaired } = await this.prisma.$transaction((tx) =>
          this.registerInTx(tx, userId, input, tokenId, targetCircleId, now),
        );
        staticLogger.info(
          { event: 'media_sync.device.registered', userId, deviceId: device.id, reattached: !created, repaired },
          'Media sync device registered',
        );
        return { device: this.toDeviceView(device, await this.currentRelease()), created };
      } catch (error) {
        if (isUniqueViolation(error) && attempt < 3) continue;
        throw error;
      }
    }
  }

  private async registerInTx(
    tx: Tx,
    userId: string,
    input: RegisterDeviceInput,
    tokenId: string,
    targetCircleId: string,
    now: Date,
  ): Promise<{ device: DeviceWithPat; created: boolean; repaired: boolean }> {
    const where = { userId_installationId: { userId, installationId: input.installationId } };
    const existing = await tx.mediaSyncDevice.findUnique({ where, select: { patId: true } });

    // Re-pairing issues a new PAT: revoke the one this device linked before,
    // as unpairing would, so it does not stay live until it expires. Never
    // the token authenticating this request.
    const repaired = Boolean(existing?.patId && existing.patId !== tokenId);
    if (repaired) {
      await tx.personalAccessToken.updateMany({
        where: { id: existing!.patId!, userId, revokedAt: null },
        data: { revokedAt: now },
      });
    }

    // A PAT identifies exactly one device. If this token was linked to a
    // DIFFERENT installation (the app was reinstalled and re-registered with
    // the same token), that older row can no longer authenticate: retire it.
    await tx.mediaSyncDevice.updateMany({
      where: { userId, patId: tokenId, NOT: { installationId: input.installationId } },
      data: { patId: null, status: 'revoked' },
    });

    const fields = {
      name: input.name,
      manufacturer: input.manufacturer ?? null,
      model: input.model ?? null,
      androidVersion: input.androidVersion ?? null,
      sdkInt: input.sdkInt ?? null,
      appVersion: input.appVersion ?? null,
      appVersionCode: input.appVersionCode ?? null,
      packageName: input.packageName ?? null,
      signingSha256: input.signingSha256 ?? null,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      status: 'active' as const,
      patId: tokenId,
      lastSeenAt: now,
    };

    const device = await tx.mediaSyncDevice.upsert({
      where,
      create: {
        userId,
        installationId: input.installationId,
        ...fields,
        config: defaultConfig(targetCircleId) as Prisma.InputJsonObject,
      },
      update: fields,
      include: WITH_PAT,
    });
    return { device, created: existing === null, repaired };
  }

  /** The caller's devices, most recently seen first (revoked ones included). */
  async list(userId: string): Promise<DeviceView[]> {
    const [devices, release] = await Promise.all([
      this.prisma.mediaSyncDevice.findMany({
        where: { userId },
        include: WITH_PAT,
        orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.currentRelease(),
    ]);
    return devices.map((device) => this.toDeviceView(device, release));
  }

  async get(userId: string, deviceId: string): Promise<DeviceView> {
    const device = await this.findOwned(userId, deviceId);
    return this.toDeviceView(device, await this.currentRelease());
  }

  /**
   * Unpairs: the device becomes `revoked` and its linked PAT is revoked in the
   * same transaction (a revoked device must not keep a live token). Idempotent.
   */
  async unpair(
    userId: string,
    deviceId: string,
    credential: AuthCredentialInfo | null,
    now: Date = new Date(),
  ): Promise<void> {
    const device = await this.findOwnedForWrite(userId, deviceId, credential);
    await this.prisma.$transaction(async (tx) => {
      await tx.mediaSyncDevice.update({ where: { id: device.id }, data: { status: 'revoked' } });
      if (device.patId) {
        await tx.personalAccessToken.updateMany({
          where: { id: device.patId, userId, revokedAt: null },
          data: { revokedAt: now },
        });
      }
    });
    staticLogger.info({ event: 'media_sync.device.revoked', userId, deviceId: device.id }, 'Media sync device unpaired');
  }

  // ---------------------------------------------------------------------------
  // Desired config and commands
  // ---------------------------------------------------------------------------

  /**
   * Partial desired-config update from the web (JWT) or the phone (PAT).
   * `targetCircleId` needs the per-circle `collaborator` role (or the
   * super-admin bypass), else 403 `TARGET_CIRCLE_FORBIDDEN`; every folder must
   * exist in the device's last reported inventory, or in the `inventory` the
   * phone sends with the request (PAT only), else 400 `UNKNOWN_FOLDER`.
   * Folder names are taken from the inventory. Every successful PATCH bumps
   * `configVersion` by exactly one.
   */
  async updateConfig(
    caller: MediaSyncCaller,
    deviceId: string,
    input: UpdateConfigInput,
    credential: AuthCredentialInfo | null,
  ): Promise<ConfigResult> {
    const device = await this.findOwnedForWrite(caller.id, deviceId, credential);
    this.assertActive(device);

    if (input.inventory !== undefined && credential?.kind !== 'pat') {
      throw mediaSyncRefusal(
        HttpStatus.BAD_REQUEST,
        MEDIA_SYNC_REASONS.INVENTORY_NOT_ALLOWED,
        "Only the phone reports its folder inventory (send it with the device's personal access token)",
      );
    }

    if (input.targetCircleId !== undefined) {
      await this.assertCanTargetCircle(caller, input.targetCircleId);
    }

    const patch: UpdateConfigInput = { ...input };
    if (input.folders !== undefined && input.folders.length > 0) {
      const inventory = input.inventory ?? readInventory(device.inventory) ?? [];
      const names = new Map(inventory.map((folder) => [folder.bucketId, folder.name]));
      const unknown = input.folders.map((folder) => folder.bucketId).filter((id) => !names.has(id));
      if (unknown.length > 0) {
        throw mediaSyncRefusal(
          HttpStatus.BAD_REQUEST,
          MEDIA_SYNC_REASONS.UNKNOWN_FOLDER,
          'Every folder must be one the phone reported in its inventory',
          { bucketIds: unknown },
        );
      }
      // The inventory is authoritative for a folder's display name.
      patch.folders = input.folders.map((folder) => ({ bucketId: folder.bucketId, name: names.get(folder.bucketId)! }));
    }

    let changedKeys: string[] = [];
    const result = await this.writeConfig(
      device.id,
      (current) => {
        const patched = applyPatch(current, patch);
        changedKeys = patched.changedKeys;
        return patched.config;
      },
      input.inventory !== undefined ? { inventory: input.inventory as Prisma.InputJsonArray } : {},
    );

    const actor = credential?.kind === 'pat' ? 'device' : 'web';
    await this.audit(caller.id, AUDIT_CONFIG_UPDATED, device.id, {
      actor,
      configVersion: result.configVersion,
      changed: changedKeys,
    });
    staticLogger.info(
      { event: AUDIT_CONFIG_UPDATED, userId: caller.id, deviceId: device.id, configVersion: result.configVersion, actor },
      'Media sync config updated',
    );
    return result;
  }

  /**
   * `pause` / `resume` set `config.paused`; `retry_failed` / `sync_now`
   * increment their generation. Every command bumps `configVersion`, so the
   * phone sees it at its next check-in (or at once via the apply deep link).
   */
  async command(
    userId: string,
    deviceId: string,
    action: MediaSyncCommand,
    credential: AuthCredentialInfo | null,
  ): Promise<ConfigResult> {
    const device = await this.findOwnedForWrite(userId, deviceId, credential);
    this.assertActive(device);

    const result = await this.writeConfig(device.id, (current) => applyCommand(current, action));
    const actor = credential?.kind === 'pat' ? 'device' : 'web';
    await this.audit(userId, AUDIT_COMMAND, device.id, { action, actor, configVersion: result.configVersion });
    staticLogger.info(
      { event: AUDIT_COMMAND, userId, deviceId: device.id, configVersion: result.configVersion, actor, action },
      'Media sync command',
    );
    return result;
  }

  // ---------------------------------------------------------------------------
  // Check-in
  // ---------------------------------------------------------------------------

  /**
   * The phone reports its state and pulls the desired config. Must come from
   * the device's own PAT. One transaction: the device's reported fields, and
   * (when `run` is present) the run row plus the retention trim. A revoked
   * device is a 409 `DEVICE_REVOKED`.
   */
  async checkin(
    userId: string,
    deviceId: string,
    input: CheckinInput,
    credential: AuthCredentialInfo | null,
    now: Date = new Date(),
  ): Promise<CheckinResult> {
    if (credential?.kind !== 'pat') {
      throw mediaSyncRefusal(
        HttpStatus.BAD_REQUEST,
        MEDIA_SYNC_REASONS.PAT_REQUIRED,
        "A check-in is sent with the device's own personal access token",
      );
    }
    // A device-linked PAT used with another device's id is a 404 (scoping); a
    // PAT no device links (a CLI token) is not this device's credential.
    const device = await this.findOwnedForWrite(userId, deviceId, credential);
    if (device.patId !== credential.tokenId) {
      throw mediaSyncRefusal(
        HttpStatus.BAD_REQUEST,
        MEDIA_SYNC_REASONS.PAT_REQUIRED,
        "A check-in is sent with the device's own personal access token",
      );
    }
    this.assertActive(device);

    const run = input.run;
    const deviceData: Prisma.MediaSyncDeviceUpdateManyMutationInput = {
      stats: input.stats as Prisma.InputJsonObject,
      permission: input.permission,
      networkState: input.networkState,
      batteryOptimized: input.batteryOptimized,
      // The phone cannot have applied a version the server never issued.
      appliedConfigVersion: Math.min(input.appliedConfigVersion, device.configVersion),
      lastSeenAt: now,
      ...(input.inventory !== undefined ? { inventory: input.inventory as Prisma.InputJsonArray } : {}),
      ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
      ...(input.appVersionCode !== undefined ? { appVersionCode: input.appVersionCode } : {}),
      ...(run ? runStamp(run) : {}),
    };

    const stored = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.mediaSyncDevice.updateMany({
        where: { id: device.id, userId, status: 'active' },
        data: deviceData,
      });
      if (count === 0) throw this.revoked(device.id);

      if (run) {
        await tx.mediaSyncRun.create({ data: runRow(device.id, run) });
        await trimRuns(tx, device.id);
      }
      return tx.mediaSyncDevice.findUniqueOrThrow({
        where: { id: device.id },
        select: { config: true, configVersion: true, appliedConfigVersion: true },
      });
    });

    staticLogger.info(
      {
        event: 'media_sync.checkin',
        userId,
        deviceId: device.id,
        configVersion: stored.configVersion,
        appliedConfigVersion: stored.appliedConfigVersion,
        stats: { pending: input.stats.pending, failed: input.stats.failed },
        run: run ? { status: run.status, trigger: run.trigger } : null,
        permission: input.permission,
        networkState: input.networkState,
      },
      'Media sync check-in',
    );

    return {
      config: readConfig(stored.config),
      configVersion: stored.configVersion,
      serverTime: now.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Runs and diagnostics
  // ---------------------------------------------------------------------------

  async listRuns(userId: string, deviceId: string, limit: number): Promise<RunView[]> {
    const device = await this.findOwned(userId, deviceId);
    const runs = await this.prisma.mediaSyncRun.findMany({
      where: { deviceId: device.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return runs.map(toRunView);
  }

  /** Stores a diagnostics report; accepted for a revoked device too (that is when one is needed). */
  async uploadDiagnostics(
    userId: string,
    deviceId: string,
    input: UploadDiagnosticsInput,
    credential: AuthCredentialInfo | null,
  ): Promise<ReportCreatedView> {
    const device = await this.findOwnedForWrite(userId, deviceId, credential);
    const report = await this.prisma.$transaction(async (tx) => {
      const created = await tx.mediaSyncDiagnosticReport.create({
        data: {
          deviceId: device.id,
          summary: input.summary ? input.summary : null,
          report: input.report as Prisma.InputJsonObject,
        },
        select: { id: true, createdAt: true },
      });
      await trimReports(tx, device.id);
      return created;
    });
    staticLogger.info(
      {
        event: 'media_sync.diagnostics.stored',
        userId,
        deviceId: device.id,
        reportId: report.id,
        bytes: Buffer.byteLength(JSON.stringify(input.report), 'utf8'),
      },
      'Media sync diagnostics stored',
    );
    return { id: report.id, createdAt: report.createdAt.toISOString() };
  }

  async listDiagnostics(userId: string, deviceId: string, limit: number): Promise<ReportSummaryView[]> {
    const device = await this.findOwned(userId, deviceId);
    const reports = await this.prisma.mediaSyncDiagnosticReport.findMany({
      where: { deviceId: device.id },
      select: { id: true, deviceId: true, summary: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return reports.map((report) => ({ ...report, createdAt: report.createdAt.toISOString() }));
  }

  async getDiagnostics(userId: string, deviceId: string, reportId: string): Promise<ReportView> {
    const device = await this.findOwned(userId, deviceId);
    const report = await this.prisma.mediaSyncDiagnosticReport.findFirst({
      where: { id: reportId, deviceId: device.id },
    });
    if (!report) throw new NotFoundException('Diagnostics report not found');
    return toReportView(report);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private notFound(): NotFoundException {
    return new NotFoundException('Media sync device not found');
  }

  private revoked(deviceId: string): HttpException {
    return mediaSyncRefusal(HttpStatus.CONFLICT, MEDIA_SYNC_REASONS.DEVICE_REVOKED, 'This device was unpaired: pair it again', {
      deviceId,
    });
  }

  private assertActive(device: MediaSyncDevice): void {
    if (device.status === 'revoked') throw this.revoked(device.id);
  }

  private async findOwned(userId: string, deviceId: string): Promise<DeviceWithPat> {
    const device = await this.prisma.mediaSyncDevice.findFirst({ where: { id: deviceId, userId }, include: WITH_PAT });
    if (!device) throw this.notFound();
    return device;
  }

  /**
   * {@link findOwned}, plus PAT scoping: a PAT linked to a media sync device
   * may write only that device. A JWT, or a PAT no device links (a CLI
   * token), manages every device of its owner.
   */
  private async findOwnedForWrite(
    userId: string,
    deviceId: string,
    credential: AuthCredentialInfo | null,
  ): Promise<DeviceWithPat> {
    const device = await this.findOwned(userId, deviceId);
    if (credential?.kind === 'pat' && device.patId !== credential.tokenId) {
      const linked = await this.prisma.mediaSyncDevice.findFirst({
        where: { userId, patId: credential.tokenId },
        select: { id: true },
      });
      if (linked) throw this.notFound();
    }
    return device;
  }

  /**
   * The circle a new device uploads into: the user's personal circle, else
   * the oldest circle they can upload to. Every user gets a personal circle at
   * signup, so the fallback exists only for hand-made accounts.
   */
  private async defaultTargetCircle(userId: string): Promise<string> {
    const personal = await this.prisma.circle.findFirst({
      where: { ownerId: userId, isPersonal: true },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (personal) return personal.id;

    const membership = await this.prisma.circleMember.findFirst({
      where: { userId, role: { in: [CircleRole.collaborator, CircleRole.circle_admin] } },
      select: { circleId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (membership) return membership.circleId;

    throw mediaSyncRefusal(
      HttpStatus.CONFLICT,
      MEDIA_SYNC_REASONS.NO_TARGET_CIRCLE,
      'You have no circle this device could upload into',
    );
  }

  /**
   * `collaborator` on the target circle, or the super-admin bypass (the circle
   * must still exist). Every refusal, including an unknown circle, is the
   * same 403 `TARGET_CIRCLE_FORBIDDEN`, so circle ids cannot be probed.
   */
  private async assertCanTargetCircle(caller: MediaSyncCaller, circleId: string): Promise<void> {
    const forbidden = () =>
      mediaSyncRefusal(
        HttpStatus.FORBIDDEN,
        MEDIA_SYNC_REASONS.TARGET_CIRCLE_FORBIDDEN,
        'You need the collaborator role in the target circle',
        { circleId },
      );
    try {
      const { isSuperAdmin } = await this.circleMembership.assertCircleAccess(
        caller.id,
        circleId,
        caller.permissions,
        CircleRole.collaborator,
      );
      if (isSuperAdmin) {
        const circle = await this.prisma.circle.findUnique({ where: { id: circleId }, select: { id: true } });
        if (!circle) throw forbidden();
      }
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) throw forbidden();
      throw error;
    }
  }

  /**
   * Compare-and-swap on `configVersion`: read the current config, apply
   * `mutate`, and write it with `configVersion + 1` only if nobody bumped the
   * version in between (else re-read and retry). Two concurrent edits can
   * therefore never lose one another's change or share a version.
   */
  private async writeConfig(
    deviceId: string,
    mutate: (current: MediaSyncConfig) => MediaSyncConfig,
    extra: Prisma.MediaSyncDeviceUpdateManyMutationInput = {},
  ): Promise<ConfigResult> {
    for (let attempt = 1; attempt <= CONFIG_WRITE_ATTEMPTS; attempt++) {
      const row = await this.prisma.mediaSyncDevice.findUniqueOrThrow({
        where: { id: deviceId },
        select: { config: true, configVersion: true, status: true },
      });
      if (row.status === 'revoked') throw this.revoked(deviceId);

      const next = mutate(readConfig(row.config));
      const { count } = await this.prisma.mediaSyncDevice.updateMany({
        where: { id: deviceId, configVersion: row.configVersion, status: 'active' },
        data: { ...extra, config: next as Prisma.InputJsonObject, configVersion: row.configVersion + 1 },
      });
      if (count === 1) return { config: next, configVersion: row.configVersion + 1 };
    }
    throw new ConflictException('The device config is being changed concurrently; try again');
  }

  private async audit(userId: string, action: string, deviceId: string, meta: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action,
          targetType: AUDIT_TARGET_TYPE,
          targetId: deviceId,
          meta: meta as Prisma.InputJsonObject,
        },
      });
    } catch (error) {
      // An audit failure never undoes a committed config change.
      this.logger.warn(`Could not write the ${action} audit event: ${error instanceof Error ? error.message : 'error'}`);
    }
  }

  /** The server's current Android release, read directly (one indexed row). */
  private async currentRelease(): Promise<CurrentRelease> {
    return (
      (await this.prisma.androidAppRelease.findFirst({
        where: { isCurrent: true },
        select: { packageName: true, versionCode: true },
      })) ?? null
    );
  }

  private toDeviceView(device: DeviceWithPat, release: CurrentRelease): DeviceView {
    const update = updateStatus(device, release);
    return {
      id: device.id,
      installationId: device.installationId,
      name: device.name,
      manufacturer: device.manufacturer,
      model: device.model,
      androidVersion: device.androidVersion,
      sdkInt: device.sdkInt,
      appVersion: device.appVersion,
      appVersionCode: device.appVersionCode,
      packageName: device.packageName,
      timezone: device.timezone,
      latestVersionCode: update.latestVersionCode,
      updateAvailable: update.updateAvailable,
      status: device.status,
      config: readConfig(device.config),
      configVersion: device.configVersion,
      appliedConfigVersion: device.appliedConfigVersion,
      configPending: device.appliedConfigVersion < device.configVersion,
      inventory: readInventory(device.inventory),
      stats: readStats(device.stats),
      permission: (device.permission as DeviceView['permission']) ?? null,
      networkState: (device.networkState as DeviceView['networkState']) ?? null,
      batteryOptimized: device.batteryOptimized,
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      lastSyncAt: device.lastSyncAt?.toISOString() ?? null,
      lastSyncStatus: device.lastSyncStatus,
      lastError: device.lastError,
      // A revoked token no longer expires: it is gone.
      tokenExpiresAt: device.pat && !device.pat.revokedAt ? device.pat.expiresAt.toISOString() : null,
      createdAt: device.createdAt.toISOString(),
      updatedAt: device.updatedAt.toISOString(),
    };
  }
}

// =============================================================================
// Pure helpers
// =============================================================================

function readInventory(stored: unknown): InventoryFolder[] | null {
  if (stored === null || stored === undefined) return null;
  const parsed = inventorySchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

function readStats(stored: unknown): MediaSyncStats | null {
  if (stored === null || stored === undefined) return null;
  const parsed = statsSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** The device's last-sync fields a run updates. */
function runStamp(run: CheckinRunInput): Prisma.MediaSyncDeviceUpdateManyMutationInput {
  const stamp: Prisma.MediaSyncDeviceUpdateManyMutationInput = {
    lastSyncAt: new Date(run.finishedAt),
    lastSyncStatus: run.status,
  };
  if (run.status === 'ok') {
    stamp.lastError = null;
  } else if (run.status === 'failed' || run.status === 'partial') {
    const message = run.errorCode ?? run.failedSample?.find((file) => file.lastError)?.lastError ?? null;
    stamp.lastError = message ? message.slice(0, LAST_ERROR_MAX) : null;
  }
  // `skipped` / `paused` leave the previous error as it was.
  return stamp;
}

function runRow(deviceId: string, run: CheckinRunInput): Prisma.MediaSyncRunUncheckedCreateInput {
  const details: Record<string, unknown> = {};
  if (run.failedSample !== undefined) details.failedSample = run.failedSample;
  if (run.perFolder !== undefined) details.perFolder = run.perFolder;
  return {
    deviceId,
    trigger: run.trigger,
    status: run.status,
    startedAt: new Date(run.startedAt),
    finishedAt: new Date(run.finishedAt),
    filesUploaded: run.filesUploaded,
    filesFailed: run.filesFailed,
    filesDeduplicated: run.filesDeduplicated,
    bytesUploaded: BigInt(run.bytesUploaded),
    errorCode: run.errorCode ?? null,
    ...(Object.keys(details).length > 0 ? { details: details as Prisma.InputJsonObject } : {}),
  };
}

/** Keeps the newest {@link RUNS_KEPT_PER_DEVICE} runs of the device. */
async function trimRuns(tx: Tx, deviceId: string): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM "media_sync_runs"
    WHERE "device_id" = ${deviceId}::uuid
      AND "id" NOT IN (
        SELECT "id" FROM "media_sync_runs" WHERE "device_id" = ${deviceId}::uuid
        ORDER BY "created_at" DESC, "id" DESC LIMIT ${RUNS_KEPT_PER_DEVICE}
      )
  `;
}

/** Keeps the newest {@link REPORTS_KEPT_PER_DEVICE} diagnostics reports of the device. */
async function trimReports(tx: Tx, deviceId: string): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM "media_sync_diagnostic_reports"
    WHERE "device_id" = ${deviceId}::uuid
      AND "id" NOT IN (
        SELECT "id" FROM "media_sync_diagnostic_reports" WHERE "device_id" = ${deviceId}::uuid
        ORDER BY "created_at" DESC, "id" DESC LIMIT ${REPORTS_KEPT_PER_DEVICE}
      )
  `;
}

export function toRunView(run: MediaSyncRun): RunView {
  return {
    id: run.id,
    deviceId: run.deviceId,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
    filesUploaded: run.filesUploaded,
    filesFailed: run.filesFailed,
    filesDeduplicated: run.filesDeduplicated,
    bytesUploaded: run.bytesUploaded.toString(),
    errorCode: run.errorCode,
    details: (run.details ?? null) as Record<string, unknown> | null,
    createdAt: run.createdAt.toISOString(),
  };
}

export function toReportView(report: MediaSyncDiagnosticReport): ReportView {
  return {
    id: report.id,
    deviceId: report.deviceId,
    summary: report.summary,
    report: report.report as Record<string, unknown>,
    createdAt: report.createdAt.toISOString(),
  };
}
