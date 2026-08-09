import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
} from '@nestjs/terminus';
import { Public } from '../auth/decorators/public.decorator';
import { AllowDuringMaintenance } from '../common/maintenance/allow-during-maintenance.decorator';
import { MaintenanceModeService } from '../common/maintenance/maintenance-mode.service';
import { DatabaseHealthIndicator } from './indicators/database.indicator';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DatabaseHealthIndicator,
    private readonly maintenance: MaintenanceModeService,
  ) {}

  @Get('live')
  @Public()
  // Liveness must stay 200 even during maintenance — a 503 here would make an
  // orchestrator kill the very container the admin is upgrading (issue #348).
  @AllowDuringMaintenance()
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
  // Readiness is exempt from the blanket maintenance 503 so it can answer at
  // all — but it deliberately reports NOT ready while maintenance is active,
  // so load balancers drain this instance (issue #348). See readiness() below.
  @AllowDuringMaintenance()
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
    // Maintenance mode (issue #348): report NOT ready so orchestrators and
    // load balancers stop routing traffic here, while /health/live stays 200
    // so nothing kills the container mid-upgrade. Checked BEFORE the database
    // probe on purpose — during #344's swap window the database is legitimately
    // unreachable, and the honest answer is still "in maintenance".
    if (await this.maintenance.isActive()) {
      throw new ServiceUnavailableException({
        status: 'error',
        error: {
          maintenance: {
            status: 'down',
            message: 'Application is in maintenance mode',
          },
        },
        timestamp: new Date().toISOString(),
      });
    }

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
  @AllowDuringMaintenance()
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
