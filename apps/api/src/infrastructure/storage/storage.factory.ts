import type { IStorageProvider } from '../../interfaces/storage/IStorageProvider.js';
import { s3StorageProvider } from './s3.provider.js';

/**
 * Storage provider types
 */
export type StorageProviderType = 's3';

/**
 * Registry of available storage providers
 */
const providers: Map<StorageProviderType, IStorageProvider> = new Map([
  ['s3', s3StorageProvider],
]);

/**
 * Get a storage provider by type
 * @param type Provider type (default: 's3')
 * @returns Storage provider instance
 * @throws Error if provider type is not found
 */
export function getStorageProvider(type: StorageProviderType = 's3'): IStorageProvider {
  const provider = providers.get(type);
  if (!provider) {
    throw new Error(`Storage provider '${type}' not found. Available providers: ${Array.from(providers.keys()).join(', ')}`);
  }
  return provider;
}

/**
 * Get the default storage provider (S3)
 * @returns Default storage provider instance
 */
export function getDefaultStorageProvider(): IStorageProvider {
  return s3StorageProvider;
}

/**
 * Register a new storage provider
 * Used for testing or adding custom providers
 * @param type Provider type identifier
 * @param provider Provider instance
 */
export function registerStorageProvider(type: StorageProviderType, provider: IStorageProvider): void {
  providers.set(type, provider);
}

/**
 * Get all available storage provider types
 * @returns Array of provider type identifiers
 */
export function getAvailableStorageProviders(): StorageProviderType[] {
  return Array.from(providers.keys());
}
