import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { PrismaSystemService } from './prisma-system.service';
import { DefaultOrgId } from '../common/tenancy/default-org-id';

@Global()
@Module({
  // `PrismaSystemService` (RETRO-D1): the row-level-security bypass pool; who may inject it is the
  // ALLOWLIST of test/tenancy/system-injection-boundary.spec.ts.
  // `DefaultOrgId`: the organization of a write that carries none (single-organization mode).
  providers: [PrismaService, PrismaSystemService, DefaultOrgId],
  exports: [PrismaService, PrismaSystemService, DefaultOrgId],
})
export class PrismaModule {}
