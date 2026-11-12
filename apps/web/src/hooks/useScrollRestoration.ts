// The hook lives in the packaged core (`@marinoscar/memoriahub-web/core/headless`); this re-export keeps
// the app's imports (and the settings hubs' `useScrollRestoration` prop) unchanged.
export { useScrollRestoration } from '@marinoscar/memoriahub-web/core/headless';
