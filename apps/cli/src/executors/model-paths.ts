/**
 * executors/model-paths.ts - where models live, computed without the platform engine (which needs the
 * CLI identity set by `createCli`; these helpers also run in specs and before the CLI is built).
 */

import * as path from 'node:path';

import { appWorkerEnv } from '../worker-env.js';
import { nodeStateDirectory } from './state-dir.js';

export interface ModelArtifact {
  fileName: string;
  sha256: string;
  bytes: number;
  id: string;
  url?: string;
  requiredBy: string[];
  targetSubdir?: string;
}

/** `<MEMORIAHUB_MODELS_DIR>`, else `<node state dir>/models` (the platform's rule). */
export function nodeModelsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[appWorkerEnv.modelsDir]?.trim();
  return override !== undefined && override !== '' ? override : path.join(nodeStateDirectory(env), 'models');
}

/** Where an artifact's file is (or will be). */
export function modelArtifactPath(artifact: Pick<ModelArtifact, 'fileName' | 'targetSubdir'>, modelsDir: string): string {
  return path.join(modelsDir, artifact.targetSubdir ?? '', artifact.fileName);
}
