import { defineExecutor } from './define.js';

/** `geocode`: wraps ./compute/geocode.ts. */
export const geocodeExecutor = defineExecutor({
  type: 'geocode',
  input: 'none',
  load: () => import('./compute/geocode.js'),
});
