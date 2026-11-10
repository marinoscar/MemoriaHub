import { mockDeep } from 'jest-mock-extended';

/**
 * A deep mock of the database client the face slice narrows `MEMORIAHUB_PRISMA` to. Typed `any` on
 * purpose: a test mocks partial rows and calls of delegates the slice reads.
 */
export type MockPrisma = any;

/**
 * A fresh mock database client; `$transaction` is not implemented (tests that need it call
 * {@link mockPrismaTransaction}).
 */
export function createMockPrisma(): MockPrisma {
  return mockDeep<any>();
}

/**
 * Makes `$transaction` run an interactive callback against the mock itself and a batch as a
 * `Promise.all`, as the real client does.
 *
 * @param prisma - the mock.
 */
export function mockPrismaTransaction(prisma: MockPrisma): void {
  prisma.$transaction.mockImplementation(async (arg: any) => {
    if (typeof arg === 'function') return arg(prisma);
    if (Array.isArray(arg)) return Promise.all(arg);
    return arg;
  });
}
