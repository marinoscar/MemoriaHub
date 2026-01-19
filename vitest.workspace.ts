import { defineWorkspace } from 'vitest/config';

/**
 * Vitest workspace configuration for MemoriaHub monorepo
 *
 * Defines all test projects that should be included when running tests.
 */
export default defineWorkspace([
  'apps/api',
  'apps/web',
  'apps/worker',
  'packages/shared',
]);
