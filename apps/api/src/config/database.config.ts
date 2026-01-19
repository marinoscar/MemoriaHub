/**
 * Database configuration loaded from environment variables
 */
export interface DatabaseConfig {
  connectionString: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
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

export const databaseConfig: DatabaseConfig = {
  connectionString: getEnv('DATABASE_URL', 'postgresql://memoriahub:memoriahub_dev@localhost:5432/memoriahub'),
  maxConnections: getEnvNumber('DB_MAX_CONNECTIONS', 20),
  idleTimeoutMs: getEnvNumber('DB_IDLE_TIMEOUT_MS', 30000),
  connectionTimeoutMs: getEnvNumber('DB_CONNECTION_TIMEOUT_MS', 5000),
};
