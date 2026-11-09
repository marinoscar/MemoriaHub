// A REAL OwnerAccessService (RETRO-I3, #573) over a PrismaService, for
// real-database specs that construct services by hand: the sharing slice's
// PrincipalGroupsProvider reads `group_members` through the app's
// SharingDataAdapter (row-level security, transaction-local scope), with the
// membership cache off so a fixture's membership change is seen at once.
import { PrincipalGroupsProvider, resolveSharingModuleOptions } from '@marinoscar/platform-api/sharing';

import { DefaultOrgId } from '../../src/common/tenancy/default-org-id';
import { OwnerAccessService } from '../../src/platform/sharing/owner-scope';
import { SHARING_MODULE_OPTIONS } from '../../src/platform/sharing/sharing.config';
import { SharingDataAdapter } from '../../src/platform/sharing/sharing-data.adapter';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { PrismaSystemService } from '../../src/prisma/prisma-system.service';

export function buildOwnerAccessService(prisma: PrismaService): OwnerAccessService {
  const options = resolveSharingModuleOptions({
    ...SHARING_MODULE_OPTIONS,
    groups: { ...SHARING_MODULE_OPTIONS.groups, membershipCacheTtlSeconds: 0 },
  });
  // Only runInOrg is used by the membership lookup; the system client is never touched.
  const data = new SharingDataAdapter(prisma, {} as PrismaSystemService);
  const groups = new PrincipalGroupsProvider(data, options);
  return new OwnerAccessService(prisma, groups, new DefaultOrgId(prisma));
}
