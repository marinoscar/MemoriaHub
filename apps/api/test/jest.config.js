/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  // The shared parity package resolves through a workspace symlink to a real
  // path OUTSIDE node_modules, so the default /node_modules/ ignore pattern
  // misses it. Its dist output is plain prebuilt CommonJS - never transform it.
  transformIgnorePatterns: ['/node_modules/', '/packages/enrichment-compute/dist/'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/**/*.dto.ts',
    '!src/main.ts',
    '!src/**/*.spec.ts',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // packages/enrichment-compute exact-pins 'openai' (see its package.json),
    // which diverges from this app's caret range and forces npm to nest a
    // second, undeduped copy under packages/enrichment-compute/node_modules.
    // Without this mapping, jest.mock('openai') in a spec file only mocks
    // the hoisted copy apps/api resolves — the shared package's delegated
    // calls (e.g. callOpenAiVision) would resolve their own nested copy and
    // make a real network call. Force every 'openai' import to the single
    // copy this app resolves so one mock covers both call sites.
    '^openai$': require.resolve('openai'),
  },
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  globalTeardown: '<rootDir>/test/teardown.ts',
  testTimeout: 30000,
  verbose: true,
};
