import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['./test/setup.ts'],
    // Civil dates are a fact of the photographer's clock, so a test that is about
    // zones names one (`process.env.TZ` per case, see test/media/civilDate.test.ts);
    // everything else runs on a pinned device zone so a suite reads the same everywhere.
    env: { TZ: 'UTC' },
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
