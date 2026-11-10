import { Injectable } from '@nestjs/common';
import { isSystemAccessReason, runInOrg } from '@marinoscar/platform-api/core';
import type { SharingDataPort, SharingSystemAccessReason } from '@marinoscar/platform-api/sharing';

import { PrismaService } from '../../prisma/prisma.service';
import { PrismaSystemService } from '../../prisma/prisma-system.service';

// =============================================================================
// SHARING_DATA -> the sharing slice's way into the database (RETRO-I1, #562)
// =============================================================================
//
// `groups`, `group_members`, `group_invites` and `grants` force row-level
// security on `org_id`, so the slice has exactly two ways in, both this app's:
//
//   runInOrg     the platform's `runInOrg` over `PrismaService`: one
//                transaction whose FIRST statement sets the transaction-local
//                `app.org_id` / `app.user_id` (`set_config(..., true)`, never a
//                session `SET`). Every request-driven query.
//   runAsSystem  `PrismaSystemService.runAsSystem` (its own pool, RETRO-D1): one
//                transaction whose FIRST statement is the transaction-local
//                `set_config('app.rls_bypass', 'on', true)`, for the slice's five
//                named reasons only (`purge`, `doctor`, `retention`,
//                `link-resolution`, `invite-claim`; the last one is the invite
//                auto-accept at sign-up and sign-in, on since RETRO-I5).
// =============================================================================

@Injectable()
export class SharingDataAdapter implements SharingDataPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly system: PrismaSystemService,
  ) {}

  runInOrg<R>(scope: { orgId: string; userId?: string }, fn: (tx: unknown) => Promise<R>): Promise<R> {
    return runInOrg(
      this.prisma as never,
      scope.userId === undefined ? { orgId: scope.orgId } : { orgId: scope.orgId, userId: scope.userId },
      fn as never,
    ) as Promise<R>;
  }

  runAsSystem<R>(reason: SharingSystemAccessReason, fn: (tx: unknown) => Promise<R>): Promise<R> {
    // The platform's rule: every bypass names a registered reason.
    if (!isSystemAccessReason(reason)) {
      return Promise.reject(new Error(`SharingDataAdapter.runAsSystem: unregistered system access reason "${reason}"`));
    }
    return this.system.runAsSystem(reason, (tx) => fn(tx));
  }
}
