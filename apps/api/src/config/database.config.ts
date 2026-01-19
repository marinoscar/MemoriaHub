/**
 * Database configuration loaded from environment variables
 *
 * Supports two modes:
 * 1. Local Docker PostgreSQL (default): Uses POSTGRES_* variables
 * 2. Cloud PostgreSQL: Set POSTGRES_HOST to your cloud server
 *
 * If POSTGRES_HOST is empty or 'localhost', uses local Docker defaults.
 * If POSTGRES_HOST is set to a cloud server, uses cloud configuration with SSL.
 */
export interface DatabaseConfig {
  connectionString: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  ssl: boolean;
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

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Build the database connection string based on environment configuration.
 *
 * Priority:
 * 1. If DATABASE_URL is explicitly set, use it directly
 * 2. If POSTGRES_HOST is set (and not localhost/empty), build cloud connection string
 * 3. Otherwise, use local Docker defaults
 */
function buildConnectionString(): { connectionString: string; ssl: boolean } {
  // If DATABASE_URL is explicitly provided, use it directly
  const explicitUrl = process.env['DATABASE_URL'];
  if (explicitUrl) {
    const ssl = explicitUrl.includes('sslmode=require') || explicitUrl.includes('ssl=true');
    return { connectionString: explicitUrl, ssl };
  }

  // Get PostgreSQL configuration
  const host = process.env['POSTGRES_HOST'] || '';
  const user = getEnv('POSTGRES_USER', 'memoriahub');
  const password = getEnv('POSTGRES_PASSWORD', 'memoriahub_dev');
  const database = getEnv('POSTGRES_DB', 'memoriahub');
  const port = getEnvNumber('POSTGRES_PORT', 5432);

  // Determine if this is a cloud connection (non-empty host that's not localhost)
  const isCloudConnection = host !== '' &&
    host !== 'localhost' &&
    host !== '127.0.0.1' &&
    host !== 'postgres'; // Docker service name

  if (isCloudConnection) {
    // Cloud connection - use SSL by default
    const sslMode = getEnvBoolean('POSTGRES_SSL', true) ? 'require' : 'disable';
    const connectionString = `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${sslMode}`;
    return { connectionString, ssl: sslMode === 'require' };
  }

  // Local Docker connection - no SSL
  const localHost = host || 'localhost';
  const connectionString = `postgresql://${user}:${password}@${localHost}:${port}/${database}`;
  return { connectionString, ssl: false };
}

const dbConnection = buildConnectionString();

export const databaseConfig: DatabaseConfig = {
  connectionString: dbConnection.connectionString,
  ssl: dbConnection.ssl,
  maxConnections: getEnvNumber('DB_MAX_CONNECTIONS', 20),
  idleTimeoutMs: getEnvNumber('DB_IDLE_TIMEOUT_MS', 30000),
  connectionTimeoutMs: getEnvNumber('DB_CONNECTION_TIMEOUT_MS', 5000),
};
