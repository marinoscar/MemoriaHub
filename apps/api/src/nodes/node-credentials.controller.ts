// =============================================================================
// Node Credentials Controller
// =============================================================================
//
// User-facing management of worker-node credentials (`nod_` bearer tokens).
// Mounted at /api/node-credentials. Mirrors PatController.
//
// Note the asymmetry enforced by JwtAuthGuard's route allowlist: a nod_ token
// itself can NOT call these management routes — creating/listing/revoking
// credentials requires a real user session (JWT) or a PAT.
// =============================================================================

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';

import { NodeCredentialService } from './node-credential.service';
import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { CreateNodeCredentialDto } from './dto/create-node-credential.dto';
import {
  NodeCredentialCreatedResponseDto,
  NodeCredentialListItemDto,
} from './dto/node-credential-response.dto';

@ApiTags('Node Credentials')
@Controller('node-credentials')
export class NodeCredentialsController {
  constructor(private readonly nodeCredentialService: NodeCredentialService) {}

  @Post()
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new worker-node credential',
    description:
      'Mints a nod_-prefixed bearer token accepted only on /api/nodes/* routes. ' +
      'Omit expiresAt for a credential that never expires. The raw token is ' +
      'returned only once.',
  })
  @ApiResponse({
    status: 201,
    description: 'Credential created - raw token is shown only once',
    type: NodeCredentialCreatedResponseDto,
  })
  async createCredential(
    @Body() dto: CreateNodeCredentialDto,
    @CurrentUser('id') userId: string,
  ): Promise<NodeCredentialCreatedResponseDto> {
    return this.nodeCredentialService.createCredential(userId, dto);
  }

  @Get()
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @ApiOperation({ summary: 'List all worker-node credentials for current user' })
  @ApiResponse({
    status: 200,
    description: 'List of node credentials (raw tokens are never returned in list)',
    type: [NodeCredentialListItemDto],
  })
  async listCredentials(
    @CurrentUser('id') userId: string,
  ): Promise<NodeCredentialListItemDto[]> {
    const credentials = await this.nodeCredentialService.listForUser(userId);
    return credentials.map((c: typeof credentials[number]) => ({
      id: c.id,
      name: c.name,
      tokenPrefix: c.tokenPrefix,
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      lastUsedAt: c.lastUsedAt ? c.lastUsedAt.toISOString() : null,
      createdAt: c.createdAt.toISOString(),
      revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
    }));
  }

  @Delete(':id')
  @Auth({ permissions: [PERMISSIONS.JOBS_WRITE] })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a worker-node credential (soft revoke)' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 204, description: 'Credential revoked successfully' })
  @ApiResponse({ status: 404, description: 'Credential not found or already revoked' })
  async revokeCredential(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string,
  ): Promise<void> {
    await this.nodeCredentialService.revoke(userId, id);
  }
}
