// =============================================================================
// OpenTelemetry bootstrap
// =============================================================================
// `main.ts` imports this file FIRST, before Nest exists: auto-instrumentation can
// only patch modules required after the SDK starts. The SDK is the platform's
// (`@marinoscar/platform-api/otel-core/sdk`): OTLP/HTTP trace, metric and log
// exporters to the collector (`OTEL_EXPORTER_OTLP_ENDPOINT`), each behind the
// runtime telemetry gate, auto-instrumentations and a SIGTERM shutdown. Nothing
// is exported unless `OTEL_ENABLED=true`.
//
// Import the `sdk` subpath only, never the Nest-facing `otel-core` index.
// =============================================================================

import { DEFAULT_IGNORED_INCOMING_PATHS, initializeOtel } from '@marinoscar/platform-api/otel-core/sdk';

import { resolveServiceName, resolveTelemetryInstanceId } from './common/otel/telemetry-identity';

export const sdk = initializeOtel({
  serviceName: resolveServiceName(),
  instanceId: resolveTelemetryInstanceId(null),
  // SSE stream: long-lived connections would produce one giant span each.
  ignoreIncomingPaths: [...DEFAULT_IGNORED_INCOMING_PATHS, '/api/notifications/stream'],
});
