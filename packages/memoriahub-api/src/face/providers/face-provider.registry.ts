// =============================================================================
// Face Provider Registry
// =============================================================================
//
// Central registry of all available face providers.
// To add a new provider: instantiate it and add to the map below.
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { FaceProvider } from './face-provider.interface.js';
import { ComprefaceProvider } from './compreface.provider.js';

/**
 * The face providers by key.
 *
 * @stability experimental
 */
@Injectable()
export class FaceProviderRegistry {
  private readonly providers = new Map<string, FaceProvider>([
    ['compreface', new ComprefaceProvider()],
  ]);

  /**
   * Returns a provider.
   *
   * @param key - the provider key.
   * @throws Error for an unknown key.
   */
  get(key: string): FaceProvider {
    const provider = this.providers.get(key);
    if (!provider) throw new Error(`Unknown face provider: ${key}`);
    return provider;
  }

  /**
   * The provider keys.
   */
  keys(): string[] {
    return [...this.providers.keys()];
  }
}
