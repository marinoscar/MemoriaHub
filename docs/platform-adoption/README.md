# Platform adoption

MemoriaHub is being retrofitted to consume the EnterpriseAppBase (EAB) platform packages (`@marinoscar/platform-contract|api|web|db|cli|infra|ai-providers`) in place, one slice per PR, keeping the existing repository and production database. The program is epic [#555](https://github.com/marinoscar/MemoriaHub/issues/555); this folder is its frozen starting point (RETRO-A1, #568).

Rule for every contributor: platform code is never edited here. When a platform seam is missing, file a `seam_request.yml` in EnterpriseAppBase; if you cannot wait, eject with a `// PLATFORM-ADOPTION-SHIM(#<issue>)` marker and a row in [local-exceptions.md](local-exceptions.md).

## Files

| File | What it is |
|---|---|
| [module-classification.md](module-classification.md) | One row per top-level module: drift, category (noise, backport, domain, divergence), target slice or package, plan ID, EAB issue |
| [local-exceptions.md](local-exceptions.md) | Register of deliberate deviations from the platform (empty; A5 adds the first) |
| [drift-baseline.md](drift-baseline.md), [.json](drift-baseline.json) | Apps view of EAB's drift report |
| [drift-baseline-slices.md](drift-baseline-slices.md), [.json](drift-baseline-slices.json) | Slice view (API modules against packaged slices) |
| `scripts/platform-adoption/make-slice-view.sh` | Builds the slice view of EAB |

The reports were generated at EAB `59e377cbebb60e711fe4d7b0d818715f23af8a59` and MemoriaHub `928ea684fe95329d4a81e1e4b47ba3c54354e919` on 2026-11-08. Scratch paths in them are replaced by placeholders.

## Rollback

The tag `MonoRepo` points at `928ea684fe95329d4a81e1e4b47ba3c54354e919`, the start of the program. Resetting to it undoes the whole retrofit; per-slice rollback is a revert of that slice's PR. See the Rollback section of #555.

## Wave map

Plan IDs resolve to issues in the issue map of [#555](https://github.com/marinoscar/MemoriaHub/issues/555). Epics: A foundation (#564), B host/identity/settings (#565), C jobs and nodes (#559), T telemetry (#561), D storage/email/notifications/backup/Android (#557), E AI (#589), F web shell/infra/CLI (#560), H harvested features (#584), I circles to sharing (#556), J domain packages (#558). EAB G1 (#1064, TUI framework) and G2 (#1070, node hardening) run in EnterpriseAppBase from day one.

```
Wave 0 (serial gate)   A1 → A2 ∥ A3 → A4 → A5        (A6 = production window, see release train)
Wave 1 (parallel)      B1 ∥ B1b ∥ T1 ∥ F2 ∥ (EAB G1.*, G2.*, seams start on day 1, separate repo)
Wave 2 (serial gate)   B2 → B3 → B4 → B5   then A6 + B1..B4 to production in one window
Wave 3 (parallel)      C1 → {C2 ∥ C3 ∥ C4 ∥ C5 ∥ C6 ∥ C7 ∥ C8 ∥ C9}  ∥ F1 ∥ F3 ∥ T2 → T3
Wave 4 (parallel)      D1 → {D4 (right behind) ∥ D1b ∥ D2→D3 ∥ D5 ∥ E1→E2→E3→E4} ∥ F4 (needs G1) ∥ C10 (needs C2, G2) → C11 ∥ T4
Wave 5 (parallel)      H1 ∥ H2 ∥ H3 ∥ H4 ∥ H5
Wave 6                 I1 → I2 → I3 ∥ I4 → I5 → I6     ∥   J1 → J2 → J3 → J4 → J5 → {J6 ∥ J10} → {J7 → J9, J8} ∥ J11 → J12
```

Only one open PR may carry a migration (`migration-lock`) at a time. A6 and B1 to B4 ship to production in one maintenance window.

## Regenerating the reports

`<EAB>` is a checkout of EnterpriseAppBase, `<MEMORIAHUB>` a checkout of this repository (without `infra/compose/.env`), `<SCRATCH>` a temporary directory outside both. The drift tool uses Node built-ins only and writes only to `--out`.

```bash
# Apps view
cd <SCRATCH> && node <EAB>/scripts/platform-drift.mjs --app <MEMORIAHUB> --base <EAB> \
  --app-product-name MemoriaHub --app-repo-slug marinoscar/MemoriaHub --app-cli-name memoriahub \
  --out <SCRATCH>/apps

# Slice view (API modules against packaged slices)
bash <MEMORIAHUB>/scripts/platform-adoption/make-slice-view.sh <EAB> <SCRATCH>/eab-slice-view
cd <SCRATCH> && node <EAB>/scripts/platform-drift.mjs --app <MEMORIAHUB> --base <SCRATCH>/eab-slice-view \
  --areas api --out <SCRATCH>/slices \
  --app-product-name MemoriaHub --app-repo-slug marinoscar/MemoriaHub --app-cli-name memoriahub
```

Copy `drift-report.md` and `drift-report.json` from each output directory to the matching baseline file names. The committed baselines are frozen: regenerate into a scratch directory to compare progress, and do not overwrite them.

## Adding an exception

1. Add the `// PLATFORM-ADOPTION-SHIM(#<issue>)` marker where the code deviates (or a `deviations` entry in `platform.lock` for a database difference).
2. Add a row to [local-exceptions.md](local-exceptions.md) naming the issue that removes it. File the issue if none exists.
3. The PR that removes the exception deletes the row, the marker and the lock entry.
