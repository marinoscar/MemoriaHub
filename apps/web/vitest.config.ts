import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// Use createRequire anchored to THIS config file's location so that Node's
// normal upward node_modules walk finds each package regardless of whether
// vitest is run from the main checkout (apps/web) or from a git worktree
// (worktrees/<name>/apps/web). The old approach used hardcoded ../../../../
// paths that only worked at worktree depth (4 levels up = repo root) but
// broke from the main checkout (4 levels up = home directory). This approach
// is depth-independent: Node walks up until it finds node_modules/<pkg> and
// always lands on the single canonical monorepo root copy, preventing the
// dual-instance React/MUI errors that occur when a worktree has its own
// local node_modules alongside the monorepo root node_modules.
const _require = createRequire(import.meta.url);

/**
 * Resolve a package's installed directory from this config's location.
 * Returns null if the package is not installed, so optional packages don't
 * crash the config — Node falls back to normal resolution for missing entries.
 */
const pkgDir = (pkg: string): string | null => {
  try {
    return dirname(_require.resolve(`${pkg}/package.json`));
  } catch {
    return null;
  }
};

/**
 * Build an alias entry only when the package resolves successfully.
 * Returns an empty object for missing packages (spread-safe).
 */
const alias = (name: string, dir: string | null): Record<string, string> =>
  dir ? { [name]: dir } : {};

const reactDir = pkgDir('react');

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    env: {
      VITE_API_BASE_URL: 'http://localhost:3000/api',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules',
        'src/__tests__',
        '**/*.d.ts',
        '**/*.config.*',
        'src/main.tsx',
      ],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': resolve(dirname(fileURLToPath(import.meta.url)), './src'),
      // Pin React, RTL, react-router, MUI, and Emotion to the single copy
      // resolved by Node's upward walk from this config file. This prevents
      // dual-instance errors (two React runtimes) when a worktree has its
      // own local node_modules alongside the monorepo root node_modules.
      // Works from both the main checkout and any worktree depth.
      ...alias('react', reactDir),
      ...alias('react-dom', pkgDir('react-dom')),
      // Subpath aliases derived from the resolved react dir (not a separate
      // require.resolve of the subpath, since some packages don't export
      // package.json for subpaths).
      ...(reactDir ? { 'react/jsx-runtime': resolve(reactDir, 'jsx-runtime') } : {}),
      ...(reactDir ? { 'react/jsx-dev-runtime': resolve(reactDir, 'jsx-dev-runtime') } : {}),
      ...alias('@testing-library/react', pkgDir('@testing-library/react')),
      ...alias('@testing-library/user-event', pkgDir('@testing-library/user-event')),
      ...alias('@testing-library/dom', pkgDir('@testing-library/dom')),
      ...alias('@testing-library/jest-dom', pkgDir('@testing-library/jest-dom')),
      ...alias('react-router', pkgDir('react-router')),
      ...alias('react-router-dom', pkgDir('react-router-dom')),
      ...alias('@mui/material', pkgDir('@mui/material')),
      ...alias('@mui/system', pkgDir('@mui/system')),
      ...alias('@mui/icons-material', pkgDir('@mui/icons-material')),
      ...alias('@mui/utils', pkgDir('@mui/utils')),
      ...alias('@mui/styled-engine', pkgDir('@mui/styled-engine')),
      ...alias('@mui/private-theming', pkgDir('@mui/private-theming')),
      ...alias('@emotion/react', pkgDir('@emotion/react')),
      ...alias('@emotion/styled', pkgDir('@emotion/styled')),
    },
    dedupe: [
      'react', 'react-dom',
      '@testing-library/react',
      'react-router', 'react-router-dom',
      '@mui/material', '@mui/system', '@mui/icons-material',
      '@mui/utils', '@mui/styled-engine', '@mui/private-theming',
      '@emotion/react', '@emotion/styled',
    ],
  },
});
