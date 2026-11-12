# Runbook: release the `@marinoscar/memoriahub-*` packages

Use this to understand how the MemoriaHub domain packages are versioned and packed, to open the publish gate when the owner has chosen a registry, and to roll a release back. The layout and checks of the packages are in [../PACKAGES.md](../PACKAGES.md); the decision is [ADR-0001](../decisions/0001-packages-first.md). The workflow is `.github/workflows/memoriahub-release.yml`.

## Status: publishing is gated, and the gate is closed

The owner has not yet chosen where MemoriaHub's own domain code is published (public npm, a private registry or GitHub Packages) or under which license. **This is an open decision.** Until it is made:

- every `@marinoscar/memoriahub-*` package has `"private": true` and `"license": "UNLICENSED"`, with `publishConfig`, `repository.directory`, `files` and `engines` ready;
- no package name is claimed on any registry, and nothing has ever been published;
- the repository defines no registry secret or variable (`MEMORIAHUB_REGISTRY_TOKEN` is the name the workflow expects; it does not exist);
- no workflow runs on a push, a tag or a schedule to release or version anything: the release workflow and the version workflow (`memoriahub-version.yml`) are `workflow_dispatch` only;
- versioning, `npm pack`, `check:memoriahub-pack`, `check:memoriahub-lean-install` and `check:memoriahub-bare-host` all work for a private package, so the packages are proven installable without being published.

## What the release workflow does

`memoriahub-release.yml`, started by hand from the Actions tab (Run workflow):

1. **Dry run (the default).** Inputs `publish` = `false`. The `dry-run` job installs with `ONNXRUNTIME_NODE_INSTALL=skip`, builds the five packages, runs `check:memoriahub-pack` and `check:memoriahub-lean-install`, runs `npm pack` for each, and uploads the tarballs as the artifact `memoriahub-package-tarballs`. It uses no secret and contacts no registry with a credential. (`npm publish --dry-run` is not used: npm refuses a private package even for a dry run.)
2. **Publish (only on purpose).** The `publish` job runs only when the dispatch sets `publish` = `true` **and** `confirm` = `publish`. Its first step fails unless the secret `MEMORIAHUB_REGISTRY_TOKEN` is configured. It runs in the `npm-publish` environment, publishes each package with `--tag next --provenance --access public`, and never uses `latest`. While the packages are `"private": true`, `npm publish` refuses each one, so it cannot publish even when the secret exists.

A script test (`npm run test:memoriahub-scripts`) fails if the workflow gains a trigger other than `workflow_dispatch`, a secret other than the one above, or a `latest` tag, or if a package stops being private without the test being changed on purpose.

## Versioning

The packages are one Changesets `fixed` group in **pre mode** on the `next` tag, so they always share one version and every release is `0.1.0-next.N` on the `next` dist-tag.

1. A pull request that changes a package carries a changeset (`npx changeset`); `memoriahub-packages.yml` fails it otherwise.
2. A maintainer runs `npm run version-packages` in a pull request (`changeset version` and a lockfile refresh): versions, a `CHANGELOG.md` per package, `.changeset/pre.json` listing the consumed changesets. Review that all versions are equal and the lockfile diff is limited to workspace entries. The only workflow that can open this pull request is `memoriahub-version.yml`, run by hand: by default it is a dry run that uploads the diff as an artifact and pushes nothing; it opens the pull request only when dispatched with `open_pr` = `true` and `confirm` = `version`, using the workflow's own `GITHUB_TOKEN` (no secret). It never publishes.
3. After it merges, dispatch the release workflow as a dry run and inspect the tarballs: `tar -tzf` each one shows only `dist/`, the subpath stub folders, `schema/`, `migrations/` and the inventories for the db package, `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json`.

## The publish gate

Opening the gate is one owner action, in this order, and nothing before step 4 can publish anything:

1. **Choose the registry and the license** and record both in a new ADR (or an addendum to ADR-0001). A private registry needs its URL in `publishConfig.registry` of each package.
2. **Add a `LICENSE`** at the repository root with the chosen license. In each `packages/memoriahub-*/package.json` set `"license"` to it and set `PUBLISH_LICENSE` in `scripts/memoriahub-packages/check-package-pack.mjs` to the same value (`MIT` by default). From then on `check:memoriahub-pack` requires a `LICENSE` in every tarball of a package that is not private.
3. **Configure the credential** on the chosen registry and store it as the repository (or `npm-publish` environment) secret `MEMORIAHUB_REGISTRY_TOKEN`. Create the `npm-publish` GitHub environment with a required reviewer and the deployment branch limited to `main`. If the registry supports trusted publishing (OIDC), change the workflow to use it and drop the token in the same pull request; the `publish` job already has `id-token: write`.
4. **The switch**, in one pull request: remove `"private": true` from each `packages/memoriahub-*/package.json`, and update the guard test in `scripts/memoriahub-packages/test/memoriahub-packages.test.mjs` that asserts the packages are private. Then rehearse with a dry run, and dispatch the workflow with `publish` = `true` and `confirm` = `publish`.

A first publish of a new package name cannot be undone by `npm unpublish` for long: rehearse, and read the tarball list first.

## Verifying a publish

`npm view @marinoscar/memoriahub-compute@next version` for each package (all equal), and `npm audit signatures` in a project that installed them.

## Rolling back

**Before a version pull request merges:** close it. Nothing was published.

**After a publish:** never `npm unpublish` a version a consumer may have installed. Move the dist-tag back (`npm dist-tag add @marinoscar/memoriahub-<pkg>@<good version> next`) and deprecate the bad one (`npm deprecate "@marinoscar/memoriahub-<pkg>@<version>" "<reason>; use <next version>"`), then release a fixed version. To stop publishing at once, delete the `MEMORIAHUB_REGISTRY_TOKEN` secret: the publish job stops in its first step.

**Reverting the tooling:** revert the pull request that introduced it. A published `next` version stays on the registry but unused.

## Leaving pre mode

Pre mode ends when the packages are ready for a stable `latest` release (an owner decision): `npx changeset pre exit` in a pull request with a changeset, then run `npm run version-packages` (the versions become stable and `.changeset/pre.json` is deleted). The workflow would then also need a `latest` path, which it deliberately does not have today. To go back to pre-releases later, `npx changeset pre enter next`.

## Web edition and published versions

The web edition (`apps/api`, `apps/web`) consumes the packages through the npm workspace during development, and its production images build them from the workspace (`deploy.yml` is unchanged). Published versions are for external hosts only: a host outside this repository (see `examples/bare-host`) installs a packed or published tarball.

## Links

- [PACKAGES.md](../PACKAGES.md): layout, README and TSDoc standard, peers per slice, the host-neutral rule, the bare host
- [../../examples/bare-host/README.md](../../examples/bare-host/README.md)
- [ADR-0001: packages first](../decisions/0001-packages-first.md)
- [DEVELOPMENT.md](../DEVELOPMENT.md): repository tooling
