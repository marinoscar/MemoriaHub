/**
 * models-dir.spec.ts — Unit tests for ensureModels() target-directory resolution.
 *
 * A pre-set MODELS_DIR env var must win over the state-dir models path so a
 * container with baked models (e.g. /app/models) verifies them in place
 * instead of re-downloading. MODELS_DIR / FACE_HUMAN_MODEL_PATH /
 * MEMORIAHUB_STATE_DIR are saved/restored between tests (ensureModels itself
 * sets the first two on success).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureModels } from '../../src/node/models.js';
import { modelsDir } from '../../src/paths.js';

const ENV_KEYS = ['MODELS_DIR', 'FACE_HUMAN_MODEL_PATH', 'MEMORIAHUB_STATE_DIR'] as const;

describe('ensureModels — target directory resolution', () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-models-dir-test-'));
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should honor a pre-set MODELS_DIR env var as the default target', async () => {
    const baked = path.join(tmpDir, 'baked-models');
    process.env['MODELS_DIR'] = baked;

    const result = await ensureModels([]);

    expect(result.targetDir).toBe(baked);
    expect(fs.existsSync(baked)).toBe(true);
    expect(process.env['MODELS_DIR']).toBe(baked);
  });

  it('should verify an existing valid file in MODELS_DIR without downloading', async () => {
    const baked = path.join(tmpDir, 'baked-models');
    fs.mkdirSync(baked, { recursive: true });
    fs.writeFileSync(path.join(baked, 'model.onnx'), 'model-bytes');
    process.env['MODELS_DIR'] = baked;

    const result = await ensureModels([
      {
        name: 'model.onnx',
        url: 'https://unreachable.invalid/model.onnx',
        bytes: Buffer.byteLength('model-bytes'),
        sha256: null,
        targetSubdir: '',
      },
    ]);

    expect(result.targetDir).toBe(baked);
    expect(result.present).toEqual(['model.onnx']);
    expect(result.downloaded).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('should fall back to the state-dir models path when MODELS_DIR is unset', async () => {
    process.env['MEMORIAHUB_STATE_DIR'] = tmpDir;

    const result = await ensureModels([]);

    expect(result.targetDir).toBe(path.join(tmpDir, 'models'));
    expect(result.targetDir).toBe(modelsDir());
  });
});
