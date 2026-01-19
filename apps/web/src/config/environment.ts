/**
 * Environment configuration
 */
export const config = {
  /** API base URL */
  apiUrl: import.meta.env.VITE_API_URL || '/api',

  /** Whether we're in development mode */
  isDevelopment: import.meta.env.DEV,

  /** Whether we're in production mode */
  isProduction: import.meta.env.PROD,
} as const;
