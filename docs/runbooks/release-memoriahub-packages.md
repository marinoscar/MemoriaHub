# Runbook: release the `@marinoscar/memoriahub-*` packages

Use this to understand how the MemoriaHub domain packages are versioned, to open the publish gate when the owner has chosen a registry, and to roll a release back. The layout and checks of the packages are in [../PACKAGES.md](../PACKAGES.md); the decision is [ADR-0001](../decisions/0001-packages-first.md). The release workflow (RETRO-J12) will be `.github/workflows/memoriahub-release.yml`, modelled on the EnterpriseAppBase release workflow (`release-platform-packages.md` and `release.yml` there).

## Status: publishing is gated, and the gate is closed

The owner has not yet chosen where MemoriaHub's own domain code is published (public npm, a private registry or GitHub Packages) or under which license. Until then:

- every `@marinoscar/memoriahub-*` package has `"private": true` and `"license": "UNLICENSED"`, with `publishConfig`, `repository.directory`, `files` and `engines` ready;
- no workflow runs `npm publish`, no npm token exists (none is ever needed: publishing uses OIDC trusted publishing), no package name is claimed on any registry, and no repository variable or secret for a registry is set;
- versioning, `npm pack`, `check:memoriahub-pack` and `check:memoriahub-lean-install` all work for a private package, so the packages are proven publishable without being published.

## How a release works (once the gate is open)

The packages are one Changesets `fixed` group in **pre mode** on the `next` tag, so they always share one version and every release is `0.1.0-next.N` on the `next` dist-tag.

1. A pull request that changes a package carries a changeset (`npx changeset`); `memoriahub-packages.yml` fails it otherwise.
2. After the change merges to `main`, the version job (J12) opens a pull request that runs `changeset version` (six versions, changelogs, lockfile refresh).
3. Merging it pushes to `main` with no pending changeset. The release gate job asks the registry whether the names and the version exist, with no credentials; any registry error means "not ready".
4. **Dry run by default.** The publish job runs only when the repository variable `NPM_PUBLISH_ENABLED` is `true` and the gate is ready, in a protected environment with an OIDC token (`id-token: write`) and `NPM_CONFIG_PROVENANCE=true`. In every other case the workflow builds, packs and runs `npm publish --dry-run`, then uploads the tarballs as an artifact. It never passes `--tag latest`; the dist-tag comes from `.changeset/pre.json`.

## The publish gate

Opening the gate is one owner action, in this order, and nothing before step 4 can publish anything:

1. **Choose the registry and the license** and record both in a new ADR (or an addendum to ADR-0001). The compute package, the contract and the db package do not depend on the registry; a private registry needs its URL in `publishConfig.registry` of each package.
2. **Add a `LICENSE`** at the repository root with the chosen license. In each `packages/memoriahub-*/package.json` set `"license"` to it and set `PUBLISH_LICENSE` in `scripts/memoriahub-packages/check-package-pack.mjs` to the same value (`MIT` by default). From then on `check:memoriahub-pack` requires a `LICENSE` in every tarball of a package that is not private.
3. **Bootstrap the names and trusted publishers** on the chosen registry exactly as in the EnterpriseAppBase runbook: publish a `0.0.0-bootstrap` placeholder of each package under the `bootstrap` tag from a scratch copy, then attach the trusted publisher (repository `marinoscar/MemoriaHub`, workflow filename `memoriahub-release.yml`, environment `npm-publish`) to each package. Create the `npm-publish` GitHub environment with a required reviewer and the deployment branch limited to `main`.
4. **The switch, in two parts, in one pull request plus one setting:**
   - remove `"private": true` from each `packages/memoriahub-*/package.json` (the pack check then enforces the license and the `LICENSE` file);
   - set the repository variable `NPM_PUBLISH_ENABLED` to `true` (Settings, Secrets and variables, Actions, Variables).

   Leave the variable unset or `false` to keep every release a dry run, whatever the manifests say.

## Releasing

1. Merge the pull request that carries the changeset; review the version pull request (all versions equal, a `CHANGELOG.md` per package, the lockfile diff limited to workspace entries, `.changeset/pre.json` listing the consumed changesets).
2. Merge it and watch the gate and the publish (or dry-run) job.
3. Verify the dist-tag and signatures: `npm view @marinoscar/memoriahub-compute@next version` for each package (all equal) and `npm audit signatures` in a project that installed them.

To inspect a dry run, download the tarball artifact and `tar -tzf` each tarball: only `dist/`, the subpath stub folders, `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json`.

## Rolling back

**Before a version pull request merges:** close it. Nothing was published.

**After a publish:** never `npm unpublish` a version a consumer may have installed. Deprecate it (`npm deprecate "@marinoscar/memoriahub-<pkg>@<version>" "<reason>; use <next version>"`) and release a fixed version. To stop publishing at once, set `NPM_PUBLISH_ENABLED` to `false`; releases fall back to the dry run.

**Reverting the tooling:** revert the pull request that introduced it. The rename of the compute package is a `git mv`; the importers revert with it. A published `next` version stays on the registry but unused.

## Leaving pre mode

Pre mode ends when the packages are ready for a stable `latest` release (an owner decision): `npx changeset pre exit` in a pull request with a changeset, then merge the version pull request that follows (the versions become stable and `.changeset/pre.json` is deleted). To go back to pre-releases later, `npx changeset pre enter next`.

## Links

- [PACKAGES.md](../PACKAGES.md): layout, README and TSDoc standard, peers per slice, the host-neutral rule
- [ADR-0001: packages first](../decisions/0001-packages-first.md)
- [DEVELOPMENT.md](../DEVELOPMENT.md): repository tooling
