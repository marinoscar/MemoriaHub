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
      // Pin React to the monorepo root copy to prevent dual-instance errors.
      // In a git worktree at worktrees/ai-search/, npm installs a sibling
      // node_modules/ at the worktree root, while the monorepo root also has
      // node_modules/. Vitest/vite would resolve react from the worktree and
      // react-dom from the monorepo root, causing two React instances.
      'react': resolve(__dirname, '../../../../node_modules/react'),
      'react-dom': resolve(__dirname, '../../../../node_modules/react-dom'),
      'react/jsx-runtime': resolve(__dirname, '../../../../node_modules/react/jsx-runtime'),
      'react/jsx-dev-runtime': resolve(__dirname, '../../../../node_modules/react/jsx-dev-runtime'),
    },
    dedupe: ['react', 'react-dom'],
  },
});
