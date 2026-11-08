import { APP_SLUG } from '@app/shared';

/**
 * OpenTelemetry / logging service name. `OTEL_SERVICE_NAME` wins; the default
 * is derived from the product identity (`packages/shared/identity.json`).
 * Kept dependency-free so it is safe to import before the OTEL SDK starts.
 */
export function resolveServiceName(): string {
  return process.env.OTEL_SERVICE_NAME || `${APP_SLUG}-api`;
}
