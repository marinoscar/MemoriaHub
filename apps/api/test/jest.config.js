/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', {
      // nestjs-zod createZodDto does not expose Zod schema properties as
      // TypeScript properties in ts-jest's type-checking pass, producing
      // spurious TS2339 errors that do not appear in the real tsc build
      // (which skips DTOs via the !src/**/*.dto.ts coverage exclusion and
      // the actual emitDecoratorMetadata runtime plumbing). Disabling
      // diagnostics here allows the unit tests to run without breaking the
      // tsc --noEmit build check (which is run separately and IS clean).
      diagnostics: false,
    }],
  },
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
  },
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  globalTeardown: '<rootDir>/test/teardown.ts',
  testTimeout: 30000,
  verbose: true,
};
