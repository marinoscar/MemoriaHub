import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isSystemAccessReason, runInOrg } from '@marinoscar/platform-api/core';
import type { SharingDataPort, SharingSystemReason } from '@marinoscar/platform-api/sharing';

import { PrismaService } from '../../prisma/prisma.service';

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
//   runAsSystem  one transaction on `PrismaService` whose FIRST statement is
//                `SELECT set_config('app.rls_bypass', 'on', true)` (a SELECT, so
//                the Doctor read-only suite sees no write when the read-only
//                check `sharing.groups.orphaned` uses it), for the slice's five
//                named reasons only (`purge`, `doctor`, `retention`,
//                `link-resolution`, `invite-claim`; the last one is used only
//                when an invite auto-accept option is on, which MemoriaHub
//                leaves off until RETRO-I5).
//
// PLATFORM-ADOPTION-SHIM(RETRO-D1): MemoriaHub has no separate
// `PrismaSystemService` (its own bypass pool) yet; it arrives with the storage
// slice, and `runAsSystem` then delegates to it. Same posture as the user-data,
// AI and db-backup host adapters (`DbBackupSystemDataAdapter` is the model).
// =============================================================================

@Injectable()
export class SharingDataAdapter implements SharingDataPort {
  constructor(private readonly prisma: PrismaService) {}

  runInOrg<R>(scope: { orgId: string; userId?: string }, fn: (tx: unknown) => Promise<R>): Promise<R> {
    return runInOrg(
      this.prisma as never,
      scope.userId === undefined ? { orgId: scope.orgId } : { orgId: scope.orgId, userId: scope.userId },
      fn as never,
    ) as Promise<R>;
  }

  runAsSystem<R>(reason: SharingSystemReason, fn: (tx: unknown) => Promise<R>): Promise<R> {
    // The platform's rule: every bypass names a registered reason.
    if (!isSystemAccessReason(reason)) {
      return Promise.reject(new Error(`SharingDataAdapter.runAsSystem: unregistered system access reason "${reason}"`));
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT set_config('app.rls_bypass', 'on', true)`);
      return fn(tx);
    });
  }
}
