import { config } from 'dotenv';
import { resolve } from 'path';

// Load test environment variables
config({ path: resolve(__dirname, '../.env.test') });

// Set test environment
process.env.NODE_ENV = 'test';

// No spec needs a background worker: the platform JobWorker would poll the mocked Prisma client.
// A spec that exercises the worker builds it itself. (An explicit JOBS_WORKER_MODE still wins.)
process.env.JOBS_WORKER_MODE ??= 'off';

// Owner-scope access (RETRO-I3) reads group memberships through the sharing slice's
// PrincipalGroupsProvider, which caches them per (user, org) for this TTL. Suites
// change a caller's mocked membership between tests on one app instance, so the
// cache is off in tests (0 disables it). Production keeps its TTL and invalidates
// on membership writes (`OwnerAccessService.invalidateMembers`).
process.env.AUTH_PRINCIPAL_CACHE_TTL_SECONDS ??= '0';

// Increase timeout for integration tests
jest.setTimeout(30000);

// Global test utilities
beforeAll(async () => {
  // Any global setup
});

afterAll(async () => {
  // Any global cleanup
});
