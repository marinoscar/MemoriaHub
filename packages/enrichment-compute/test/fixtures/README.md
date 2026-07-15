# Golden test fixtures

`golden-fixture.jpg` is a deterministically-generated 256×192 JPEG with real
structure (an R/G gradient plus a hard diagonal edge splitting a dark/light
band) — not a flat fill — so both the dHash and the CLIP embedding computed
from it are non-degenerate.

**The committed JPEG bytes are the source of truth.** The tests decode this
exact file forever; they do not regenerate it. The generator below is
recorded only so the fixture can be reproduced/audited, not so it can be
regenerated and re-committed casually — regenerating it changes the JPEG
encoder output byte-for-byte, which would invalidate `golden-dhash` and
`golden-clip-512.json` and require re-deriving both.

```js
// Reproduces packages/enrichment-compute/test/fixtures/golden-fixture.jpg
// Run with: node <script>.js   (from a context where `sharp` resolves,
// e.g. the repo root — sharp is hoisted to the root node_modules)
const sharp = require('sharp');

const width = 256;
const height = 192;
const channels = 3;
const buf = Buffer.alloc(width * height * channels);

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const idx = (y * width + x) * channels;
    const r = Math.floor((x / (width - 1)) * 255); // R gradient left->right
    const g = Math.floor((y / (height - 1)) * 255); // G gradient top->bottom
    const diag = x / width + y / height; // 0..2 diagonal position
    const b = diag < 1.0 ? 40 : 220; // hard diagonal edge, dark vs light band
    buf[idx] = r;
    buf[idx + 1] = g;
    buf[idx + 2] = b;
  }
}

sharp(buf, { raw: { width, height, channels } })
  .jpeg({ quality: 90 })
  .toFile('packages/enrichment-compute/test/fixtures/golden-fixture.jpg');
```

## Golden values

- `golden-clip-512.json` — the L2-normalized 512-d CLIP ViT-B/32 embedding of
  `golden-fixture.jpg`, produced once via `createClipSession` +
  `embedImageWithSession` against the pinned model
  (`clip-vit-b32-vision-quantized.onnx`, sha256 `583fd111...`). Committed so
  the parity test can assert element-wise closeness without requiring the
  model file to regenerate the golden value (only to check against it).
- The dHash golden value and a couple of `hammingDistance` sanity pairs are
  inlined as constants in `test/golden.test.mjs` (bit-exact algorithm, no
  tolerance needed).

See `test/golden.test.mjs` for the tests that consume these fixtures, and the
top-of-file comment there for the observed max element-wise diff across
repeated runs and the chosen tolerance.

### golden-fixture.heic (HEIC decode regression, issue #106)

`golden-fixture.heic` is **intentionally absent** from this repo. Unlike
`golden-fixture.jpg` above, it cannot be generated in a plain Node.js script —
producing a real HEIC/HEIF file requires an HEIC encoder (libheif) or an
ffmpeg build with HEIC muxer support, neither of which is available in every
dev/CI environment (this sandbox has neither system `ffmpeg` nor a sharp
build with libheif).

The test in `test/heic.test.mjs` (`computeDHash decodes a HEIC photo via the
ffmpeg transcode fallback (issue #106)`) checks for both a system `ffmpeg`
binary on PATH and this fixture file, and `t.skip(...)`s with a clear reason
when either is missing — it never hard-fails just because the fixture isn't
present.

**To enable this regression guard:**

1. Obtain a small real HEIC file — either a photo captured on an iPhone (HEIC
   is Apple's default capture format), or generate one on a host where ffmpeg
   was built with libheif support:
   ```bash
   ffmpeg -i sample.jpg -frames:v 1 golden-fixture.heic
   ```
2. Commit it at `packages/enrichment-compute/test/fixtures/golden-fixture.heic`
   (keep it small — a few KB is enough to exercise the decode path).
3. Run `node --test test/heic.test.mjs` on a machine with `ffmpeg` on PATH.
   The end-to-end test will decode the fixture via `computeDHash` and print
   the computed dHash (e.g. `[heic.test.mjs] computed dHash for
   golden-fixture.heic: 1234567890...`) instead of asserting equality, since
   no golden value is pinned yet.
4. Copy that printed dHash into the `GOLDEN_HEIC_DHASH` constant near the top
   of `test/heic.test.mjs` (replacing the `null` placeholder), then re-run the
   test — it now asserts a bit-exact match, same as `GOLDEN_DHASH` does for
   `golden-fixture.jpg` in `test/golden.test.mjs`.
