import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { DefaultOrgId } from '../common/tenancy/default-org-id';

@Global()
@Module({
  // PLATFORM-ADOPTION-SHIM(RETRO-D1): DefaultOrgId stamps org_id on legacy storage rows.
  providers: [PrismaService, DefaultOrgId],
  exports: [PrismaService, DefaultOrgId],
})
export class PrismaModule {}
