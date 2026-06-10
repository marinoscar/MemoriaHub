# Spec 12: API Observability

**Domain:** Backend
**Agent:** `backend-dev`
**Depends On:** 04-api-core-setup
**Estimated Complexity:** Medium

---

## Objective

Implement OpenTelemetry instrumentation for traces, metrics, and structured logging with request correlation.

---

## Deliverables

### 1. File Structure

```
apps/api/src/
├── instrumentation.ts          # OTEL SDK initialization (load first)
├── common/
│   ├── middleware/
│   │   └── request-id.middleware.ts
│   └── logger/
│       ├── logger.module.ts
│       ├── logger.service.ts
│       └── pino.config.ts
```

### 2. OpenTelemetry Initialization

Create `apps/api/src/instrumentation.ts`:

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

// Enable OTEL diagnostics in development
if (process.env.NODE_ENV === 'development' && process.env.OTEL_DEBUG === 'true') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

const isOtelEnabled = process.env.OTEL_ENABLED === 'true';

export function initializeOtel(): NodeSDK | null {
  if (!isOtelEnabled) {
    console.log('OpenTelemetry disabled (OTEL_ENABLED !== true)');
    return null;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  const serviceName = process.env.OTEL_SERVICE_NAME || 'enterprise-app-api';

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.0.1',
    [ATTR_DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${endpoint}/v1/metrics`,
      }),
      exportIntervalMillis: 60000, // Export every 60 seconds
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Customize instrumentations
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingPaths: ['/api/health/live', '/api/health/ready'],
        },
        '@opentelemetry/instrumentation-fs': {
          enabled: false, // Disable noisy FS instrumentation
        },
      }),
    ],
  });

  sdk.start();

  console.log(`OpenTelemetry initialized - exporting to ${endpoint}`);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    sdk.shutdown()
      .then(() => console.log('OpenTelemetry SDK shut down'))
      .catch((err) => console.error('Error shutting down OTEL SDK', err))
      .finally(() => process.exit(0));
  });

  return sdk;
}

// Initialize immediately when this module is loaded
const sdk = initializeOtel();

export { sdk };
```

### 3. Update Main Entry Point

Update `apps/api/src/main.ts` to load instrumentation first:

```typescript
// IMPORTANT: Load instrumentation before anything else
import './instrumentation';

import { NestFactory } from '@nestjs/core';
// ... rest of imports and bootstrap
```

### 4. Request ID Middleware

Create `apps/api/src/common/middleware/request-id.middleware.ts`:

```typescript
import { Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { trace, context } from '@opentelemetry/api';
import { randomUUID } from 'crypto';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    traceId?: string;
    spanId?: string;
  }
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: FastifyRequest, res: FastifyReply, next: () => void) {
    // Get or generate request ID
    const requestId =
      (req.headers['x-request-id'] as string) || randomUUID();

    // Get trace context from OpenTelemetry
    const activeSpan = trace.getSpan(context.active());
    const spanContext = activeSpan?.spanContext();

    // Attach to request
    req.requestId = requestId;
    if (spanContext) {
      req.traceId = spanContext.traceId;
      req.spanId = spanContext.spanId;
    }

    // Set response headers
    res.header('x-request-id', requestId);
    if (spanContext) {
      res.header('x-trace-id', spanContext.traceId);
    }

    next();
  }
}
```

### 5. Pino Logger Configuration

Create `apps/api/src/common/logger/pino.config.ts`:

```typescript
import pino from 'pino';

export const pinoConfig: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      host: bindings.hostname,
      service: process.env.OTEL_SERVICE_NAME || 'enterprise-app-api',
    }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty print in development
  transport:
    process.env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
};

export const createLogger = () => pino(pinoConfig);
```

### 6. Logger Service

Create `apps/api/src/common/logger/logger.service.ts`:

```typescript
import { Injectable, Scope, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import pino from 'pino';
import { createLogger } from './pino.config';

@Injectable({ scope: Scope.REQUEST })
export class LoggerService {
  private readonly logger: pino.Logger;

  constructor(@Inject(REQUEST) private readonly request: FastifyRequest) {
    const baseLogger = createLogger();

    // Create child logger with request context
    this.logger = baseLogger.child({
      requestId: request.requestId,
      traceId: request.traceId,
      spanId: request.spanId,
    });
  }

  trace(message: string, context?: object) {
    this.logger.trace(context, message);
  }

  debug(message: string, context?: object) {
    this.logger.debug(context, message);
  }

  info(message: string, context?: object) {
    this.logger.info(context, message);
  }

  warn(message: string, context?: object) {
    this.logger.warn(context, message);
  }

  error(message: string, error?: Error | unknown, context?: object) {
    if (error instanceof Error) {
      this.logger.error(
        { ...context, err: error },
        message,
      );
    } else {
      this.logger.error({ ...context, error }, message);
    }
  }

  fatal(message: string, error?: Error | unknown, context?: object) {
    if (error instanceof Error) {
      this.logger.fatal(
        { ...context, err: error },
        message,
      );
    } else {
      this.logger.fatal({ ...context, error }, message);
    }
  }
}

// Static logger for use outside request context
export const staticLogger = createLogger();
```

### 7. Logger Module

Create `apps/api/src/common/logger/logger.module.ts`:

```typescript
import { Global, Module } from '@nestjs/common';
import { LoggerService } from './logger.service';

@Global()
@Module({
  providers: [LoggerService],
  exports: [LoggerService],
})
export class LoggerModule {}
```

### 8. Update App Module

Update `apps/api/src/app.module.ts`:

```typescript
import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { LoggerModule } from './common/logger/logger.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
// ... other imports

@Module({
  imports: [
    // ... other modules
    LoggerModule,
  ],
  // ...
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware)
      .forRoutes('*');
  }
}
```

### 9. Custom Spans Example

Create `apps/api/src/common/decorators/trace.decorator.ts`:

```typescript
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('enterprise-app-api');

/**
 * Decorator to add tracing to a method
 */
export function Trace(spanName?: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;
    const name = spanName || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: any[]) {
      return tracer.startActiveSpan(
        name,
        { kind: SpanKind.INTERNAL },
        async (span) => {
          try {
            const result = await originalMethod.apply(this, args);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (error) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : 'Unknown error',
            });
            span.recordException(error as Error);
            throw error;
          } finally {
            span.end();
          }
        },
      );
    };

    return descriptor;
  };
}
```

Usage example:

```typescript
import { Trace } from '../common/decorators/trace.decorator';

@Injectable()
export class UsersService {
  @Trace('users.findById')
  async findById(id: string) {
    // Method is now traced
    return this.prisma.user.findUnique({ where: { id } });
  }
}
```

---

## Additional Dependencies

Add to `apps/api/package.json`:

```json
{
  "dependencies": {
    "@opentelemetry/api": "^1.x",
    "@opentelemetry/sdk-node": "^0.x",
    "@opentelemetry/auto-instrumentations-node": "^0.x",
    "@opentelemetry/exporter-trace-otlp-http": "^0.x",
    "@opentelemetry/exporter-metrics-otlp-http": "^0.x",
    "@opentelemetry/resources": "^1.x",
    "@opentelemetry/semantic-conventions": "^1.x",
    "pino": "^8.x"
  },
  "devDependencies": {
    "pino-pretty": "^10.x"
  }
}
```

---

## Environment Variables

```bash
# Enable/disable OTEL
OTEL_ENABLED=true

# OTEL collector endpoint
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318

# Service identification
OTEL_SERVICE_NAME=enterprise-app-api

# Log level
LOG_LEVEL=info

# Debug OTEL (development only)
OTEL_DEBUG=false
```

---

## Log Output Example

Development (pretty printed):
```
[10:30:00] INFO: User login successful
    requestId: "abc-123"
    traceId: "1234567890abcdef"
    userId: "user-456"
```

Production (JSON):
```json
{
  "level": "info",
  "time": "2024-01-15T10:30:00.000Z",
  "requestId": "abc-123",
  "traceId": "1234567890abcdef",
  "spanId": "fedcba0987654321",
  "service": "enterprise-app-api",
  "msg": "User login successful",
  "userId": "user-456"
}
```

---

## Trace Correlation

Logs include OpenTelemetry trace context:
- `traceId`: Correlates logs with distributed traces
- `spanId`: Identifies specific operation within trace
- `requestId`: Application-level request tracking

This enables:
1. Viewing logs for a specific trace in Uptrace
2. Jumping from logs to traces
3. Cross-service request tracking

---

## Acceptance Criteria

- [ ] OTEL SDK initializes before application starts
- [ ] Traces exported to OTEL Collector when enabled
- [ ] Metrics exported every 60 seconds
- [ ] Auto-instrumentation captures HTTP, database, and other spans
- [ ] Health check endpoints excluded from tracing
- [ ] Request ID generated/propagated for each request
- [ ] Trace ID and Span ID included in logs
- [ ] Pretty logs in development, JSON in production
- [ ] LoggerService available for request-scoped logging
- [ ] @Trace decorator adds custom spans
- [ ] Graceful OTEL shutdown on SIGTERM

---

## Notes

- `instrumentation.ts` must be imported first in `main.ts`
- Auto-instrumentation handles most tracing automatically
- Use `@Trace()` decorator for custom spans on important operations
- LoggerService is request-scoped for automatic context
- Use `staticLogger` for logging outside request context
- OTEL can be disabled via environment variable for testing
