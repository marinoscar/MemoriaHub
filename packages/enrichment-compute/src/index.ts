/**
 * @memoriahub/enrichment-compute — shared PURE enrichment compute.
 *
 * One implementation, imported identically by the CommonJS NestJS API
 * (apps/api) and the ESM NodeNext CLI (apps/cli), so an embedding computed on
 * a worker node is numerically identical to one computed on the server
 * (docs/specs/distributed-nodes.md §7 — the load-bearing parity constraint).
 *
 * Rules for code in this package:
 *  - NO framework imports (NestJS, Prisma) — pure functions only.
 *  - NO env-var reads — model paths and options are explicit parameters.
 *  - NO persistence or network I/O beyond the buffers/paths handed in.
 */

export * from './logging.js';
export * from './image/index.js';
export * from './clip/index.js';
export * from './dhash/index.js';
export * from './dto/index.js';
export * from './face/index.js';
export * from './ocr/index.js';
export * from './metadata/index.js';
export * from './social/index.js';
export * from './video/index.js';
export { nodeRequire, nodeResolve } from './node-require.cjs';
