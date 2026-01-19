import type { OAuthProvider, OAuthProviderInfo } from '@memoriahub/shared';
import type { IOAuthProvider } from '../../../interfaces/index.js';
import { googleOAuthProvider } from './google.provider.js';
import { NotFoundError } from '../../../domain/errors/index.js';

/**
 * OAuth Provider Factory (Open/Closed Principle)
 * Add new providers here without modifying existing code
 */
const providers: Map<OAuthProvider, IOAuthProvider> = new Map([
  ['google', googleOAuthProvider],
  // Add more providers here:
  // ['microsoft', microsoftOAuthProvider],
  // ['github', githubOAuthProvider],
]);

/**
 * Get OAuth provider by ID
 * @throws NotFoundError if provider not found or not enabled
 */
export function getOAuthProvider(providerId: OAuthProvider): IOAuthProvider {
  const provider = providers.get(providerId);

  if (!provider) {
    throw new NotFoundError(`OAuth provider '${providerId}' not found`);
  }

  if (!provider.isEnabled) {
    throw new NotFoundError(`OAuth provider '${providerId}' is not configured`);
  }

  return provider;
}

/**
 * Get list of available (enabled) OAuth providers
 */
export function getAvailableProviders(): OAuthProviderInfo[] {
  const available: OAuthProviderInfo[] = [];

  for (const [id, provider] of providers.entries()) {
    if (provider.isEnabled) {
      available.push({
        id,
        name: provider.providerName,
        authUrl: `/api/auth/${id}`,
      });
    }
  }

  return available;
}

/**
 * Check if a provider is available
 */
export function isProviderAvailable(providerId: OAuthProvider): boolean {
  const provider = providers.get(providerId);
  return provider?.isEnabled ?? false;
}
