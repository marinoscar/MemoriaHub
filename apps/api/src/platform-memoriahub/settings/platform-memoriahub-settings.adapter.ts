import { Injectable } from '@nestjs/common';
import { Trace } from '@marinoscar/platform-api/otel-core';
import {
  UserSettingsService,
  systemSettingsNamespaceRegistry,
  userSettingsNamespaceRegistry,
} from '@marinoscar/platform-api/settings';
import type {
  MemoriahubSettingsNamespaceDef,
  MemoriahubSettingsPort,
  MemoriahubVersionedSettings,
} from '@marinoscar/memoriahub-api/ports';

import { AppSystemSettingsService } from '../../platform/settings/app-system-settings.service';
import { UserTimeZoneService } from '../../settings/user-timezone.service';

// =============================================================================
// PlatformMemoriahubSettingsAdapter: the `MEMORIAHUB_SETTINGS` port over the platform settings slice
// (RETRO-J4, #610)
// =============================================================================
//
// Reads and writes go through MemoriaHub's `AppSystemSettingsService` (the platform service with a 5 s cache
// on the system document) and the platform `UserSettingsService` token (bound to `AppUserSettingsService`), so validation, the `If-Match` version check,
// the per-namespace `onWrite` hooks and the audit trail are the platform's.
//
// A NAMESPACE IS DECLARED BEFORE THE APPLICATION STARTS. The platform composes the settings request bodies
// and the OpenAPI document from its registries when the settings slice is created, then freezes them.
// `registerNamespace` therefore declares nothing here: it VERIFIES that the namespace is already in the
// platform registry (MemoriaHub registers its own in `app-registrations/settings.ts`) and throws a clear
// error when it is not, rather than letting a slice find out at its first read. It remembers the declared
// defaults, which a namespace nobody has written needs.
//
// The time zone is `UserTimeZoneService`: cached per user, failing OPEN to 'UTC' (a time-zone lookup must
// never be the reason a listing fails).
// =============================================================================

@Injectable()
export class PlatformMemoriahubSettingsAdapter implements MemoriahubSettingsPort {
  private readonly declared = new Map<string, MemoriahubSettingsNamespaceDef>();

  constructor(
    private readonly system: AppSystemSettingsService,
    private readonly users: UserSettingsService,
    private readonly zones: UserTimeZoneService,
  ) {}

  registerNamespace(def: MemoriahubSettingsNamespaceDef): void {
    const registry = def.scope === 'system' ? systemSettingsNamespaceRegistry : userSettingsNamespaceRegistry;
    if (!registry.has(def.name)) {
      throw new Error(
        `The ${def.scope} settings namespace "${def.name}" is not in the platform registry. ` +
          'MemoriaHub declares namespaces in apps/api/src/app-registrations/settings.ts, before the application is created.',
      );
    }
    this.declared.set(`${def.scope}:${def.name}`, def);
  }

  @Trace()
  async readSystem<T>(name: string): Promise<MemoriahubVersionedSettings<T>> {
    const document = (await this.system.getSettings()) as unknown as Record<string, unknown> & { version: number };

    return { value: (document[name] ?? this.declared.get(`system:${name}`)?.defaults) as T, version: document.version };
  }

  /**
   * The read-only read the Doctor checks use: `readKnownValue` salvages the stored document and never creates the
   * row, where `getSettings` writes the defaults on a fresh install (a check must not write).
   */
  @Trace()
  async peekSystem<T>(name: string): Promise<MemoriahubVersionedSettings<T>> {
    const document = (await this.system.readKnownValue()) as unknown as Record<string, unknown> & { version?: number };

    return { value: (document[name] ?? this.declared.get(`system:${name}`)?.defaults) as T, version: document.version ?? 0 };
  }

  @Trace()
  async patchSystem<T>(
    name: string,
    patch: Partial<T>,
    ctx: { actorUserId: string; ifMatchVersion?: number },
  ): Promise<MemoriahubVersionedSettings<T>> {
    const updated = (await this.system.patchSettings(
      { [name]: patch } as never,
      ctx.actorUserId,
      ctx.ifMatchVersion,
    )) as unknown as Record<string, unknown> & { version: number };

    return { value: updated[name] as T, version: updated.version };
  }

  @Trace()
  async readUser<T>(userId: string, name: string): Promise<T> {
    const settings = (await this.users.getSettings(userId)) as unknown as Record<string, unknown>;

    return (settings[name] ?? this.declared.get(`user:${name}`)?.defaults) as T;
  }

  @Trace()
  async patchUser<T>(userId: string, name: string, patch: Partial<T>): Promise<T> {
    const updated = (await this.users.patchSettings(userId, { [name]: patch } as never)) as unknown as Record<string, unknown>;

    return updated[name] as T;
  }

  @Trace()
  readUserTimeZone(userId: string): Promise<string> {
    return this.zones.resolveUserTimeZone(userId);
  }
}
