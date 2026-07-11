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
