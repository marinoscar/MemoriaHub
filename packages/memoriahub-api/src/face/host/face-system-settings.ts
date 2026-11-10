import { Inject, Injectable } from '@nestjs/common';

import { MEMORIAHUB_SETTINGS, type MemoriahubSettingsPort } from '../../ports/index.js';

// =============================================================================
// FaceSystemSettings: the face slice's reads and writes of the system settings
// =============================================================================
//
// The `features` flags and the `face` namespace (detection feature, providers,
// `video.*`, `autoArchive.*`), read and written through MEMORIAHUB_SETTINGS. The host
// caches the document, so a read per job is cheap.
// =============================================================================

/**
 * The part of the system settings document the slice reads.
 *
 * @stability experimental
 */
export interface FaceSettingsDocument {
  /** The `features` flags. */
  features: Record<string, boolean | undefined>;
  /** The `face` namespace. */
  face: any;
}

/**
 * Reads and writes the system settings the face slice owns.
 *
 * @stability experimental
 */
@Injectable()
export class FaceSystemSettings {
  constructor(@Inject(MEMORIAHUB_SETTINGS) private readonly settings: MemoriahubSettingsPort) {}

  /**
   * Reads the `features` and `face` namespaces.
   *
   * @returns the two namespaces.
   */
  async getSettings(): Promise<FaceSettingsDocument> {
    const [features, face] = await Promise.all([
      this.settings.readSystem<Record<string, boolean | undefined>>('features'),
      this.settings.readSystem<any>('face'),
    ]);
    return { features: features.value ?? {}, face: face.value };
  }

  /**
   * Whether a `features.<name>` flag is on.
   *
   * @param name - the flag.
   * @returns true when on.
   */
  async isFeatureEnabled(name: string): Promise<boolean> {
    const { value } = await this.settings.readSystem<Record<string, boolean | undefined>>('features');
    return value?.[name] ?? false;
  }

  /**
   * Reads only the `face` namespace.
   *
   * @returns the namespace.
   */
  async face(): Promise<any> {
    return (await this.settings.readSystem<any>('face')).value;
  }

  /**
   * Patches the `face` namespace.
   *
   * @param patch - the partial namespace.
   * @param userId - the acting user.
   */
  async patchFace(patch: Record<string, unknown>, userId: string): Promise<void> {
    await this.settings.patchSystem<any>('face', patch, { actorUserId: userId });
  }
}
