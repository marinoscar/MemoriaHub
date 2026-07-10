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
