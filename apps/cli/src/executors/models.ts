/**
 * executors/models.ts - the model files a node needs (RETRO-C10, #616).
 *
 * The platform downloads and verifies what `registerModelArtifact` declares (`node models pull`,
 * the `models` step of `node install-deps`, a startup check that withholds the types whose model is
 * missing). MemoriaHub declares one: the CLIP ViT-B/32 vision model `duplicate_detection` embeds with.
 * The values are the server's manifest (`apps/api/src/node-models/node-models.service.ts`); a node's
 * vectors are only comparable to the server's with the identical file.
 */

import type { ModelArtifact } from '@marinoscar/platform-cli/node';

import { modelArtifactPath, nodeModelsDirectory } from './model-paths.js';

export const CLIP_MODEL_FILENAME = 'clip-vit-b32-vision-quantized.onnx';

export const CLIP_MODEL_ARTIFACT: ModelArtifact = {
  id: 'clip-vit-b32',
  fileName: CLIP_MODEL_FILENAME,
  sha256: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299',
  bytes: 89117001,
  url: 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx',
  requiredBy: ['duplicate_detection'],
};

/** The models directory of this worker. */
export function resolveModelsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return nodeModelsDirectory(env);
}

/** Where the CLIP model is (or will be). */
export function clipModelPath(env: NodeJS.ProcessEnv = process.env): string {
  return modelArtifactPath(CLIP_MODEL_ARTIFACT, nodeModelsDirectory(env));
}
