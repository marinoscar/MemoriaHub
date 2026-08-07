# Dependency Vulnerability Exceptions

**Record date:** 2026-08-07
**Baseline:** measured against `npm audit --package-lock-only --json` on 2026-08-07, after issues #215/#216/#217 and dependabot PR #225 landed, and concurrently with the in-flight `brace-expansion` / `fast-uri` / `js-yaml` patch-version bumps and the `fluent-ffmpeg` removal. If you are reading this later, re-run `scripts/audit-triage.mjs` (see below) before trusting the row counts — this file is a snapshot, not a live view.

> **The success criterion (epic #214, issue #218) is not "`npm audit` shows 0."** It is: every row in `npm audit` is either fixed or has a linked, dated justification with a named revisit trigger below. Raw `npm audit` row counts double- and triple-count the same root cause across every path it's reachable from — see `scripts/audit-triage.mjs`, which groups rows by distinct root advisory so nobody quotes "N vulnerabilities" as if each row were an independent problem.

## Standing rule: never run `npm audit fix --force`

On this repo, `npm audit fix --force` does not fix anything in this list — it "resolves" the high-severity rows by **downgrading** four majors:

- `jest` → `25.x`
- `exceljs` → `3.4.0` (five years old)
- `react-router-dom` → `7.11.0` — it "fixes" the advisory only by dropping *below* the vulnerable range (`>=7.12.0`), discarding seven minor releases of bug fixes to silence a finding that does not apply to this app at all; see the `react-router` row below
- `onnxruntime-node` → `1.21.1`, which conflicts with the root `overrides` pin to `1.27.0` in `package.json` that exists specifically to keep server and worker-node CLIP embedding output numerically identical (see the [Distributed Nodes spec](../specs/distributed-nodes.md))

Do not run it. If a future contributor wants to "clean up the audit," point them at this document and `scripts/audit-triage.mjs` first.

## Baseline at time of writing

- Current: **11 rows (9 high, 2 moderate) across 8 distinct root advisories.**
- 4 of those 8 roots are being fixed by in-range patch bumps in a concurrent commit (`brace-expansion`, `fast-uri`, `js-yaml` — no `overrides` needed; upstream has since published 1.1.17 / 5.0.9 backports, so the epic's original "forced two-major jump" framing for `brace-expansion` is stale).
- That leaves **8 rows / 4 root advisories**, listed below. All four are accept-and-document — each is either unreachable from any first-party code path, or fixable only by a major downgrade/upgrade that trades a real regression for a theoretical exposure.

## Accepted exceptions

| Advisory | Package | Why not fixed | Why not reachable (file:line) | Revisit trigger |
|---|---|---|---|---|
| [GHSA-xcpc-8h2w-3j85](https://github.com/advisories/GHSA-xcpc-8h2w-3j85) — high — `adm-zip <0.6.0` (crafted ZIP → 4 GB allocation) | `adm-zip` | Reached only via `onnxruntime-node`, which declares `"adm-zip": "^0.5.16"` (`node_modules/onnxruntime-node/package.json:16`). The fix (0.6.0) is outside that declared range — adopting it means overriding a dependency to violate its own author's constraint, on the code path that unpacks onnxruntime's native `.node` binary. A failure there doesn't fail loudly at install; it silently breaks CLIP embedding (near-duplicate detection) at runtime on both the API and worker nodes. `onnxruntime-node` is additionally pinned to `1.27.0` by a root `overrides` entry (`package.json:27`) specifically to guarantee server/worker-node CLIP parity — bumping past it risks re-opening that parity gap for a vulnerability nothing in this repo can trigger. | `node_modules/onnxruntime-node/script/install-utils.js:11` — `const AdmZip = require('adm-zip')` is used only at **install time** to extract onnxruntime's own vendored binaries from a package onnxruntime itself publishes. No MemoriaHub code path — API, CLI, or worker — ever feeds attacker-controlled ZIP bytes into it. | `onnxruntime-node` widens its declared `adm-zip` range to admit `>=0.6.0`. |
| [GHSA-c96f-x56v-gq3h](https://github.com/advisories/GHSA-c96f-x56v-gq3h) — high — `find-my-way <=9.6.0` (HTTP/2 DDoS) | `find-my-way` | `@nestjs/platform-fastify` pins `"find-my-way": "9.6.0"` **exactly** (`node_modules/@nestjs/platform-fastify/package.json:26`), not a range — even the 9.7.0 patch requires an `overrides` entry against a NestJS-owned pin. | `apps/api/src/main.ts:24` — `new FastifyAdapter({ logger: true })` passes no `http2` option, and there is no `http2` reference anywhere under `apps/api/src`. The advisory requires HTTP/2 to be enabled on the Fastify instance; it isn't. A warning comment pointing at this document has been added directly at that call site (see below) so enabling HTTP/2 later can't silently reactivate this. | **HTTP/2 is enabled on the Fastify adapter.** (If/when that happens, it should come with its own security review, not a silent config flip — track any HTTP/2 adoption as its own issue, not as a side effect of some other change.) |
| [GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) — high — `react-router >=7.12.0 <8.3.0` (RSC-mode CSRF bypass) | `react-router` / `react-router-dom` | The first fixed release is **8.3.0**, a full major. The currently-resolved 7.18.2 (`node_modules/react-router/package.json`, `node_modules/react-router-dom/package.json`) is inside the vulnerable range, so there's no same-major fix to take. `npm audit fix --force` "fixes" this by downgrading to 7.11.0, which is a regression (loses two minor versions of bug fixes), not a fix. | `apps/web/src/main.tsx:3,9` — `import { BrowserRouter } from 'react-router-dom'` and `<BrowserRouter>…</BrowserRouter>`. The advisory is specific to React Router's **RSC (React Server Components) mode**. `apps/web` is a plain Vite SPA mounted with `BrowserRouter` — no RSC, no server-side action handling, no framework mode anywhere in the app. | The web app adopts React Router RSC/framework mode. (Track a v8 migration on its own merits as a separate piece of work — not as a security fix, since there is nothing to fix here today.) |
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) — moderate — `uuid <11.1.1` (missing buffer bounds check in v3/v5/v6 when `buf` is supplied) | `uuid` | Reached via `exceljs`, which declares `"uuid": "^8.3.0"`. `exceljs@4.4.0` (`node_modules/exceljs/package.json`) is already the latest version upstream has published — the project is effectively dormant — so there is no in-range or upstream fix to take. `npm audit fix --force` proposes downgrading to `exceljs@3.4.0`, five years old. | Doubly unreachable. (1) The advisory requires calling **v3/v5/v6** with a `buf` argument; exceljs's only usage is `uuidv4()` — v4, the unaffected function — called with **no arguments**: `node_modules/exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js:1,43,77`. (2) `exceljs` itself is CLI-only (`apps/cli/package.json:28`, `"exceljs": "^4.4.0"`) and lazily loaded via `await import('exceljs')` — `apps/cli/src/export/scan-export.ts:33`, `apps/cli/src/export/sync-export.ts:17`, `apps/cli/src/export/date-inference-export.ts:28` — so it never loads in the API or on a worker node at all, only when a user explicitly runs a CLI export command. (`jest-junit` also depends on `uuid` but resolves to `14.0.1`, unaffected — see `node_modules/jest-junit/node_modules/uuid/package.json`.) | `exceljs` bumps its declared `uuid` major, **or** any first-party code starts calling `uuid`'s v3/v5/v6 functions with a `buf` argument. |

## Related decision: `exceljs` deprecation (issue #219 Track B)

#219 Track B asked for an explicit decision on `exceljs`'s deprecated-dependency chain rather than leaving it implicit. Decision: **accept and document.**

Rationale:
- `exceljs@4.4.0` is already the latest published version; upstream is effectively dormant, so bumping resolves nothing.
- `exceljs` itself is **not** deprecated — only its transitive dependencies are (`unzipper` → `fstream`, `unzipper` → `glob@7` → `inflight`, `rimraf@2`, `fast-csv` → `lodash.isequal`, and its own `uuid@8` dependency covered by the exception above).
- It backs exactly one optional CLI feature — xlsx export from `memoriahub scan-export` / `sync-export` / the date-inference export — is lazily imported (see file:lines above), and is never loaded by the API or a worker node.
- #219 already separately rejected overriding `inflight` / `glob` / `rimraf` transitively under `unzipper@0.10`: they're load-bearing inside an unmaintained package, and forcing majors underneath it risks breaking xlsx export for zero security gain, since these are deprecation warnings, not live advisories against a reachable vulnerable code path.
- Revisit trigger: a live advisory is filed against `exceljs` itself, or against `unzipper`, or the CLI's xlsx export feature is retired in favor of CSV-only export.

## Related inventory: deprecation-warning ownership (issue #219)

Epic #214's success criterion #3 is *"`npm install` emits no deprecation warning traceable to a direct first-party dependency."* After `fluent-ffmpeg` is removed (in progress, separate commit), that criterion is met — walking every dependent edge in `package-lock.json` shows no other deprecated package has a first-party workspace (`apps/api`, `apps/web`, `apps/cli`, `packages/enrichment-compute`) as a direct parent:

| deprecated package | pulled in by | first-party direct dependent? |
|---|---|---|
| `fluent-ffmpeg@2.1.3` | `apps/api`, `packages/enrichment-compute` | **Yes — the only one; being removed in a concurrent commit** |
| `inflight@1.0.6` | `glob@7` under `archiver-utils`, `fstream`, `test-exclude`, `zip-stream` | No |
| `rimraf@2.7.1` | `fstream`, `gaxios` | No |
| `lodash.isequal@4.5.0` | `@fast-csv/format`, `jest-mock-extended` | No |
| `glob@7.2.3` (×4) / `glob@10.5.0` (×4) | `@fastify/static`, `@nestjs/cli`, jest packages, `rimraf`, `archiver-utils` | No |
| `prebuild-install@7.1.3` | `better-sqlite3` | No |
| `fstream@1.0.12` | `unzipper` | No |
| `node-domexception@1.0.0` | `fetch-blob` ← `node-fetch` | No |
| `uuid@8.3.2` | `exceljs`, `jest-junit` | No |

None of these need action beyond what's already tracked (the `exceljs` decision above, and #219's rejection of forcing transitive majors under `unzipper`).

## Tooling

[`scripts/audit-triage.mjs`](../../scripts/audit-triage.mjs) runs `npm audit --package-lock-only --json` and groups the raw rows by distinct root advisory (deduping on the GHSA/advisory URL), so the number anyone quotes is "N distinct root advisories," not "`npm audit` printed N rows." Run it with `node scripts/audit-triage.mjs` from the repo root. It is a reporting tool only — it always exits 0, and is not (and per epic #214, deliberately is not) wired into CI as a gate.

## References

- Epic #214 — npm audit noise triage
- Issue #218 — accepted-risk record + audit-triage script (this document + the script)
- Issue #219 — deprecation warning inventory + exceljs decision
- Linked from [`docs/SECURITY-ARCHITECTURE.md`](../SECURITY-ARCHITECTURE.md)
