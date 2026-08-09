import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateUserSettingsDto } from '../dto/update-user-settings.dto';
import { PatchUserSettingsDto } from '../dto/update-user-settings.dto';
import {
  DEFAULT_USER_SETTINGS,
  DataTableLayoutValue,
  MemoriesPreferencesValue,
  NotificationPreferencesValue,
  UserSettingsValue,
} from '../../common/types/settings.types';
import {
  DATA_TABLE_MAX_TABLES,
  MemoriesPreferencesPatch,
  NotificationPreferencesPatch,
  userSettingsSchema,
} from '../../common/schemas/settings.schema';
import { disabledNotificationTypes } from '../../notifications/notification-preferences.service';
import { NotificationsService } from '../../notifications/notifications.service';

@Injectable()
export class UserSettingsService {
  private readonly logger = new Logger(UserSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Get user settings for current user
   * Creates default settings if none exist
   */
  async getSettings(userId: string) {
    let settings = await this.prisma.userSettings.findUnique({
      where: { userId },
    });

    // Create default settings if not found
    if (!settings) {
      settings = await this.prisma.userSettings.create({
        data: {
          userId,
          value: DEFAULT_USER_SETTINGS as any,
        },
      });
      this.logger.log(`Created default settings for user: ${userId}`);
    }

    const value = settings.value as unknown as UserSettingsValue;

    return {
      theme: value.theme,
      profile: value.profile,
      search: value.search,
      // Returned verbatim, absences included — the client resolves an absent
      // namespace/entry/field against the column contract's defaults.
      dataTables: value.dataTables,
      // Same contract: absent namespace / field / type key means ENABLED (with
      // `workflowMicroRuns` the one inverted default). Never materialized here.
      notifications: value.notifications,
      // Same contract again: absent namespace / field means "no preference"
      // (nothing hidden, digest not opted out). Never materialized here.
      memories: value.memories,
      updatedAt: settings.updatedAt,
      version: settings.version,
    };
  }

  /**
   * Replace user settings (PUT)
   */
  async replaceSettings(userId: string, dto: UpdateUserSettingsDto) {
    // Validate against schema
    const validated = userSettingsSchema.parse(dto);

    const settings = await this.writeSettings(userId, validated, (tx, value) =>
      tx.userSettings.upsert({
        where: { userId },
        update: {
          value: value as any,
          version: { increment: 1 },
        },
        create: {
          userId,
          value: value as any,
        },
      }),
    );

    // Sync display name to user table if provided
    if (validated.profile.displayName !== undefined) {
      await this.syncDisplayName(userId, validated.profile.displayName);
    }

    this.logger.log(`Settings replaced for user: ${userId}`);

    const value = settings.value as unknown as UserSettingsValue;

    return {
      theme: value.theme,
      profile: value.profile,
      search: value.search,
      // Returned verbatim, absences included — the client resolves an absent
      // namespace/entry/field against the column contract's defaults.
      dataTables: value.dataTables,
      notifications: value.notifications,
      // Same contract again: absent namespace / field means "no preference"
      // (nothing hidden, digest not opted out). Never materialized here.
      memories: value.memories,
      updatedAt: settings.updatedAt,
      version: settings.version,
    };
  }

  /**
   * Partial update user settings (PATCH)
   * Uses JSON Merge Patch semantics
   */
  async patchSettings(
    userId: string,
    dto: PatchUserSettingsDto,
    expectedVersion?: number,
  ) {
    // Get current settings
    const current = await this.getSettings(userId);

    // Optimistic concurrency check
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new ConflictException(
        `Settings version mismatch. Expected ${expectedVersion}, found ${current.version}`,
      );
    }

    // Merge with existing settings
    const merged: UserSettingsValue = {
      theme: dto.theme ?? current.theme,
      profile: {
        displayName:
          dto.profile?.displayName !== undefined
            ? dto.profile.displayName
            : current.profile.displayName,
        useProviderImage:
          dto.profile?.useProviderImage !== undefined
            ? dto.profile.useProviderImage
            : current.profile.useProviderImage,
        customImageUrl:
          dto.profile?.customImageUrl !== undefined
            ? dto.profile.customImageUrl
            : current.profile.customImageUrl,
      },
      search: dto.search !== undefined
        ? { visibleFields: dto.search.visibleFields }
        : current.search,
      dataTables: this.mergeDataTables(current.dataTables, dto.dataTables),
      notifications: this.mergeNotifications(
        current.notifications,
        dto.notifications,
      ),
      memories: this.mergeMemories(current.memories, dto.memories),
    };

    // The per-table-id merge above can push the namespace past its cap even
    // when the patch payload itself was under it. Enforce the real (post-merge)
    // bound here so it surfaces as a 400 rather than a raw ZodError -> 500.
    const tableCount = Object.keys(merged.dataTables ?? {}).length;
    if (tableCount > DATA_TABLE_MAX_TABLES) {
      throw new BadRequestException(
        `dataTables may hold at most ${DATA_TABLE_MAX_TABLES} table ids (patch would produce ${tableCount})`,
      );
    }

    // Validate merged result
    const validated = userSettingsSchema.parse(merged);

    const settings = await this.writeSettings(userId, validated, (tx, value) =>
      tx.userSettings.update({
        where: { userId },
        data: {
          value: value as any,
          version: { increment: 1 },
        },
      }),
    );

    // Sync display name to user table if changed
    if (dto.profile?.displayName !== undefined) {
      await this.syncDisplayName(userId, dto.profile.displayName);
    }

    this.logger.log(`Settings patched for user: ${userId}`);

    const value = settings.value as unknown as UserSettingsValue;

    return {
      theme: value.theme,
      profile: value.profile,
      search: value.search,
      // Returned verbatim, absences included — the client resolves an absent
      // namespace/entry/field against the column contract's defaults.
      dataTables: value.dataTables,
      notifications: value.notifications,
      // Same contract again: absent namespace / field means "no preference"
      // (nothing hidden, digest not opted out). Never materialized here.
      memories: value.memories,
      updatedAt: settings.updatedAt,
      version: settings.version,
    };
  }

  /**
   * Persist a validated settings blob, keeping the #251 dismiss-on-disable
   * write ATOMIC with it.
   *
   * DECIDED BEHAVIOR (#251): turning a notification type off does not merely
   * stop new rows — it dismisses the ones already live for that user. The
   * user's intent is "stop showing me this", not "stop showing me this except
   * for the eleven already there". For a STATE type it is also the only way
   * out: #246's reconcile is gated on the same preference, so it would never
   * drain those rows to zero and they would nag forever.
   *
   * The dismissal runs inside the SAME transaction as the settings write, so
   * the two commit or roll back together — a settings save that failed after
   * dismissing would otherwise leave the rows gone and the type still on.
   *
   * A transaction is opened ONLY when something is actually suppressed: with no
   * disabled types there is nothing to keep atomic, and the common save (theme,
   * profile, a table layout) stays exactly the single statement it was.
   *
   * The suppressed set is "types disabled AFTER this write", not "types this
   * write newly disabled": dismissing an already-off type is a no-op (the gate
   * means it has no live rows), it needs no before/after diff, and it makes
   * every save self-healing.
   *
   * The preference cache is invalidated AFTER the write returns — never inside
   * the transaction, which may still roll back.
   */
  private async writeSettings<T>(
    userId: string,
    validated: UserSettingsValue,
    write: (
      client: Prisma.TransactionClient,
      value: UserSettingsValue,
    ) => Promise<T>,
  ): Promise<T> {
    const disabled = disabledNotificationTypes(validated.notifications);

    const result =
      disabled.length === 0
        ? await write(this.prisma, validated)
        : await this.prisma.$transaction(async (tx) => {
            const written = await write(tx, validated);
            await this.notifications.dismissTypesForUser(userId, disabled, tx);
            return written;
          });

    // Unconditional: cheap (two Map deletes), and it means a re-enabled type
    // starts producing again on the very next notification instead of up to one
    // 5 s TTL later.
    this.notifications.invalidatePreferences(userId);

    return result;
  }

  /**
   * Merge a PATCH's `notifications` payload into the stored namespace.
   *
   * FIELD-WISE, one level deep — and per type id inside `types`, so toggling
   * one type never clobbers another's stored value:
   *   - `notifications` absent from the patch      → stored namespace untouched;
   *   - `notifications: null`                      → namespace DELETED, i.e.
   *     reset to defaults (everything enabled, micro-runs off) rather than
   *     pinned to an all-`true` blob;
   *   - `enabled` / `workflowMicroRuns` present    → replaced;
   *   - `types: { [t]: boolean }`                  → that type replaced, others
   *     left as stored;
   *   - `types: { [t]: null }`                     → that type DELETED (JSON
   *     Merge Patch), resetting it to its default (enabled) instead of writing
   *     an explicit `true` that would survive a future default change.
   *
   * An empty result collapses back to `undefined`, because the absent namespace
   * IS the canonical "nothing persisted" state and storing `{}` is only noise.
   * Same shape, and the same reasoning, as mergeDataTables().
   */
  private mergeNotifications(
    current: NotificationPreferencesValue | undefined,
    patch: NotificationPreferencesPatch | null | undefined,
  ): NotificationPreferencesValue | undefined {
    if (patch === undefined) return current;
    if (patch === null) return undefined;

    const types: Record<string, boolean> = { ...(current?.types ?? {}) };
    if (patch.types !== undefined) {
      for (const [type, value] of Object.entries(patch.types)) {
        if (value === null || value === undefined) {
          delete types[type];
        } else {
          types[type] = value;
        }
      }
    }

    const merged: NotificationPreferencesValue = {};
    const enabled = patch.enabled !== undefined ? patch.enabled : current?.enabled;
    if (enabled !== undefined) merged.enabled = enabled;

    const microRuns =
      patch.workflowMicroRuns !== undefined
        ? patch.workflowMicroRuns
        : current?.workflowMicroRuns;
    if (microRuns !== undefined) merged.workflowMicroRuns = microRuns;

    if (Object.keys(types).length > 0) merged.types = types;

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Merge a PATCH's `memories` payload into the stored namespace (issue #307).
   *
   * FIELD-WISE, one level deep — the same shape as mergeNotifications():
   *   - `memories` absent from the patch  → stored namespace untouched;
   *   - `memories: null`                  → namespace DELETED, i.e. reset to
   *     defaults (nothing hidden, digest not opted out) rather than pinned to
   *     an explicit empty blob;
   *   - a field present                   → replaced wholesale. The two list
   *     fields are replace-not-append deliberately: "hide this person" and
   *     "un-hide this person" are the same PATCH from the client's point of
   *     view, and an append-only merge would make removal inexpressible;
   *   - a field set to `null`             → DELETED (JSON Merge Patch), which
   *     resets it to its absent default instead of writing `[]` / `false` that
   *     would survive a future default change.
   *
   * An empty result collapses back to `undefined` — the absent namespace IS
   * the canonical "nothing persisted" state, and storing `{}` is only noise.
   */
  private mergeMemories(
    current: MemoriesPreferencesValue | undefined,
    patch: MemoriesPreferencesPatch | null | undefined,
  ): MemoriesPreferencesValue | undefined {
    if (patch === undefined) return current;
    if (patch === null) return undefined;

    const merged: MemoriesPreferencesValue = { ...(current ?? {}) };

    if (patch.hiddenPersonIds !== undefined) {
      if (patch.hiddenPersonIds === null) delete merged.hiddenPersonIds;
      else merged.hiddenPersonIds = patch.hiddenPersonIds;
    }
    if (patch.hiddenDateRanges !== undefined) {
      if (patch.hiddenDateRanges === null) delete merged.hiddenDateRanges;
      else merged.hiddenDateRanges = patch.hiddenDateRanges;
    }
    if (patch.emailDigestOptOut !== undefined) {
      if (patch.emailDigestOptOut === null) delete merged.emailDigestOptOut;
      else merged.emailDigestOptOut = patch.emailDigestOptOut;
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Merge a PATCH's `dataTables` payload into the stored namespace.
   *
   * The merge is **per table id**, one level deep:
   *   - a table id absent from the patch is left exactly as stored, so patching
   *     one table's layout never clobbers another's;
   *   - a table id present in the patch REPLACES that entry wholesale (same
   *     whole-object semantics `search` already has). This is what makes "reset
   *     this table to defaults" expressible: send `{ [tableId]: {} }` and every
   *     sub-key becomes absent again, rather than being stuck at whatever was
   *     last stored;
   *   - a table id mapped to `null` DELETES the entry (JSON Merge Patch), so a
   *     client can evict a table it no longer renders instead of holding a slot.
   *
   * An empty result collapses back to `undefined` — the namespace absent is the
   * canonical "nothing persisted" state, and storing `{}` would only be noise.
   */
  private mergeDataTables(
    current: Record<string, DataTableLayoutValue> | undefined,
    patch: Record<string, DataTableLayoutValue | null> | undefined,
  ): Record<string, DataTableLayoutValue> | undefined {
    if (patch === undefined) {
      return current;
    }

    const merged: Record<string, DataTableLayoutValue> = { ...(current ?? {}) };

    for (const [tableId, entry] of Object.entries(patch)) {
      if (entry === null) {
        delete merged[tableId];
      } else {
        merged[tableId] = entry;
      }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Sync display name from settings to user table
   */
  private async syncDisplayName(
    userId: string,
    displayName: string | undefined,
  ) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { displayName: displayName || null },
    });
  }

  /**
   * Update profile image preference
   */
  async updateProfileImage(
    userId: string,
    useProviderImage: boolean,
    customImageUrl?: string | null,
  ) {
    return this.patchSettings(userId, {
      profile: {
        useProviderImage,
        customImageUrl,
      },
    });
  }

  /**
   * Update theme preference
   */
  async updateTheme(userId: string, theme: 'light' | 'dark' | 'system') {
    return this.patchSettings(userId, { theme });
  }
}
