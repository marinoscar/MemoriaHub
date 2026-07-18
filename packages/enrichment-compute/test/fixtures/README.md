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

### golden-fixture.heic (HEIC decode regression, issues #106 and #128)

`golden-fixture.heic` **now exists** and is committed as the source of truth
— a small (6.2 KB) HEVC/`hvc1`-coded HEIC file, decoding to a 256×192 image,
encoded from the existing `golden-fixture.jpg` above.

**How it was generated** (Python, `pillow-heif`):

```python
import pillow_heif
from PIL import Image

pillow_heif.register_heif_opener()

img = Image.open("golden-fixture.jpg")
img.save("golden-fixture.heic", format="HEIF", quality=80)
```

Any small, valid HEVC-coded HEIC file works as the fixture — only the DECODE
path is asserted (dHash of the fixture's *own* pixel content, not a
cross-format comparison against `golden-fixture.jpg`), so byte-for-byte
reproducibility of the encoder output is not required the way it is for the
JPEG fixture above.

**Two consumers, two eras:**

- `test/heic.test.mjs` has six tests that mock `fluent-ffmpeg` (covering
  success, temp-file cleanup, a custom `fileExtension` option, an ffmpeg
  error, an empty-output guard, and the SIGKILL timeout) — this is the
  regression coverage for the issue #106 fallback (`transcodeToDecodableJpeg`)
  itself, and runs unconditionally with no real ffmpeg or fixture required.
  Its final test decodes the real fixture end-to-end through `computeDHash`
  and no longer requires a real `ffmpeg` binary on PATH, since (post #128) a
  HEIF-enabled sharp decodes it natively without ever reaching the fallback.
- `test/golden.test.mjs` has the AUTHORITATIVE issue #128 parity-gate test:
  it asserts sharp reports `format: 'heif'` for the fixture (native decode,
  no exception), and — by installing the same fake-ffmpeg mock as
  `heic.test.mjs` around a real `computeDHash` call — asserts the ffmpeg
  fallback is **never invoked** in that path. This is the test the CI
  golden-vector parity gate (`.github/workflows/deploy.yml`) runs inside the
  built worker image, and — new as of #128 — the API image too, both switched
  to a system HEIF-enabled libvips. `REQUIRE_HEIC_DECODE=1` in that gate turns
  "sharp couldn't decode HEIC natively" from a skip into a hard build failure,
  since a regression back to bundled/non-HEIF libvips must never pass
  silently.

**Pinning `GOLDEN_HEIC_DHASH`:**

Neither test file has a value pinned yet (`GOLDEN_HEIC_DHASH = null` in both
— `golden.test.mjs`'s copy is the single source of truth; `heic.test.mjs`
keeps a matching `null` placeholder only so its own equality-or-print
assertion has the same shape as the JPEG golden test). Both tests print the
computed dHash instead of failing when unpinned.

1. Run `node --test test/golden.test.mjs` **inside the built image** (worker
   or API) that has the production HEIF-enabled global libvips (issue #128) —
   not on a plain dev machine, since the value must come from a genuine
   native decode, and a different libvips/libheif build could in principle
   produce different pixels.
2. Copy the printed value (`[golden.test.mjs] computed HEIC dHash: ...`) into
   the `GOLDEN_HEIC_DHASH` constant near the top of `test/golden.test.mjs`
   (replacing the `null` placeholder). Optionally also pin
   `test/heic.test.mjs`'s copy for a redundant cross-check.
3. Re-run — the test now asserts a bit-exact match, same as `GOLDEN_DHASH`
   does for `golden-fixture.jpg`.
4. This value is executor-dependent (it depends on the exact libvips/libheif
   build baked into the image). Keep the CI parity gate amd64-only unless/
   until cross-arch bit-stability has actually been verified — if the gate
   ever runs on a second architecture, re-derive and separately track the
   value for that arch rather than assuming it matches.
