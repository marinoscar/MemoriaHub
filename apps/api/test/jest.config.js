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
  // cookie@2 is exception to the node_modules rule: it ships ESM-only
  // ("type": "module", bare `export` statements, no CJS entry point), so every
  // suite that boots a real Nest/Fastify app - i.e. all of test/**/*.integration
  // .spec.ts - died at module load with "Unexpected token 'export'" before
  // reaching a single assertion. Transforming it makes those suites loadable.
  // They still need a Postgres instance to actually pass, which is why they
  // remain excluded from test:ci (see docs/ci-known-failing-tests.md).
  transformIgnorePatterns: ['/node_modules/(?!cookie/)', '/packages/enrichment-compute/dist/'],
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
