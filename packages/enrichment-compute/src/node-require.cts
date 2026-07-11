/**
 * A `require` usable from BOTH build outputs.
 *
 * `.cts` compiles to a `.cjs` file in each dist tree, so this module is
 * CommonJS everywhere and `require` here is always the real Node require —
 * even when the importer is the ESM build. Heavy optionalDependencies
 * (@vladmandic/human, @tensorflow/tfjs*, tesseract.js) are loaded lazily at
 * runtime through this so a lean install without them never crashes at
 * import time; the face/OCR subpaths (future slices) call this on demand.
 */
export function nodeRequire(id: string): unknown {
  return require(id);
}

/**
 * `require.resolve` counterpart — used to locate files INSIDE an optional
 * dependency's install tree (e.g. @vladmandic/human's node-wasm build, the
 * tfjs WASM binaries) without loading the module. Same CJS-everywhere
 * guarantee as `nodeRequire`.
 */
export function nodeResolve(id: string): string {
  return require.resolve(id);
}
