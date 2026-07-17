import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NodeCredentialService } from './node-credential.service';

/**
 * Global module for NodeCredentialService, mirroring PatModule.
 *
 * @Global so JwtAuthGuard (instantiated in every module context via the @Auth
 * decorator's UseGuards) can inject NodeCredentialService without every
 * feature module importing it — the same wiring PatService relies on. Kept
 * separate from NodesModule (which imports the heavy Enrichment/Storage/AI
 * graph) so the guard dependency stays tiny and cycle-free.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [NodeCredentialService],
  exports: [NodeCredentialService],
})
export class NodeCredentialModule {}
