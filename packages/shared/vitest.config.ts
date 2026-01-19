import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * Vitest configuration for the Shared package
 *
 * Tests are organized in:
 * - src/__tests__/ - Unit tests for types, validation, utilities
 */
export default defineConfig({
  test: {
    name: 'shared',
    root: resolve(__dirname),
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Coverage for this workspace
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/index.ts', // Entry point (re-exports)
      ],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
