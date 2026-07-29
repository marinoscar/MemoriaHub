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
  // cookie@2 and @fastify/cookie are exceptions to the node_modules rule.
  //
  // cookie@2 ships ESM-only ("type": "module", bare `export` statements, no CJS
  // entry point), so every suite that boots a real Nest/Fastify app - i.e. all
  // of test/**/*.integration.spec.ts - died at module load with "Unexpected
  // token 'export'" before reaching a single assertion.
  //
  // @fastify/cookie@11.1.2 then followed cookie into ESM by switching to a
  // dynamic `await import('cookie')` (its `dynamicLoadCookie`), which fails
  // differently: "A dynamic import callback was invoked without
  // --experimental-vm-modules". Transforming it too lets ts-jest downlevel that
  // import to a require under this project's "module": "commonjs" target, so
  // the suites load without needing an experimental Node flag. This is what
  // allows apps/api to track @fastify/cookie normally instead of pinning it
  // back to 11.1.1 (see #220/#224).
  transformIgnorePatterns: [
    '/node_modules/(?!(cookie|@fastify/cookie)/)',
    '/packages/enrichment-compute/dist/',
  ],
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
    // Same nesting problem, same fix, different package: the root
    // package.json pins `overrides.sharp` (exact, for server/worker compute
    // parity) while apps/api, apps/cli and packages/enrichment-compute each
    // declare their own sharp spec. npm resolves that by giving each
    // workspace its OWN nested copy instead of one hoisted one, so
    // jest.mock('sharp') in a spec only mocked the copy apps/api resolves —
    // the shared package's dhash compute (`await import('sharp')` inside
    // packages/enrichment-compute) picked up its own nested copy, ran REAL
    // sharp against a fake test buffer, threw "unsupported image format",
    // and computeVisualHash swallowed it into null. Pin every 'sharp'
    // specifier to one copy so a single mock covers both call sites.
    '^sharp$': require.resolve('sharp'),
  },
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  globalTeardown: '<rootDir>/test/teardown.ts',
  testTimeout: 30000,
  verbose: true,
};
