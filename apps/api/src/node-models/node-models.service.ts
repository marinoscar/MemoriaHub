// =============================================================================
// The parity model manifest worker nodes download (moved from NodesService, RETRO-C2, #581)
// =============================================================================

import { Injectable } from '@nestjs/common';

/** One entry of the manifest: a model file a node must hold locally. */
export interface NodeModelManifestEntry {
  name: string;
  url: string;
  sha256: string;
  bytes: number;
  targetSubdir: string;
}

@Injectable()
export class NodeModelsService {
  /**
   * Static manifest of the parity models a worker node must download so its
   * enrichment output matches the server. Structure matters more than exact
   * values here.
   *
   * Returns a BARE ARRAY (not `{ models: [...] }`): the CLI's
   * `ApiClient.getModelManifest(): Promise<ModelManifestEntry[]>` unwraps the
   * global `{ data }` envelope and then iterates the result directly.
   *
   * NOTE on the `clip-vit-b32-vision-quantized.onnx` entry's `sha256`
   * specifically: Hugging Face may rebuild/re-quantize that file over time
   * (same caveat documented above `looksLikeOnnxModel()` in
   * `packages/enrichment-compute/src/clip/index.ts`), so this hash is a
   * point-in-time snapshot, not an eternal guarantee — a stale pinned hash
   * would break air-gapped/offline deployments if never refreshed. If a
   * node's download of this entry ever fails hash verification
   * unexpectedly, the correct response is to re-download and re-hash that
   * one manifest entry (update this table), not to assume the file itself
   * is corrupt.
   */
  getModelManifest(): NodeModelManifestEntry[] {
    return [
      {
        name: 'clip-vit-b32-vision-quantized.onnx',
        url: 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx',
        sha256: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299',
        bytes: 89117001,
        // Empty string (not 'models'): `targetDir` passed to ensureModels() is
        // ALREADY the models root (~/.memoriahub/models), so this file must
        // land directly there — matching where testClip() and
        // duplicate-detection.ts's getClipSession() look for it
        // (path.join(modelsDir(), CLIP_MODEL_FILENAME), no subdirectory). A
        // non-empty subdir here previously caused a double-nested download
        // path invisible to the code that consumes the file.
        targetSubdir: '',
      },
    ];
  }
}
