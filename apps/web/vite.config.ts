import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * `@mui/material@9` declares a `browser` field remapping
 *   react-transition-group/cjs/TransitionGroupContext.js
 *     -> react-transition-group/esm/TransitionGroupContext.js
 * but `react-transition-group@4`'s `exports` map publishes only `./cjs/*.js`.
 * The `esm/` file is on disk; it is simply not an exported entry point.
 *
 * Vite 8 resolves through rolldown, which enforces `exports` strictly, so the
 * remapped specifier fails to resolve and `vite build` aborts (issue #398).
 * Older, laxer resolvers fell back to the physical path, which is why this only
 * surfaces at bundle time — dev, typecheck and the test suite all pass.
 *
 * Resolving the specifier to the real file keeps MUI's intent (the ESM build,
 * so the module stays tree-shakeable) instead of forcing it back to CJS. It is
 * scoped to exactly one specifier: nothing else in the dependency graph changes
 * resolution behaviour.
 *
 * NOTE the alias targets the **cjs** specifier — the one MUI actually writes in
 * `internal/Transition.mjs` — not the `esm` path in the error message. Aliasing
 * the `esm` path does NOT work: by the time it appears, the browser-field remap
 * has already happened inside package resolution, below where aliases apply.
 * Matching the source specifier short-circuits the remap before it runs.
 *
 * Remove this once either side fixes it upstream — react-transition-group
 * adding an `./esm/*` export, or MUI dropping the remap. `require.resolve`
 * targets `package.json` and trims it, because the exports map DOES publish
 * `./package.json` while the file we actually want is unreachable by name.
 */
const transitionGroupEsm = require
  .resolve('react-transition-group/package.json')
  .replace(/package\.json$/, 'esm/TransitionGroupContext.js');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: 'react-transition-group/cjs/TransitionGroupContext.js',
        replacement: transitionGroupEsm,
      },
    ],
  },
  server: {
    port: 5173,
    host: true,
    allowedHosts: ['memoriahub.dev.marin.cr', 'localhost', '.localhost'],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
