/** @type {import('jest').Config} */
const common = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  // The sources keep the `.js` extension on relative imports (NodeNext); map it back for ts-jest.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: { ignoreCodes: [151002] } }],
  },
  testTimeout: 30000,
};

module.exports = {
  projects: [
    { ...common, displayName: 'unit', testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'], testPathIgnorePatterns: ['\\.db\\.spec\\.ts$'] },
    { ...common, displayName: 'db', testMatch: ['<rootDir>/src/**/*.db.spec.ts', '<rootDir>/test/**/*.db.spec.ts'] },
  ],
};
