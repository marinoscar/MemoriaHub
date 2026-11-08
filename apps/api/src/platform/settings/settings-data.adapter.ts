import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { SettingsDataPort, SettingsOrgTx } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * The settings slice's `SETTINGS_DATA` port: how it opens a transaction in one organization's
 * row-level-security scope (RETRO-B3). It is the path `/api/org-settings` takes; in
 * single-organization mode the organization is the default one and its `org_settings` row stays empty.
 *
 * The scope is written with `set_config(name, value, true)` as the FIRST statement of the
 * transaction (transaction-local, never a session `SET`), which is the platform's RLS contract.
 *
 * PLATFORM-ADOPTION-SHIM(RETRO-D1): the storage slice brings `PrismaService.runInOrg`; this then
 * delegates to it.
 */
@Injectable()
export class SettingsDataAdapter implements SettingsDataPort {
  constructor(private readonly prisma: PrismaService) {}

  runInOrg<R>(
    scope: { orgId: string; userId?: string },
    fn: (tx: SettingsOrgTx) => Promise<R>,
  ): Promise<R> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        SELECT set_config('app.org_id', ${scope.orgId}, true),
               set_config('app.user_id', ${scope.userId ?? ''}, true)
      `);
      return fn(tx as unknown as SettingsOrgTx);
    });
  }
}
