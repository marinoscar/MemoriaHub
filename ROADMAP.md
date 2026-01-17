# MemoriaHub Roadmap

This roadmap is intentionally milestone-based (agent-friendly). Each milestone should be turned into epics/issues.

## Milestone 0: Repo foundation
- Monorepo scaffolding (apps + packages)
- CI: lint, typecheck, tests
- Docker Compose dev stack
- Base docs complete

## Milestone 1: Vertical slice (upload → process → view)
- OAuth login (one provider)
- Create a library
- WebDAV upload to S3
- DB records with traceId
- Worker generates thumbnail
- UI grid shows uploaded asset
- Jaeger trace shows full lifecycle

## Milestone 2: Metadata + search basics
- EXIF extraction + display
- GPS extraction + normalized location
- Search by date + location

## Milestone 3: Enrichment (incremental)
- Face detection + person labeling
- Object tagging
- Basic people/tags UI

## Milestone 4: Chat retrieval
- Query → structured filter → results
- Guardrails (authorization + safe filtering)

## Milestone 5: Sharing + audits
- Shared libraries (invites)
- Public link sharing
- Audit log UI + API

## Milestone 6: Redundancy
- Storage adapter interface solidified
- Replication jobs + status UI

## Ongoing: Observability maturity
- Dashboards + alerts
- SLOs and error budgets
- Runbooks expanded
