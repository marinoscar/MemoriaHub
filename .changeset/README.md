# Changesets

This folder holds the pending release notes of the `@marinoscar/memoriahub-*`
packages (today `memoriahub-compute`; the contract, db, api and web packages
join the `fixed` group in [`config.json`](config.json) as the issues that create
them land), which always share one version. The standard, the checks and the
release procedure are in [`docs/PACKAGES.md`](../docs/PACKAGES.md) and
[`docs/runbooks/release-memoriahub-packages.md`](../docs/runbooks/release-memoriahub-packages.md).

The packages are `"private": true` until the owner opens the publish gate, so
`config.json` sets `privatePackages.version` to `true` (versions and changelogs
still move) and `privatePackages.tag` to `false`. Nothing is published from this
folder.

The applications (`api`, `web`, `@memoriahub/cli`) and `@app/shared` are listed
under `ignore` in `config.json`: they are versioned by their own rules (the CLI
by the version bump described in `CLAUDE.md`), never through a changeset.

- Run `npx changeset` in any pull request that changes a `packages/memoriahub-*`
  package, pick the package(s) and the bump, and write one line of release
  notes for a reader of the changelog. Commit the generated
  `.changeset/<name>.md` with the change. `npx changeset status` (CI) fails a
  pull request that changes a package without one.
- `npx changeset --empty` records that a change has no release impact.
- `pre.json` means the packages are in pre-release mode: releases are
  `x.y.z-next.N` on the `next` dist-tag. Do not edit or delete it by hand.
