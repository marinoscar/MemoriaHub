# Spec 11: Health Check Endpoints

**Domain:** Backend
**Agent:** `backend-dev`
**Depends On:** 04-api-core-setup
**Estimated Complexity:** Low

---

## Objective

Implement liveness and readiness health check endpoints for container orchestration and monitoring.

---

## Deliverables

### 1. File Structure

```
apps/api/src/health/
├── health.module.ts
├── health.controller.ts
└── indicators/
    └── database.indicator.ts
```

### 2. Health Controller

Create `apps/api/src/health/health.controller.ts`:

```typescript
import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
} from '@nestjs/terminus';
import { Public } from '../auth/decorators/public.decorator';
import { DatabaseHealthIndicator } from './indicators/database.indicator';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DatabaseHealthIndicator,
  ) {}

  @Get('live')
  @Public()
  @ApiOperation({
    summary: 'Liveness probe',
    description: 'Checks if the application process is running. Used by orchestrators to detect hung processes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Application is alive',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  liveness() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @Public()
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness probe',
    description: 'Checks if the application is ready to receive traffic. Includes database connectivity check.',
  })
  @ApiResponse({
    status: 200,
    description: 'Application is ready',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        info: {
          type: 'object',
          properties: {
            database: {
              type: 'object',
              properties: {
                status: { type: 'string', example: 'up' },
              },
            },
          },
        },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'Application is not ready',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'error' },
        error: {
          type: 'object',
          properties: {
            database: {
              type: 'object',
              properties: {
                status: { type: 'string', example: 'down' },
                message: { type: 'string' },
              },
            },
          },
        },
        timestamp: { type: 'string', format: 'date-time' },
      },
    },
  })
  async readiness(): Promise<HealthCheckResult & { timestamp: string }> {
    const result = await this.health.check([
      () => this.db.isHealthy('database'),
    ]);

    return {
      ...result,
      timestamp: new Date().toISOString(),
    };
  }

  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({
    summary: 'Full health check',
    description: 'Comprehensive health check including all dependencies.',
  })
  @ApiResponse({ status: 200, description: 'All checks passed' })
  @ApiResponse({ status: 503, description: 'One or more checks failed' })
  async fullHealth(): Promise<HealthCheckResult & { timestamp: string }> {
    const result = await this.health.check([
      () => this.db.isHealthy('database'),
      // Add more indicators here as needed:
      // () => this.redis.isHealthy('redis'),
      // () => this.external.isHealthy('external-api'),
    ]);

    return {
      ...result,
      timestamp: new Date().toISOString(),
    };
  }
}
```

### 3. Database Health Indicator

Create `apps/api/src/health/indicators/database.indicator.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DatabaseHealthIndicator extends HealthIndicator {
  private readonly logger = new Logger(DatabaseHealthIndicator.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const startTime = Date.now();

    try {
      // Execute simple query to verify connection
      await this.prisma.$queryRaw`SELECT 1`;

      const responseTime = Date.now() - startTime;

      return this.getStatus(key, true, {
        responseTime: `${responseTime}ms`,
      });
    } catch (error) {
      const responseTime = Date.now() - startTime;

      this.logger.error('Database health check failed', error);

      throw new HealthCheckError(
        'Database check failed',
        this.getStatus(key, false, {
          message: error instanceof Error ? error.message : 'Unknown error',
          responseTime: `${responseTime}ms`,
        }),
      );
    }
  }
}
```

### 4. Health Module

Update `apps/api/src/health/health.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.indicator';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator],
})
export class HealthModule {}
```

---

## Additional Dependencies

Add to `apps/api/package.json`:

```json
{
  "dependencies": {
    "@nestjs/terminus": "^10.x"
  }
}
```

---

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/health/live` | GET | Public | Liveness probe |
| `/api/health/ready` | GET | Public | Readiness probe (includes DB) |
| `/api/health` | GET | Public | Full health check |

---

## Response Examples

### Liveness (Always 200 if process running)

```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Readiness (200 when ready)

```json
{
  "status": "ok",
  "info": {
    "database": {
      "status": "up",
      "responseTime": "5ms"
    }
  },
  "error": {},
  "details": {
    "database": {
      "status": "up",
      "responseTime": "5ms"
    }
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Readiness (503 when not ready)

```json
{
  "status": "error",
  "info": {},
  "error": {
    "database": {
      "status": "down",
      "message": "Connection refused",
      "responseTime": "1002ms"
    }
  },
  "details": {
    "database": {
      "status": "down",
      "message": "Connection refused",
      "responseTime": "1002ms"
    }
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

---

## Docker Compose Health Check

The health endpoints integrate with Docker Compose health checks defined in `base.compose.yml`:

```yaml
services:
  api:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health/ready"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 30s
```

---

## Kubernetes Probes (Future Reference)

```yaml
livenessProbe:
  httpGet:
    path: /api/health/live
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /api/health/ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
```

---

## Liveness vs Readiness

| Probe | Purpose | Failure Action |
|-------|---------|----------------|
| Liveness | Is the process alive? | Restart container |
| Readiness | Can it handle traffic? | Remove from load balancer |

**Liveness** should be minimal - just confirms the process is running and not hung.

**Readiness** checks dependencies - confirms the app can actually serve requests.

---

## Acceptance Criteria

- [ ] `GET /api/health/live` returns 200 with status "ok"
- [ ] `GET /api/health/ready` checks database connectivity
- [ ] Ready endpoint returns 200 when database is available
- [ ] Ready endpoint returns 503 when database is unavailable
- [ ] Response includes response time for each check
- [ ] All health endpoints are public (no auth required)
- [ ] Health checks complete within reasonable timeout
- [ ] Swagger docs describe all endpoints and responses

---

## Notes

- Health endpoints must be public for orchestrator probes
- Liveness should NOT check dependencies (avoid cascading restarts)
- Readiness should check all critical dependencies
- Response time helps identify slow dependencies
- Use @nestjs/terminus for standardized health check responses
