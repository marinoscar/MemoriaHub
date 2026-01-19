/**
 * OAuth provider configuration
 */
export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  enabled: boolean;
}

export interface OAuthConfig {
  google: OAuthProviderConfig;
  microsoft: OAuthProviderConfig;
  github: OAuthProviderConfig;
  callbackBaseUrl: string;
  frontendUrl: string;
  stateSecret: string;
  stateTtlMs: number;
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    throw new Error(`Environment variable ${key} must be a number`);
  }
  return num;
}

const callbackBaseUrl = getEnv('OAUTH_CALLBACK_BASE_URL', 'http://localhost/api/auth');

export const oauthConfig: OAuthConfig = {
  google: {
    clientId: getEnv('OAUTH_GOOGLE_CLIENT_ID', ''),
    clientSecret: getEnv('OAUTH_GOOGLE_CLIENT_SECRET', ''),
    redirectUri: `${callbackBaseUrl}/google/callback`,
    enabled: !!process.env.OAUTH_GOOGLE_CLIENT_ID,
  },
  microsoft: {
    clientId: getEnv('OAUTH_MICROSOFT_CLIENT_ID', ''),
    clientSecret: getEnv('OAUTH_MICROSOFT_CLIENT_SECRET', ''),
    redirectUri: `${callbackBaseUrl}/microsoft/callback`,
    enabled: !!process.env.OAUTH_MICROSOFT_CLIENT_ID,
  },
  github: {
    clientId: getEnv('OAUTH_GITHUB_CLIENT_ID', ''),
    clientSecret: getEnv('OAUTH_GITHUB_CLIENT_SECRET', ''),
    redirectUri: `${callbackBaseUrl}/github/callback`,
    enabled: !!process.env.OAUTH_GITHUB_CLIENT_ID,
  },
  callbackBaseUrl,
  frontendUrl: getEnv('FRONTEND_URL', 'http://localhost:5173'),
  stateSecret: getEnv('OAUTH_STATE_SECRET', getEnv('JWT_SECRET', 'dev-state-secret')),
  stateTtlMs: getEnvNumber('OAUTH_STATE_TTL_MS', 600000), // 10 minutes
};
