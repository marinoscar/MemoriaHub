// Prints, as JSON, everything that must be identical between the API image and
// the worker image when both run on the SAME machine: decode/resize pixel
// hashes, dHash and the CLIP embedding of the committed fixtures. Used by the
// `executor-parity` job of .github/workflows/images.yml (RETRO-J), which runs it
// inside both images and diffs the two files with compare-parity.mjs.
// Also records the CPU model and the max diff against the committed golden
// vector (golden-clip-512.json), which is CPU-class dependent (see the workflow).
//
// Usage (from this package's directory): node scripts/emit-parity.mjs <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = process.argv[2];
if (!outPath) {
  console.error('usage: node scripts/emit-parity.mjs <out.json>');
  process.exit(2);
}
const MODELS_DIR = process.env.MODELS_DIR ?? '/app/models';
const MODEL_PATH = path.join(MODELS_DIR, 'clip-vit-b32-vision-quantized.onnx');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const sharp = (await import('sharp')).default;
const { computeDHash } = await import('@marinoscar/memoriahub-compute/dhash');
const { createClipSession, embedImageWithSession } = await import('@marinoscar/memoriahub-compute/clip');

let cpuModel = 'unknown';
try {
  cpuModel = /model name\s*:\s*(.+)/.exec(readFileSync('/proc/cpuinfo', 'utf8'))?.[1]?.trim() ?? 'unknown';
} catch {}

const session = await createClipSession(MODEL_PATH);
const result = { cpuModel, sharpVersion: sharp.versions.sharp ?? null, fixtures: {} };

for (const [name, file] of [['jpg', 'golden-fixture.jpg'], ['heic', 'golden-fixture.heic']]) {
  const buf = readFileSync(path.join(here, '..', 'test', 'fixtures', file));
  const entry = {};
  try {
    entry.decodePixelsSha256 = sha(await sharp(buf).raw().toBuffer());
    entry.resize224PixelsSha256 = sha(
      await sharp(buf).resize(224, 224, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
    );
  } catch (e) {
    entry.pixelsError = String(e?.message ?? e);
  }
  entry.dhash = await computeDHash(buf);
  const emb = await embedImageWithSession(session, buf);
  entry.clip = emb ? Array.from(emb) : null;
  result.fixtures[name] = entry;
}

const golden = JSON.parse(readFileSync(path.join(here, '..', 'test', 'fixtures', 'golden-clip-512.json'), 'utf8'));
const jpgClip = result.fixtures.jpg.clip;
result.goldenMaxDiff = jpgClip ? Math.max(...jpgClip.map((v, i) => Math.abs(v - golden[i]))) : null;

writeFileSync(outPath, JSON.stringify(result));
console.log(`wrote ${outPath} (cpu: ${cpuModel}, goldenMaxDiff: ${result.goldenMaxDiff})`);
