# ADR-0001: Packages first: domain code is written once, in a package, and mounted by every host

- Status: Accepted
- Date: 2026-11-10
- Related issues: epic #558, program #555, #593 (this decision's first implementation)

## Context

MemoriaHub is moving onto the EnterpriseAppBase platform packages (`@marinoscar/platform-*`). The platform owns the generic slices (identity, settings, jobs, storage, notifications, AI, and so on). What stays MemoriaHub's own is the domain: media, albums, people and faces, the enrichment handlers, workflows, memories, public sharing, the Android media sync. If that domain stays inside `apps/api` and `apps/web`, it can only ever be reused by copying it, and every host that needs it (a worker node, a bare host that proves the packages install outside this repository, a future second front end) forks it. The kvox project met the same question and answered it with ADR-0001 of its repository; this ADR adopts that answer.

One piece of domain code is already a package: `packages/enrichment-compute`, the pure enrichment compute imported identically by the API and by a worker node so that a node-computed vector is numerically identical to a server-computed one. It was internal (`@memoriahub/enrichment-compute`, `"private": true`) and carried an `./ai` subpath that depended on `@anthropic-ai/sdk` and `openai`, which the platform's AI rule forbids outside `@marinoscar/platform-ai-providers`.

## Decision

All domain behaviour lives in `@marinoscar/memoriahub-*` packages. A host contains only:

- port bindings (the platform ports and the domain ports the packages declare);
- the shell (navigation, settings hub, theme);
- packaging (Dockerfiles, compose files, workflows);
- host-specific glue (settings namespaces, onboarding, branding).

The hosts are the web edition (`apps/api` and `apps/web`), the CLI and worker node (`apps/cli`, on `@marinoscar/platform-cli`) and, from RETRO-J12, a bare host that installs the packed tarballs outside the repository. Rules:

1. A feature needed by more than one host is implemented in a package first, then mounted by each host.
2. A host never copies or forks slice code, prompts, schemas or parsers.
3. If a host needs different behaviour, that is an option of the package (a `forRoot` option or a port), not a fork.
4. New shared code that is not yet a package moves into a package before a second host uses it.

The packages are one Changesets `fixed` group in pre mode on the `next` tag, so a consumer never mixes versions: `@marinoscar/memoriahub-compute`, `-contract`, `-db`, `-api` and `-web` (each name is added to the group by the issue that creates the package). The first member is `@marinoscar/memoriahub-compute` (this issue).

Decisions made with the first package:

1. **Name and scope.** `@marinoscar/memoriahub-*`, matching the fixed group and the platform scope, not a separate `@memoriahub/*` scope.
2. **The compute package has no `./ai` subpath.** Provider SDKs are forbidden outside `@marinoscar/platform-ai-providers`, and AI jobs are server-only (a node never holds a provider key). The only importer of `./ai` was the server's video tagging service, which used its SDK-free prompt builder; that prompt moved to `apps/api/src/tagging/video-tagging-prompt.ts` (it lands in the tagging slice package later) and the SDK code and the `openai` and `@anthropic-ai/sdk` dependencies were deleted.
3. **Publishing is gated, and closed.** The owner has not chosen the registry for MemoriaHub's own domain code (public npm, a private registry or GitHub Packages). Until then every `@marinoscar/memoriahub-*` package keeps `"private": true` and `"license": "UNLICENSED"`, with its publish metadata ready (`publishConfig`, `repository.directory`, `files`, `engines`). Changesets versioning, `npm pack`, the pack check and the lean-install check all work for a private package. The tooling must not be able to publish by default: no job runs `npm publish`, no npm token exists, no package name is claimed. The one documented switch that opens the gate is in [the release runbook](../runbooks/release-memoriahub-packages.md#the-publish-gate).

## Consequences

- A host feature waits for the package release that carries it (until the gate opens, for the workspace version of the package).
- Each feature costs more upfront work: a package API, tests, a changeset.
- In return there is one implementation of each domain behaviour, one fix reaches every host, and the packages are proven installable by the checks below rather than by trust.
- While the gate is closed, a consumer outside this repository cannot install the packages. The bare host (J12) therefore installs packed tarballs, which do not need a registry.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep the domain in `apps/api` and `apps/web` | Reuse means copying; the worker node already shows the cost (a parity package exists only because two copies would drift). |
| Publish `@memoriahub/*` under its own scope | A second scope to own and a fixed group that spans two scopes; the platform scope already exists. |
| Keep `./ai` in the compute package for the node | A node no longer calls AI (server-only AI jobs); leaving the SDKs would keep a provider key path to a remote machine. |
| Publish the first package now | The registry and the license are the owner's decision, and publishing cannot be undone (`npm unpublish` is limited). |

## Enforcement

- `npm run check:memoriahub-slice-peers`: slice graph, peers, imports, and the host-neutral rule (the compute package imports no `@marinoscar/platform-*`) ([../PACKAGES.md](../PACKAGES.md)).
- `npm run check:memoriahub-package-docs` and `npm run check:memoriahub-pack` ([../PACKAGES.md](../PACKAGES.md)).
- `npm run check:single-instance` guards `@marinoscar/platform-*` and `@marinoscar/memoriahub-*` against a second copy.
- `.github/workflows/memoriahub-packages.yml` runs the checks and `npx changeset status` on every package change.
- The golden-vector parity test and the HEIC gate in `.github/workflows/deploy.yml` (`REQUIRE_HEIC_DECODE=1`) against the package.
- The `ai-no-sdk-leak` conformance suite of the API.
- Review checklist item: "no domain logic copied into a host".

## Related issues

Epic #558 (RETRO-J, domain packages); program #555; #593 (RETRO-J1); J2 to J4, J11 and J12 build on it.
