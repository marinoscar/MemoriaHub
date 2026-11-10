/**
 * executors/model-paths.ts - the platform's model path helpers, behind two functions so the compute
 * modules and the tests do not import the platform engine.
 */

import { modelArtifactPath, resolveModelsDir, type ModelArtifact } from '@marinoscar/platform-cli/node';

import { nodeStateDirectory } from './state-dir.js';

export { modelArtifactPath };
export type { ModelArtifact };

/** `<MEMORIAHUB_MODELS_DIR>`, else `<node state dir>/models`. */
export function nodeModelsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolveModelsDir(nodeStateDirectory(env), env);
}
