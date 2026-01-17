# CLAUDE.md (Agent Instructions)

This file is the **operating system** for coding agents working in this repo.

## Prime directive
Build MemoriaHub by implementing **small, testable, observable** increments that match `REQUIREMENTS.md`.

## Repo facts
- Monorepo: `apps/*` and `packages/*`
- Stack: React+TS+MUI, Node+TS, PostgreSQL, S3, WebDAV
- Observability: OpenTelemetry + Prometheus + Grafana + Loki + Jaeger

## How to work (required)
1. Read the relevant requirement (or issue) and restate acceptance criteria in your PR description.
2. Make the smallest change that satisfies it.
3. Add/adjust tests.
4. Add telemetry (logs/metrics/traces).
5. Update docs when behavior changes.

## Commands (must stay accurate)
From repo root (expected):
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `docker compose -f infra/compose/dev.compose.yml up -d`

Each service must provide:
- `npm run dev`
- `npm run test`
- `npm run lint`
- `npm run typecheck`

## Coding rules
- TypeScript `strict: true`
- No `any` unless justified and isolated
- Validate inputs at boundaries (HTTP, WebDAV, job payloads)
- Never log secrets or tokens

## Observability rules (Definition of Done gate)
Every feature MUST include:
- **Structured logs** with `traceId`
- **Metrics** for success/failure + duration
- **Traces** with meaningful spans

A feature is NOT DONE unless:
- it can be diagnosed end-to-end using Grafana (logs/metrics) and Jaeger (traces)

## Testing rules
- Unit tests for core logic
- Integration tests for API routes with auth + authorization
- Worker job tests for pipeline steps
- Tests must be deterministic (no flakiness)

## PR checklist (must include)
- [ ] Meets acceptance criteria
- [ ] Tests added/updated
- [ ] Lint + typecheck pass
- [ ] Telemetry added (logs/metrics/traces)
- [ ] Security reviewed (authz enforced)
- [ ] Docs updated (if needed)

## Task sizing (agent optimization)
Prefer tasks that can be completed in 1–3 focused commits:
- One endpoint
- One UI screen/section
- One worker job type
- One DB migration

If the task is larger, split it into separate issues first.
