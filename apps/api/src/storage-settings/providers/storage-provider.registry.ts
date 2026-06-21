// =============================================================================
// Storage Provider Registry
// =============================================================================
//
// Static descriptor list of all known storage providers.
// Mirrors ai-provider.registry.ts and face-provider.registry.ts patterns.
//
// To add a new provider: add a descriptor entry to KNOWN_STORAGE_PROVIDERS and
// add the key to the StorageProviderKey union.
// =============================================================================

export interface StorageProviderDescriptor {
  /** Unique provider key (must match system settings activeProvider value) */
  key: string;
  /** Human-readable display name */
  label: string;
  /** Whether this provider requires an API key / credential to be configured */
  requiresCredentials: boolean;
  /** Fields expected in the credential payload */
  fields: string[];
  /** Whether the endpoint field is required for this provider */
  endpointRequired: boolean;
}

export const KNOWN_STORAGE_PROVIDERS: StorageProviderDescriptor[] = [
  {
    key: 's3',
    label: 'AWS S3',
    requiresCredentials: true,
    fields: ['accessKeyId', 'secretAccessKey', 'bucket', 'region'],
    endpointRequired: false,
  },
  {
    key: 'r2',
    label: 'Cloudflare R2',
    requiresCredentials: true,
    fields: ['accessKeyId', 'secretAccessKey', 'bucket', 'region', 'endpoint'],
    endpointRequired: true,
  },
  {
    key: 'local',
    label: 'Local disk',
    requiresCredentials: false,
    fields: [],
    endpointRequired: false,
  },
];

/**
 * Return the descriptor for a given provider key, or undefined when not found.
 */
export function getStorageProviderDescriptor(
  key: string,
): StorageProviderDescriptor | undefined {
  return KNOWN_STORAGE_PROVIDERS.find(p => p.key === key);
}
