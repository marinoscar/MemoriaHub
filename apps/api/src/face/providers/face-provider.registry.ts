// =============================================================================
// Face Provider Registry
// =============================================================================
//
// Central registry of all available face providers.
// To add a new provider: instantiate it and add to the map below.
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { FaceProvider } from './face-provider.interface';
import { ComprefaceProvider } from './compreface.provider';
import { RekognitionProvider } from './rekognition.provider';

@Injectable()
export class FaceProviderRegistry {
  private readonly providers = new Map<string, FaceProvider>([
    ['compreface', new ComprefaceProvider()],
    ['rekognition', new RekognitionProvider()],
  ]);

  get(key: string): FaceProvider {
    const provider = this.providers.get(key);
    if (!provider) throw new Error(`Unknown face provider: ${key}`);
    return provider;
  }

  keys(): string[] {
    return [...this.providers.keys()];
  }
}
