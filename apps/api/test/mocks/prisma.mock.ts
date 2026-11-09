import { DeepMockProxy, mockDeep, mockReset } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';

/**
 * Type-safe Prisma mock for testing
 */
export type MockPrismaClient = DeepMockProxy<PrismaClient>;
export type MockPrismaService = DeepMockProxy<PrismaClient>;

/**
 * Global Prisma mock instance
 * Use this in tests with jest-mock-extended
 */
const _prismaMock: MockPrismaClient = mockDeep<PrismaClient>();

// Export as `any` to allow flexible mocking without strict Prisma type checking
// This is intentional - tests need to mock partial responses
export const prismaMock = _prismaMock as any;

/**
 * Alias for backward compatibility
 */
export const mockPrisma = prismaMock;

/**
 * `PrismaService.forOrg` / `runInOrg` (RETRO-D1): the org-scoped client is the
 * mock itself, so a test that seeds `prismaMock.storageObject` sees the same
 * rows through the platform slices' `storageForOrg` / `storageRunInOrg`.
 */
export function installOrgScopeMocks(mock: any = prismaMock): void {
  mock.forOrg.mockImplementation(() => mock);
  mock.runInOrg.mockImplementation((_orgId: string, fn: (tx: unknown) => unknown) => fn(mock));
}

installOrgScopeMocks();

/**
 * Reset all Prisma mocks
 * Call this in beforeEach() to ensure clean state
 */
export function resetPrismaMock(): void {
  mockReset(prismaMock);
  installOrgScopeMocks();
}

/**
 * Helper to mock $transaction - executes callbacks immediately
 */
export function mockPrismaTransaction(): void {
  prismaMock.$transaction.mockImplementation(async (arg: any) => {
    if (typeof arg === 'function') {
      // Interactive transaction
      return arg(prismaMock);
    } else if (Array.isArray(arg)) {
      // Sequential operations
      return Promise.all(arg);
    }
    return arg;
  });
}

/**
 * Creates a fresh mock PrismaService for unit tests
 */
export function createMockPrismaService(): MockPrismaService {
  return mockDeep<PrismaClient>();
}
