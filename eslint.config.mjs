// =============================================================================
// ESLint flat config: platform-import guard for the applications (RETRO-A3)
// =============================================================================
//
// Scope is deliberately narrow: ONLY a deep-import ban on the published
// @marinoscar/platform-* and @marinoscar/memoriahub-* packages (RETRO-J1) for `apps/{api,web,cli}/src/**`. An app
// reaches a package through its `exports` map, never its `src/` or `dist/`.
// App-wide lint is not this config's job; the apps' `lint` scripts are
// unchanged. Run: `npm run check:platform-imports`.
// Adapted from the kvox precedent.
// =============================================================================

import tseslint from 'typescript-eslint';

/** Application sources the deep-import ban applies to. */
export const APP_SOURCE_FILES = ['apps/{api,web,cli}/src/**/*.{ts,tsx}'];

/** Deep-import bans on the published packages. */
export const PACKAGE_DEEP_IMPORT_PATTERNS = [
  {
    group: ['@marinoscar/platform-*/src', '@marinoscar/platform-*/src/**'],
    message: 'Import a platform package through its exports map, never its src/ folder.',
  },
  {
    group: ['@marinoscar/platform-*/dist', '@marinoscar/platform-*/dist/**'],
    message: 'Import a platform package through its exports map, never its dist/ folder.',
  },
  {
    group: ['@marinoscar/memoriahub-*/src', '@marinoscar/memoriahub-*/src/**', '@marinoscar/memoriahub-*/internal', '@marinoscar/memoriahub-*/internal/**'],
    message: 'Import a MemoriaHub package through its exports map, never its src/ or internal/ folder.',
  },
  {
    group: ['@marinoscar/memoriahub-*/dist', '@marinoscar/memoriahub-*/dist/**'],
    message: 'Import a MemoriaHub package through its exports map, never its dist/ folder.',
  },
];

// Existing `eslint-disable` comments in the apps name rules from plugins this
// config does not load; ESLint reports "Definition for rule not found" for a
// directive naming an unknown rule. Register inert stubs so they stay valid.
const noopRule = { meta: { schema: [] }, create: () => ({}) };
const stubs = (names) => ({ rules: Object.fromEntries(names.map((n) => [n, noopRule])) });
const APP_LEGACY_RULE_STUBS = {
  '@typescript-eslint': stubs([
    'no-explicit-any',
    'no-var-requires',
    'no-require-imports',
    'no-throw-literal',
    'no-unused-vars',
    'no-unsafe-return',
    'require-await',
  ]),
  'react-hooks': stubs(['exhaustive-deps']),
  react: stubs(['no-array-index-key']),
  'jsx-a11y': stubs(['click-events-have-key-events', 'no-static-element-interactions']),
};

/**
 * Sources of the MemoriaHub domain packages. The platform-free rule
 * (check:memoriahub-slice-peers, rule 6) and the slice graph are enforced by the
 * script; this config adds the import ban the script cannot express: a package
 * source never reaches into another package's src/ or dist/, and never imports
 * the platform at all (compute and the other host-neutral packages).
 */
export const MEMORIAHUB_PACKAGE_SOURCE_FILES = ['packages/memoriahub-*/src/**/*.{ts,tsx}'];

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'] },
  {
    files: MEMORIAHUB_PACKAGE_SOURCE_FILES,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...PACKAGE_DEEP_IMPORT_PATTERNS,
            {
              group: ['@marinoscar/platform-*', '@marinoscar/platform-*/**'],
              message: 'A MemoriaHub domain package is host-neutral: bind the platform in the app, behind a port (ADR-0001).',
            },
            { group: ['@app/shared', '@app/shared/**'], message: 'A package never imports an application workspace.' },
          ],
        },
      ],
    },
  },
  {
    files: APP_SOURCE_FILES,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: APP_LEGACY_RULE_STUBS,
    rules: {
      'no-restricted-imports': ['error', { patterns: PACKAGE_DEEP_IMPORT_PATTERNS }],
    },
  },
];
