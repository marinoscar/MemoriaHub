/**
 * JWT configuration loaded from environment variables
 */
export interface JwtConfig {
  secret: string;
  accessTokenExpiresIn: string;
  refreshTokenExpiresIn: string;
  issuer: string;
  audience: string;
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const jwtConfig: JwtConfig = {
  secret: getEnv('JWT_SECRET', 'dev-jwt-secret-change-in-production'),
  accessTokenExpiresIn: getEnv('JWT_ACCESS_EXPIRES_IN', '15m'),
  refreshTokenExpiresIn: getEnv('JWT_REFRESH_EXPIRES_IN', '7d'),
  issuer: getEnv('JWT_ISSUER', 'memoriahub'),
  audience: getEnv('JWT_AUDIENCE', 'memoriahub'),
};

// Validate JWT secret in production
if (process.env.NODE_ENV === 'production' && jwtConfig.secret === 'dev-jwt-secret-change-in-production') {
  throw new Error('JWT_SECRET must be set in production');
}
