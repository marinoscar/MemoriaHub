import { Injectable } from '@nestjs/common';
import type { SettingsDataPort, SettingsOrgTx } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * The settings slice's `SETTINGS_DATA` port: how it opens a transaction in one organization's
 * row-level-security scope (RETRO-B3). It is the path `/api/org-settings` takes; in
 * single-organization mode the organization is the default one and its `org_settings` row stays empty.
 *
 * Delegates to `PrismaService.runInOrg` (RETRO-D1), whose first statement writes the scope with
 * `set_config(name, value, true)` (transaction-local, never a session `SET`): the platform's RLS
 * contract.
 */
@Injectable()
export class SettingsDataAdapter implements SettingsDataPort {
  constructor(private readonly prisma: PrismaService) {}

  runInOrg<R>(
    scope: { orgId: string; userId?: string },
    fn: (tx: SettingsOrgTx) => Promise<R>,
  ): Promise<R> {
    return this.prisma.runInOrg(
      scope.orgId,
      (tx) => fn(tx as unknown as SettingsOrgTx),
      scope.userId !== undefined ? { userId: scope.userId } : {},
    );
  }
}
