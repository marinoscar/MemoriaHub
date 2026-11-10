// =============================================================================
// Memories — admin library backfill endpoint (epic #300, issue #315)
// =============================================================================
//
// `POST /api/admin/memories/backfill` — the one write the admin settings page
// makes that is not a settings save.
//
// Guard style, response envelope and flag-off status code are copied verbatim
// from the sibling global backfills (`POST /api/admin/bursts/backfill`,
// `.../location-inference/backfill`): Admin role + `system_settings:write`,
// 400 when the feature is globally disabled, `{ data: … }` envelope, 201.
// =============================================================================

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Get,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { adminMemoriesBackfillSchema } from '@marinoscar/memoriahub-contract/memories';
import { Auth } from '@marinoscar/platform-api/identity';
import { PERMISSIONS, ROLES } from '../../common/constants/roles.constants';
import { isMemoriesEnabled } from '../../settings/feature-gates';
import { MemoryBackfillService } from './memory-backfill.service';
import { MEMORY_BACKFILL_SHARDS } from './memory-backfill.shards';
import { AppSystemSettingsService } from '../../platform/settings/app-system-settings.service';

class AdminMemoriesBackfillDto extends createZodDto(adminMemoriesBackfillSchema) {}

@ApiTags('Admin: Memories')
@ApiBearerAuth('JWT-auth')
@Controller('admin/memories')
export class AdminMemoriesController {
  constructor(
    private readonly backfillService: MemoryBackfillService,
    private readonly systemSettingsService: AppSystemSettingsService,
  ) {}

  @Get('libraries')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })
  @ApiOperation({
    summary: 'List the libraries the memories backfill can target (Admin)',
    description:
      'Every shared library (a group) by name, then every personal library by its owner, ' +
      'each with the id `POST /api/admin/memories/backfill` takes as `circleId`. ' +
      'Replaces the picker\'s former `GET /api/circles?all=true` (RETRO-I6).',
  })
  @ApiResponse({ status: 200, description: '`{ items: [{ id, kind: group|personal, name }] }`' })
  async libraries() {
    return { data: { items: await this.backfillService.listLibraries() } };
  }

  @Post('backfill')
  @Auth({ roles: [ROLES.ADMIN], permissions: [PERMISSIONS.SYSTEM_SETTINGS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Generate memories from the existing library (Admin)',
    description:
      'Enqueues the sharded `memory_generation` backfill plan for one circle ' +
      `(\`circleId\`) or for every circle when omitted — ${MEMORY_BACKFILL_SHARDS.length} ` +
      'background-priority jobs per circle, so no single job can approach the ' +
      "worker's execution timeout on a large library. Circles that already have " +
      'a `memory_generation` job pending or running are skipped and counted in ' +
      '`skipped`. Idempotent and safe to re-run: every curator write is an ' +
      'upsert keyed on (circleId, type, periodKey, subjectKey), and a memory a ' +
      'user has deleted is never resurrected. Progress is observable in ' +
      '/admin/settings/jobs under type=memory_generation.',
  })
  @ApiResponse({
    status: 201,
    description: 'Backfill jobs enqueued — `{ enqueued, circles, skipped }`',
  })
  @ApiResponse({ status: 400, description: 'Memories is disabled globally' })
  @ApiResponse({ status: 404, description: 'The requested circle does not exist' })
  async backfill(@Body() dto: AdminMemoriesBackfillDto) {
    // isMemoriesEnabled(), not isFeatureEnabled('memories'): it folds in the
    // MEMORIES_ENABLED env kill-switch, so a deployment that has hard-disabled
    // the feature cannot be made to enqueue jobs its handler would no-op.
    const settings = await this.systemSettingsService.getSettings();
    if (!isMemoriesEnabled(settings)) {
      throw new BadRequestException('Memories is disabled globally');
    }

    const result = await this.backfillService.backfillLibrary({
      ...(dto.circleId ? { circleId: dto.circleId } : {}),
    });
    return { data: result };
  }
}
