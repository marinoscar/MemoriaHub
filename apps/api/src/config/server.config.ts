/**
 * Server configuration loaded from environment variables
 */
export interface ServerConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  host: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  corsOrigins: string[];
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

export const serverConfig: ServerConfig = {
  nodeEnv: getEnv('NODE_ENV', 'development') as ServerConfig['nodeEnv'],
  port: getEnvNumber('PORT', 3000),
  host: getEnv('HOST', '0.0.0.0'),
  logLevel: getEnv('LOG_LEVEL', 'info') as ServerConfig['logLevel'],
  corsOrigins: getEnv('CORS_ORIGINS', 'http://localhost:5173,http://localhost').split(','),
};
