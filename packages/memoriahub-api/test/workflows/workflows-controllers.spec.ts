/**
 * The RBAC wiring of the three workflow controllers (RETRO-J9, #622): every route is behind the auth guard with
 * the permission the route has always declared; the admin routes add the admin role. Enforcement itself is the
 * guard's (covered by auth-guard.spec.ts) and the host's integration tests.
 */
import 'reflect-metadata';

import {
  MEMORIAHUB_PERMISSIONS_KEY as PERMISSIONS_KEY,
  MEMORIAHUB_ROLES_KEY as ROLES_KEY,
} from '../../src/core/auth/memoriahub-auth.constants.js';
import { WorkflowsAdminController } from '../../src/workflows/admin/workflows-admin.controller.js';
import { WorkflowRunsController } from '../../src/workflows/runs/workflow-runs.controller.js';
import { WorkflowsController } from '../../src/workflows/workflows.controller.js';

function route(controller: { prototype: object }, name: string) {
  const handler = (controller.prototype as Record<string, unknown>)[name] as object;
  return {
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, handler) as string[] | undefined,
    roles: Reflect.getMetadata(ROLES_KEY, handler) as string[] | undefined,
    path: Reflect.getMetadata('path', handler) as string,
  };
}

describe('WorkflowsController RBAC', () => {
  it.each([
    ['create', 'media:write'],
    ['list', 'media:read'],
    ['subjects', 'media:read'],
    ['preview', 'media:read'],
    ['get', 'media:read'],
    ['update', 'media:write'],
    ['remove', 'media:write'],
    ['run', 'media:write'],
    ['runs', 'media:read'],
  ])('%s needs %s', (name, permission) => {
    const r = route(WorkflowsController, name);
    if (r.permissions === undefined) {
      // A renamed handler must fail loudly rather than pass vacuously.
      throw new Error(`no auth metadata on WorkflowsController.${name}`);
    }
    expect(r.permissions).toEqual([permission]);
    expect(r.roles).toBeUndefined();
  });
});

describe('WorkflowRunsController RBAC', () => {
  it.each([
    ['get', 'media:read'],
    ['items', 'media:read'],
    ['approve', 'media:write'],
    ['cancel', 'media:write'],
  ])('%s needs %s', (name, permission) => {
    expect(route(WorkflowRunsController, name).permissions).toEqual([permission]);
  });
});

describe('WorkflowsAdminController RBAC', () => {
  it.each([
    ['stats', 'system_settings:read'],
    ['listWorkflows', 'system_settings:read'],
    ['listRuns', 'jobs:read'],
    ['disableWorkflow', 'system_settings:write'],
    ['cancelRun', 'jobs:write'],
  ])('%s needs the admin role and %s', (name, permission) => {
    const r = route(WorkflowsAdminController, name);
    expect(r.roles).toEqual(['admin']);
    expect(r.permissions).toEqual([permission]);
  });
});
