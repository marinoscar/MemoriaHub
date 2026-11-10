// =============================================================================
// GET /api/nodes/models/manifest (moved from NodesController, RETRO-C2, #581)
// =============================================================================
//
// The parity model manifest a worker node downloads. An APP route under the platform's
// `/api/nodes` prefix, so a `nod_` credential reaches it. It is deliberately NOT a
// `@NodeRoute()`: the platform reserves `models/*` (`RESERVED_NODE_SUBPATHS`) and the route
// names no node, so a plain `@Auth` with the fleet's read permission is the whole contract.
// Fastify resolves the literal `models/manifest` ahead of the platform's `:id` routes.
// =============================================================================

import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth } from '@marinoscar/platform-api/identity';

import { PERMISSIONS } from '../common/constants/roles.constants';
import { NodeModelsService } from './node-models.service';

@ApiTags('Worker Nodes')
@Controller('nodes/models')
export class NodeModelsController {
  constructor(private readonly models: NodeModelsService) {}

  @Get('manifest')
  @Auth({ permissions: [PERMISSIONS.NODES_READ] })
  @ApiOperation({ summary: 'Get the parity model manifest worker nodes must download' })
  @ApiResponse({
    status: 200,
    description:
      'Bare array of parity model entries ({ name, url, sha256, bytes, targetSubdir }) — the ' +
      'CLI unwraps the { data } envelope and iterates the array directly',
  })
  getModelManifest() {
    return this.models.getModelManifest();
  }
}
