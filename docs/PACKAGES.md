# The `@marinoscar/memoriahub-*` packages

How MemoriaHub's own domain packages are laid out, documented, checked and released. The platform packages (`@marinoscar/platform-*`) follow the same standard in the EnterpriseAppBase repository; this page adapts it to MemoriaHub. The rule behind it: [ADR-0001, packages first](decisions/0001-packages-first.md). Release procedure and the publish gate: [runbooks/release-memoriahub-packages.md](runbooks/release-memoriahub-packages.md). Epic: #558, this tooling: #593.

## Contents

- [The packages](#the-packages)
- [Layout: slices and entry points](#layout-slices-and-entry-points)
- [The README](#the-readme)
- [TSDoc](#tsdoc)
- [TypeDoc and the API reference](#typedoc-and-the-api-reference)
- [Adding a slice](#adding-a-slice)
- [Peer dependencies per slice](#peer-dependencies-per-slice)
- [The contract peer range](#the-contract-peer-range)
- [The host-neutral rule](#the-host-neutral-rule)
- [Checks and commands](#checks-and-commands)
- [CI](#ci)
- [Versioning](#versioning)

## The packages

| Package | Folder | Status | Module format | Entry points |
|---|---|---|---|---|
| `@marinoscar/memoriahub-compute` | `packages/memoriahub-compute` | exists (RETRO-J1, #593) | dual ESM + CommonJS | `.`, `./image`, `./clip`, `./dhash`, `./ffmpeg`, `./video`, `./metadata`, `./geo`, `./rate-limit`, `./face-compreface`, `./face-video`, `./ocr`, `./social`, `./dto` |
| `@marinoscar/memoriahub-contract` | `packages/memoriahub-contract` | exists (RETRO-J2, #598) | dual ESM + CommonJS | `.`, `./primitives`, `./errors`, `./media`, `./media-sync`, `./face`, `./tagging`, `./search`, `./memories`, `./workflows`, `./review-runs`, `./location`, `./dedup`, `./burst`, `./social`, `./enhancement` |
| `@marinoscar/memoriahub-db` | `packages/memoriahub-db` | exists (RETRO-J3, #606) | CommonJS plus a bin | `.` (the `memoriahub-db` command: `sync`, `check`, `promote`), the `schema/`, `migrations/` and inventory files |
| `@marinoscar/memoriahub-api` | `packages/memoriahub-api` | exists (RETRO-J4, #610): ports, core, testing; the domain slices arrive with J5 to J10 | CommonJS (`tsc`, decorator metadata) | `./ports`, `./core`, `./testing`, then one entry per domain slice |
| `@marinoscar/memoriahub-web` | `packages/memoriahub-web` | planned (J11) | ESM | `headless` and `ui` entries per slice |

Every package, once it exists: `"version"` moved by Changesets (the source says `0.0.0`), a `repository.directory`, `engines.node >=24`, `publishConfig` `{ "access": "public", "provenance": true }`, and a `files` list of `dist`, the per-subpath stub folders where the package has them, `README.md`, `CHANGELOG.md` and `LICENSE`. **While the publish gate is closed** a package also carries `"private": true` and `"license": "UNLICENSED"`, and `LICENSE` is not required ([the gate](runbooks/release-memoriahub-packages.md#the-publish-gate)). `LICENSE` is copied from the repository root by the `prepack` script (`scripts/memoriahub-packages/copy-license.mjs`) and is git-ignored in the package.

`@marinoscar/memoriahub-db` owns the domain's Prisma fragments, migrations and raw-SQL inventory and installs them into an app with `memoriahub-db sync`; it never imports platform code at run time and only reads the app's lock files. Its migration policy (one baseline, adopted by the web app) and procedures are in [the runbook](runbooks/memoriahub-domain-migration.md). Its tests (`npm run test:run -w @marinoscar/memoriahub-db`) include `test/apply.db.test.ts`, which runs when `DATABASE_URL` names a PostgreSQL 16 server with pgvector.

The packages are one Changesets `fixed` group (`.changeset/config.json`): they always share one version. Each package name is added to the group by the issue that creates the package; until then the group lists only the packages that exist. The apps (`api`, `web`, `@memoriahub/cli`) and `@app/shared` are in `ignore`; the apps depend on the packages with a `*` workspace range.

`@marinoscar/memoriahub-api` (RETRO-J4) holds the host **ports** and nothing of the domain yet: the injection tokens and interfaces every domain slice reaches the outside world through (`./ports`: prisma, jobs, ai, object store, access, identity, notify, settings, secrets, events, audit, webhooks, metrics), `MemoriahubPortsModule.forRoot` with the optional-port defaults, the SQL helper and the error helpers (`./core`), and in-memory fakes with `describeMemoriahubPortsConformance` (`./testing`). It is CommonJS like the platform API packages, ships one stub folder per slice (`ports/package.json`, ...) because `apps/api` compiles with `moduleResolution: node`, and declares no `@marinoscar/platform-*` peer: a port is structural and the web app binds each one in `apps/api/src/platform-memoriahub/`. Design, call sites and the conformance kit: [the ports spec](specs/memoriahub-ports.md). A slice that moves into it (J5 to J10) is added to `packages/memoriahub-slices.json` as `"<slice>": ["ports", "core"]` and reaches the platform only through a port.

`@marinoscar/memoriahub-contract` is the leaf package: Zod wire schemas, inferred types and `details.reason` codes by domain slice, shared by the API (`createZodDto(schema)`), the web app and the CLI. It imports only `zod` (a required peer of every slice) and, like compute, no `@marinoscar/platform-*` (platform shapes come from `@marinoscar/platform-contract` in the app). Moving a schema into it changes no wire shape: the OpenAPI dump must be identical before and after. Where the API validates a Prisma enum, the contract carries the values as a literal tuple and `apps/api/src/common/contract-enums.spec.ts` pins the two together. The apps build it before they compile (`npm run build:memoriahub-packages`, the Dockerfiles and CI do).

`@marinoscar/memoriahub-compute` is dual because its two consumers load it differently: `apps/api` is CommonJS and `apps/cli` is ESM (NodeNext). Its build is `tsc -p tsconfig.cjs.json && tsc -p tsconfig.esm.json && node ../../scripts/memoriahub-packages/write-dist-stubs.mjs`. A `.d.ts` takes its module format from the nearest `package.json`; the package is `"type": "module"`, so `dist/cjs` gets a stub `package.json` of `{"type":"commonjs"}` or a CommonJS consumer fails with TS1479. The package also ships one stub `package.json` per subpath folder (`clip/package.json` and so on) for consumers compiled with `moduleResolution: node`, which ignores the `exports` map.

## Layout: slices and entry points

A **slice** is a folder directly under `packages/memoriahub-<pkg>/src/`. Each slice is one entry point (`./<slice>` in `exports`, `src/<slice>/index.ts`), has a `README.md`, and may import another slice of its package only when `packages/memoriahub-slices.json` lists it, and only through that slice's `index.ts`. Unlike the contract of kvox, the compute root re-exports every slice (`src/index.ts`), so the docs check resolves a root re-export to its declaration instead of reading it as a bare reference.

```
packages/memoriahub-compute/
  package.json  tsconfig.*.json  typedoc.json  README.md
  src/clip/index.ts  src/clip/README.md  (one folder per slice)
  <slice>/package.json   (node10 resolution stubs, shipped in the tarball)
  test/*.test.mjs        (node --test)
```

`packages/memoriahub-slices.json` is the slice graph, `{ "memoriahub-compute": { "dhash": ["image"] } }`. A slice may be declared before its folder exists; a folder under `src/` that the file does not declare is an error. Both data files are **append-only**: later issues add packages and slices, they never rename or remove one, because a slice name is a published subpath.

Import rules for sources: never a deep import into another package (`src/`, `dist/`, `internal/`), never a relative path that leaves the package. Keep the `.js` extension in every relative import of an ESM or NodeNext package; without it the typecheck can pass and a consumer fails with `ERR_MODULE_NOT_FOUND`.

Subpaths are the package's public API. Document a subpath, or do not export it; an undocumented export fails `check:memoriahub-package-docs`.

## The README

Every package README has this shape; `scripts/memoriahub-packages/check-package-docs.mjs` enforces it. The first heading is `# @marinoscar/memoriahub-<pkg>` followed by a one-paragraph summary, then exactly these fifteen `##` sections in this order, each with text (write "None." and the reason when there is nothing to say):

1. **Purpose and scope** - what the package owns and does not. Holds a line `Status: <state>` and the list of entry points, each with a link to its slice README.
2. **Install and peer dependencies**
3. **Quick start**
4. **Configuration**
5. **Extension-point catalog** - every symbol tagged `@extensionPoint`, by name.
6. **Data**
7. **Permissions and settings**
8. **UI**
9. **Infra**
10. **Observability**
11. **Security notes**
12. **Conformance suite** - the executable proof a binding or host is correct.
13. **Upgrade notes**
14. **Troubleshooting**
15. **Links**

The checker also requires that the README names every `exports` entry (`@marinoscar/memoriahub-compute/image`; the root is the package name) and that every relative link resolves.

A **slice README** (`src/<slice>/README.md`) has the title `# <slice>`, a sentence, then five `##` sections: **Purpose and scope**, **Entry point**, **Peer dependencies**, **Configuration** and **Extension-point catalog**.

## TSDoc

Every exported declaration (variable, function, class, interface, type alias, enum, and each public method or accessor) carries a TSDoc comment; TypeDoc rejects an undocumented export (`typedoc.base.json` `requiredToBeDocumented`). A package whose option and result interfaces are described by the comment of the interface may drop `"Property"` from the list in its own `typedoc.json`, with a comment saying why (the compute package does). Two block tags are declared in the root `tsdoc.json` on top of TypeDoc's:

| Tag | Meaning | Checked by |
|---|---|---|
| `@stability stable\|experimental\|deprecated` | The compatibility promise. Required on every top-level export of an entry point (a root re-export is checked on its target). | `check-package-docs.mjs` (`api-reference`) |
| `@extensionPoint` | The symbol is something a host or app implements, provides or registers. It must be named in the README's "Extension-point catalog". | `check-package-docs.mjs` (`api-reference`) |

```ts
/**
 * Where the command writes.
 *
 * @stability experimental
 */
```

Describe behaviour and the reason in the comment, name units, and use `{@link Symbol}` for references (an unresolved link fails TypeDoc). A file-level comment must be followed by its own block on the first export, or TypeDoc attaches the file comment to that export.

## TypeDoc and the API reference

`typedoc.base.json` holds the shared options (private and internal members excluded, validation of undocumented, unexported and unresolved items treated as errors, the two extra block tags). Each package's `typedoc.json` extends it and sets `tsconfig`, `entryPoints` (one `./src/<slice>/index.ts` per exported subpath, `./src/index.ts` for the root), `out` (`docs-api/html`) and `json` (`docs-api/api.json`). The `docs-api/` folder is generated and git-ignored.

```bash
npm run docs:memoriahub-packages          # TypeDoc for the packages
npm run check:memoriahub-package-docs     # docs, then the standard above
```

## Adding a slice

1. Create `packages/memoriahub-<pkg>/src/<slice>/index.ts` and `README.md` (the five sections).
2. Add the slice to `packages/memoriahub-slices.json` with the slices it imports, and to `packages/memoriahub-slice-peers.json` with the packages its files import.
3. Add the entry to the package's `exports` and `typedoc.json` `entryPoints` (and a `<slice>/package.json` stub if the package ships them, plus the folder in `files`).
4. Add a peer to `package.json` only if the slice imports a package the package does not list yet.
5. Name the new subpath in the package README and link the slice README there.
6. Add a changeset (`npx changeset`).
7. Run `build:memoriahub-packages`, `check:memoriahub-slice-peers`, `check:memoriahub-package-docs` and `check:memoriahub-pack`.

## Peer dependencies per slice

Libraries with module-level state (Nest's container, React's dispatcher, Zod's classes, MUI's theme) must exist once in a host. The packages declare them as **peers**, and `scripts/memoriahub-packages/check-slice-peers.mjs` keeps the declaration, the per-slice data and the source in agreement. Print the table with `node scripts/memoriahub-packages/check-slice-peers.mjs --table`.

The compute package is the exception that is declared in the data: its libraries (`sharp`, `onnxruntime-node`, `exifr`, `zod`, optional `tesseract.js`) are **exact-pinned dependencies**, not peers, so the server and a node run byte-identical native builds (the repository root repeats the pins in `overrides`). Every slice there lists no peer.

Data lives in two files (both append-only): `packages/memoriahub-slices.json` (slice -> slices it may import) and `packages/memoriahub-slice-peers.json` (per package and slice, `{ "peers": [...] }`, plus `$universal`, `$implies`, `$reserved`, `$hostOnly` and `$hostPlugins`). `$universal` names the slices every consumer gets (`"*"` for all): their peers are the package's **required** peers, any other peer must be `optional` in `peerDependenciesMeta`. `$implies` lets a listed peer bring others. `$reserved` holds optional peers declared ahead of the slice that imports them. `$hostOnly` holds peers no slice may import. `$hostPlugins` holds Fastify plugins the host must register. A web slice may add `entries` (`headless`, `ui`, `testing`).

The rules (each violation prints as `[rule] message`): **graph**, **peers-data**, **manifest**, **imports**, **app-installs** (with `--app <dir>`; CI passes `apps/api` and `apps/cli`), **host-neutral**, **headless** and **host-plugins**. Their full text is the header of `check-slice-peers.mjs`.

A `@marinoscar/platform-*` peer is pinned to one exact version (`check:platform-pin` requires it of every entry in the repository), so these peers move with the platform pin.

## The contract peer range

When `@marinoscar/memoriahub-contract` exists (J2), `-api` and `-web` list it as a required peer with the range `>=0.0.0-0 || >=0.1.0-0`. Changesets bumps the major version of a package whose peer receives a minor bump, even in a `fixed` group, unless `.changeset/config.json` sets `onlyUpdatePeerDependentsWhenOutOfRange: true` (it does). A pre-release satisfies a range only when a comparator names the same `major.minor.patch`, so **before the first pre-release of a new minor line, widen the range** (add `|| >=0.2.0-0`) in both `package.json` files in the same pull request.

## The host-neutral rule

**No file under `packages/memoriahub-compute/src/**` or `packages/memoriahub-contract/src/**` imports `@marinoscar/platform-*`.** The same rule is declared for `memoriahub-api` and `memoriahub-web` with an empty allow-list; the issue that creates each of them states the exact platform specifiers it may import (`HOST_NEUTRAL_ALLOWED` and `HOST_NEUTRAL_SLICE_ALLOWED` in `check-slice-peers.mjs`) with the reason. A worker node installs the compute package with no platform package, and a bare host (J12) installs the packed tarballs with none either. What to do instead: depend on a port the package declares and bind the platform in one place in the app (`apps/api/src/platform`). The rule is executable: `npm run check:memoriahub-slice-peers` fails with `[host-neutral]` naming the file and the specifier, and the fixtures in `scripts/memoriahub-packages/test/fixtures/` pin both outcomes. `npm run check:memoriahub-lean-install` proves the install: it packs the compute package, installs it alone and asserts that no platform package and no provider SDK (`openai`, `@anthropic-ai/sdk`) is in the tree.

## Checks and commands

| Command | What it does |
|---|---|
| `npm run build:memoriahub-packages` | Builds the packages. |
| `npm run typecheck:memoriahub-packages` | `tsc --noEmit` in each. |
| `npm run test:memoriahub-packages` | The package tests (`node --test` for compute: golden vectors, HEIC, ffmpeg argv pins). |
| `npm run test:memoriahub-scripts` | `node --test scripts/memoriahub-packages/test/`: the check scripts against fixtures. |
| `npm run docs:memoriahub-packages` | TypeDoc for the packages. |
| `npm run check:memoriahub-slice-peers` | The eight rules above, for the packages and then for `apps/api` and `apps/cli`. |
| `npm run check:memoriahub-package-docs` | `docs:memoriahub-packages`, then the README, TSDoc and TypeDoc standard. |
| `npm run check:memoriahub-pack` | `npm pack --dry-run` of each package against its manifest. Run after the build. |
| `npm run check:memoriahub-lean-install` | The lean-install smoke above. Needs the build and the registry (for the native dependencies). |
| `npm run check:single-instance` | One copy of every singleton library, of every `@marinoscar/platform-*` package and of every `@marinoscar/memoriahub-*` package. |
| `npx changeset status --since=origin/main` | Fails when a package source changed without a changeset. |
| `npm run version-packages` | `changeset version` and a lockfile refresh. A maintainer step. |

The scripts live in `scripts/memoriahub-packages/` and are modelled on the EnterpriseAppBase scripts of the same names, parameterised by constants at the top (`PREFIX`, `SLICES_FILE`, `PEERS_FILE`). `check-single-instance.mjs` there wraps the repository-wide `scripts/check-single-instance.mjs` and adds `--guard` patterns.

## CI

`.github/workflows/memoriahub-packages.yml` runs on pull requests and pushes that touch `packages/memoriahub-*/**`, `packages/memoriahub-*.json`, `scripts/memoriahub-packages/**`, `.changeset/**` or the workflow itself:

- **build**: install, build, typecheck, the slice-peers check, the script tests, the package tests, the pack check and a smoke import of every entry point from both module systems.
- **package-docs**: TypeDoc and the docs check.
- **single-instance**: the single-instance check over the platform and MemoriaHub packages.
- **changeset-status**: fails a pull request that changes package sources without a changeset.

No job in this workflow publishes. The bare-host job arrives with RETRO-J12. The application images keep their own `deploy.yml` flow, which builds the compute package inside each image and runs the golden-vector and HEIC gates.

## Versioning

Changesets runs in **pre mode** on the `next` tag (`.changeset/pre.json`), so releases are `0.1.0-next.N` on the `next` dist-tag. Add a changeset with `npx changeset` in every pull request that changes a package; `npx changeset --empty` records that a change has no release impact. Do not edit `pre.json` by hand. The versions only move; nothing is published until the owner opens the gate ([runbook](runbooks/release-memoriahub-packages.md)).
