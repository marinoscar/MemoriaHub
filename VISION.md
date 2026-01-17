# MemoriaHub Vision

## Purpose
MemoriaHub is a **family memory hub** that stores photos and videos safely, keeps them searchable and organized, and guarantees you always have a copy, even when a cloud service is unavailable.

## Why this exists
- Photos and videos are among a family’s most valuable assets.
- Cloud libraries are convenient, but **control** and **portability** matter.
- A system you cannot observe is a system you cannot trust.

## Product promise
1. **You own your media** (no vendor lock-in).
2. **Redundancy by design** (cloud + local options; replication).
3. **Privacy-first** (private by default; sharing is explicit).
4. **Searchable and intelligent** (metadata, location, people, objects).
5. **Transparent operations** (logs, metrics, traces, audits).

## Guiding principles
- **API-first**: everything the UI can do is exposed via the API.
- **Agent-built**: coding agents implement; humans own architecture and acceptance.
- **Observable-by-default**: every user journey is traceable end-to-end.
- **Fail safely**: uploads should not be lost; partial failures are diagnosable.
- **Small increments**: ship vertical slices (upload → process → view) early.

## Core user outcomes
- Upload/sync photos and videos easily.
- Browse timeline/grid and view details.
- Search by:
  - Date
  - Location
  - People
  - Tags/objects
- Share safely:
  - Private libraries
  - Shared libraries (invites)
  - Public links (explicit)
- Ask natural-language questions (chat-driven retrieval) that are converted into safe, authorized filters.

## What “done right” feels like
- A parent can find “Lucia at the beach in Costa Rica” in seconds.
- You can verify where any upload is in the pipeline (trace + job status).
- When something fails, the UI points you to a diagnosable reason.

## Non-negotiables
- OAuth auth (no password storage)
- HTTPS everywhere
- Audit logging for sensitive actions
- OpenTelemetry instrumentation in every service
- Tests + CI are mandatory from day one
