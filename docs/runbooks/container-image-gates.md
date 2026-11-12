# Container image gates (API and worker)

`.github/workflows/images.yml` builds the API and worker images on every pull request (build only, never pushed) and runs these gates inside them.

| Gate | Job | Blocking |
|---|---|---|
| Postgres client floor, dHash/hamming golden tests | API image gates | yes |
| Native HEIC decode (`REQUIRE_HEIC_DECODE=1`) | both image jobs | yes |
| Worker golden tests except the CLIP case, engine smoke | Worker image gates | yes |
| API image and worker image produce the same pixels, dHash and CLIP embedding (within 1e-4) for the JPEG and HEIC fixtures on the same runner | Cross-executor parity | yes |
| CLIP embedding against the committed golden vector | Cross-executor parity | only on the CPU class the vector was derived on (`GOLDEN_BLESSED_CPU`, currently `EPYC 7763`); other CPUs get a `::warning::` and a summary row, the diff is always printed |

## Why the committed CLIP vector is CPU-gated

The CLIP model is int8-quantized and onnxruntime's quantized kernels depend on the CPU instruction set. With byte-identical input pixels, an AMD EPYC 9V45 runner (AVX-512 VNNI) gives a max diff of 0.01527 against `golden-clip-512.json`, while an EPYC 7763 passes. The invariant that matters, that server and worker agree on the same machine, is the blocking cross-executor check. Regenerating the golden vector on newer hardware is an owner decision and has not been done.

## libvips build

Both images compile libvips 8.18.3 with libheif from `scripts/docker/build-libvips.sh` and build sharp's addon against it (Debian trixie ships 8.16, below sharp 0.35's minimum; sharp's bundled libvips has no HEVC decoder). A Dockerfile step fails the build if the source-built addon cannot load.

## arm64 risk for the first release build

CI builds amd64 only. `deploy.yml` builds multi-arch, so the libvips compile and sharp addon build run for arm64 (under emulation) for the first time on the first release after this change. Expect a much longer build and, if it fails, look at the `vips` stage first (dev package names, meson options) and the `node install/build.js` step. Fallback: build amd64 only for that release.
