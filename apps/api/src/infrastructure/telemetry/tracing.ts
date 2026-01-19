import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { serverConfig } from '../../config/index.js';
import { logger } from '../logging/logger.js';

let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry tracing
 */
export function initTracing(): void {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  if (!otlpEndpoint) {
    logger.info('OTEL_EXPORTER_OTLP_ENDPOINT not set, tracing disabled');
    return;
  }

  const traceExporter = new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
  });

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'memoriahub-api',
      [ATTR_SERVICE_VERSION]: '0.1.0',
      'deployment.environment': serverConfig.nodeEnv,
    }),
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': {
          enabled: false, // Disable file system instrumentation (noisy)
        },
      }),
    ],
  });

  sdk.start();
  logger.info({ eventType: 'tracing.initialized', endpoint: otlpEndpoint }, 'OpenTelemetry tracing initialized');
}

/**
 * Gracefully shutdown tracing
 */
export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    try {
      await sdk.shutdown();
      logger.info({ eventType: 'tracing.shutdown' }, 'OpenTelemetry tracing shut down');
    } catch (error) {
      logger.error(
        { eventType: 'tracing.shutdown.error', error: error instanceof Error ? error.message : 'Unknown error' },
        'Error shutting down tracing'
      );
    }
  }
}
