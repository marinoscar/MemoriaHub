import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

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
      '@': resolve(__dirname, './src'),
      // Pin React and RTL to the monorepo root copy to prevent dual-instance errors.
      // In a git worktree at worktrees/jobs-dashboard/, npm installs a sibling
      // node_modules/ at the worktree root, while the monorepo root also has
      // node_modules/. Vitest/vite would resolve react from the worktree and
      // react-dom from the monorepo root, causing two React instances.
      // @testing-library/react must also be pinned because it resolves react
      // at CJS runtime, bypassing Vite's module graph aliases.
      'react': resolve(__dirname, '../../../../node_modules/react'),
      'react-dom': resolve(__dirname, '../../../../node_modules/react-dom'),
      'react/jsx-runtime': resolve(__dirname, '../../../../node_modules/react/jsx-runtime'),
      'react/jsx-dev-runtime': resolve(__dirname, '../../../../node_modules/react/jsx-dev-runtime'),
      '@testing-library/react': resolve(__dirname, '../../../../node_modules/@testing-library/react'),
      '@testing-library/user-event': resolve(__dirname, '../../../../node_modules/@testing-library/user-event'),
      '@testing-library/dom': resolve(__dirname, '../../../../node_modules/@testing-library/dom'),
      '@testing-library/jest-dom': resolve(__dirname, '../../../../node_modules/@testing-library/jest-dom'),
      // Also pin react-router/react-router-dom to avoid dual-instance issues
      'react-router': resolve(__dirname, '../../../../node_modules/react-router'),
      'react-router-dom': resolve(__dirname, '../../../../node_modules/react-router-dom'),
      // Pin MUI packages — they use require('react') at CJS runtime which must
      // resolve to the same instance as the test renderer.
      '@mui/material': resolve(__dirname, '../../../../node_modules/@mui/material'),
      '@mui/system': resolve(__dirname, '../../../../node_modules/@mui/system'),
      '@mui/icons-material': resolve(__dirname, '../../../../node_modules/@mui/icons-material'),
      '@mui/utils': resolve(__dirname, '../../../../node_modules/@mui/utils'),
      '@mui/styled-engine': resolve(__dirname, '../../../../node_modules/@mui/styled-engine'),
      '@mui/private-theming': resolve(__dirname, '../../../../node_modules/@mui/private-theming'),
      '@emotion/react': resolve(__dirname, '../../../../node_modules/@emotion/react'),
      '@emotion/styled': resolve(__dirname, '../../../../node_modules/@emotion/styled'),
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
