/// <reference types="vite/client" />
// `virtual:pwa-register/react` — imported by `components/pwa/UpdatePrompt.tsx`
// (issue #482). It exists only as a virtual module created by `VitePWA()` at
// build time, so without this reference `tsc` sees an unresolved import. Under
// Vitest the same specifier is resolved by an alias in `vitest.config.ts`.
/// <reference types="vite-plugin-pwa/react" />
