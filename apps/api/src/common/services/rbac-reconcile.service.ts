import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PERMISSION_CATALOG,
  ROLE_PERMISSION_MATRIX,
} from '../constants/rbac.catalog';

/**
 * Reconciles the RBAC catalog into the database on every API boot (issue #293).
 *
 * THE BUG THIS EXISTS TO PREVENT
 *
 * Permission rows were only ever created by `prisma/seed.ts`, which runs at
 * install time and nowhere else — `update.sh` runs `prisma migrate deploy`
 * without the seed. Any permission added after a deployment was installed
 * therefore never reached that database, and the only symptom was a runtime
 * "Missing permissions: <name>" error for whoever opened the page that needed
 * it. `email_settings:read` broke /admin/settings/email in production this way.
 *
 * Reconciling at boot closes that gap for every future permission: deploying
 * the code deploys the permission.
 *
 * ADDITIVE ONLY — WHY
 *
 * This service inserts what is missing and never deletes. It does not revoke a
 * grant that exists in the database but not in the catalog, and it never drops
 * a permission row. Dropping rows would cascade into `role_permissions` (see
 * the schema's `onDelete: Cascade`), so a catalog typo or a half-finished
 * rename could silently strip access from a live system. An unexpected grant is
 * logged as a warning instead, which is the safe direction to fail: extra
 * access is visible and correctable, revoked admin access during a deploy is an
 * outage. Removals stay deliberate — a hand-written migration.
 *
 * NEVER FATAL
 *
 * Every failure path is caught and logged rather than rethrown. An exception
 * escaping `onModuleInit` aborts Nest's bootstrap and puts the API into a
 * crash loop, which would turn a cosmetic RBAC drift into a total outage. A
 * reconcile that fails leaves the previous grants untouched, so the API is
 * never worse off than before it ran — it just logs loudly at ERROR.
 */
@Injectable()
export class RbacReconcileService implements OnModuleInit {
  private readonly logger = new Logger(RbacReconcileService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.reconcile();
    } catch (error) {
      // Deliberately swallowed — see "NEVER FATAL" above.
      this.logger.error(
        `RBAC reconcile failed; leaving existing permissions untouched. ` +
          `Admin pages may report "Missing permissions" until this is resolved. ` +
          `Cause: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Brings `permissions` and `role_permissions` in line with the catalog.
   * Public so it can be invoked directly from tests and, if ever needed, from
   * an admin/maintenance path.
   */
  async reconcile(): Promise<{
    permissionsCreated: number;
    descriptionsUpdated: number;
    grantsCreated: number;
  }> {
    const permissionsCreated = await this.reconcilePermissions();
    const descriptionsUpdated = await this.reconcileDescriptions();
    const grantsCreated = await this.reconcileRoleGrants();

    if (permissionsCreated === 0 && descriptionsUpdated === 0 && grantsCreated === 0) {
      this.logger.log(`RBAC catalog already in sync (${PERMISSION_CATALOG.length} permissions)`);
    } else {
      this.logger.log(
        `RBAC catalog reconciled: ${permissionsCreated} permission(s) created, ` +
          `${descriptionsUpdated} description(s) updated, ${grantsCreated} role grant(s) created`,
      );
    }

    return { permissionsCreated, descriptionsUpdated, grantsCreated };
  }

  /** Inserts catalog permissions that have no row yet. */
  private async reconcilePermissions(): Promise<number> {
    const existing = await this.prisma.permission.findMany({ select: { name: true } });
    const existingNames = new Set(existing.map((p) => p.name));

    const missing = PERMISSION_CATALOG.filter((p) => !existingNames.has(p.name));
    if (missing.length === 0) {
      return 0;
    }

    this.logger.log(
      `Creating ${missing.length} missing permission(s): ${missing.map((p) => p.name).join(', ')}`,
    );

    // `skipDuplicates` keeps this safe if another instance boots concurrently.
    const result = await this.prisma.permission.createMany({
      data: missing.map((p) => ({ name: p.name, description: p.description })),
      skipDuplicates: true,
    });

    return result.count;
  }

  /** Keeps stored descriptions in step with the catalog. Cosmetic but cheap. */
  private async reconcileDescriptions(): Promise<number> {
    const catalogByName = new Map(PERMISSION_CATALOG.map((p) => [p.name as string, p.description]));

    const rows = await this.prisma.permission.findMany({
      select: { name: true, description: true },
    });

    const stale = rows.filter((row) => {
      const expected = catalogByName.get(row.name);
      return expected !== undefined && expected !== row.description;
    });

    for (const row of stale) {
      await this.prisma.permission.update({
        where: { name: row.name },
        data: { description: catalogByName.get(row.name) },
      });
    }

    return stale.length;
  }

  /** Grants each role the catalog permissions it is missing. Never revokes. */
  private async reconcileRoleGrants(): Promise<number> {
    const [roles, permissions] = await Promise.all([
      this.prisma.role.findMany({ select: { id: true, name: true } }),
      this.prisma.permission.findMany({ select: { id: true, name: true } }),
    ]);

    const roleIdByName = new Map(roles.map((r) => [r.name, r.id]));
    const permissionIdByName = new Map(permissions.map((p) => [p.name, p.id]));

    const existingGrants = await this.prisma.rolePermission.findMany({
      select: { roleId: true, permissionId: true },
    });
    const existingGrantKeys = new Set(
      existingGrants.map((g) => `${g.roleId}:${g.permissionId}`),
    );

    const toCreate: Array<{ roleId: string; permissionId: string }> = [];

    for (const [roleName, permissionNames] of Object.entries(ROLE_PERMISSION_MATRIX)) {
      const roleId = roleIdByName.get(roleName);
      if (!roleId) {
        // Roles are created by the seed at install time; a missing one means a
        // broken/partial install, which this service should surface, not paper over.
        this.logger.warn(
          `Role "${roleName}" is missing from the database — skipping its grants. ` +
            `Run the seed (install-memoriahub.sh) to create the base roles.`,
        );
        continue;
      }

      for (const permissionName of permissionNames) {
        const permissionId = permissionIdByName.get(permissionName);
        if (!permissionId) {
          // reconcilePermissions() ran first, so this should be unreachable.
          this.logger.warn(
            `Permission "${permissionName}" missing after reconcile — skipping grant to "${roleName}"`,
          );
          continue;
        }

        if (!existingGrantKeys.has(`${roleId}:${permissionId}`)) {
          toCreate.push({ roleId, permissionId });
          this.logger.log(`Granting "${permissionName}" to role "${roleName}"`);
        }
      }
    }

    this.warnOnUncatalogedGrants(roles, permissions, existingGrants);

    if (toCreate.length === 0) {
      return 0;
    }

    const result = await this.prisma.rolePermission.createMany({
      data: toCreate,
      skipDuplicates: true,
    });

    return result.count;
  }

  /**
   * Reports grants present in the database but absent from the catalog. Not
   * revoked — see "ADDITIVE ONLY" above — but surfaced so drift in the other
   * direction is not invisible.
   */
  private warnOnUncatalogedGrants(
    roles: Array<{ id: string; name: string }>,
    permissions: Array<{ id: string; name: string }>,
    existingGrants: Array<{ roleId: string; permissionId: string }>,
  ): void {
    const roleNameById = new Map(roles.map((r) => [r.id, r.name]));
    const permissionNameById = new Map(permissions.map((p) => [p.id, p.name]));

    const extras: string[] = [];

    for (const grant of existingGrants) {
      const roleName = roleNameById.get(grant.roleId);
      const permissionName = permissionNameById.get(grant.permissionId);
      if (!roleName || !permissionName) {
        continue;
      }

      const cataloged = ROLE_PERMISSION_MATRIX[roleName as keyof typeof ROLE_PERMISSION_MATRIX];
      if (cataloged && !cataloged.includes(permissionName as never)) {
        extras.push(`${roleName} → ${permissionName}`);
      }
    }

    if (extras.length > 0) {
      this.logger.warn(
        `${extras.length} role grant(s) exist in the database but not in the catalog ` +
          `(left in place, remove with a migration if unintended): ${extras.join(', ')}`,
      );
    }
  }
}
