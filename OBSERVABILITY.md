# MemoriaHub Observability

Observability is a **first-class requirement**: MemoriaHub is not “running” unless **logs, metrics, and traces** are flowing.

## Goals
MemoriaHub must always answer:
- Is the system healthy?
- Are uploads working?
- Are background jobs progressing?
- Where did a specific asset fail?
- Who accessed what, and when?

## Required stack (Docker-friendly)
- **OpenTelemetry** (mandatory instrumentation)
- **Prometheus** (metrics)
- **Grafana** (dashboards + alerting)
- **Loki** + **Promtail** (logs)
- **Jaeger** (traces)

## OpenTelemetry requirements (non-negotiable)
Instrument:
- API service
- WebDAV ingestion
- Worker service

### Context propagation
A single `traceId` must follow:
Upload → DB record → job enqueue → worker execution → replication

Persist `traceId` on:
- MediaAsset
- IngestionEvent
- ProcessingJob

## Logging (structured JSON)
All services log JSON to stdout.

### Required fields
- timestamp, level, service, env
- traceId, requestId
- userId, libraryId, assetId (when applicable)
- jobId (worker)
- eventType
- durationMs
- error (message + stack)

## Metrics (Prometheus)
Each service exposes `/metrics`.

### Mandatory metrics
**API**
- request count, latency (p50/p95/p99), error rate

**WebDAV**
- uploads count, bytes uploaded, upload latency, upload failures

**Worker**
- job queue depth, job duration by type, job failures, retry count

**Storage**
- S3 latency, S3 error rate

**Database**
- active connections, saturation, disk usage

## Tracing (Jaeger)
Traces must include spans for:
- API request
- DB calls
- Object storage calls
- Job enqueue
- Worker job execution + substeps (EXIF, thumbnails, enrichment)

## Health endpoints
Each service exposes:
- `/healthz` (process health)
- `/readyz` (dependencies reachable)

## Dashboards (minimum)
Create Grafana dashboards:
1. **System overview** (RPS, error rate, latency, worker backlog)
2. **Ingestion** (uploads, bytes, failures, throughput)
3. **Worker jobs** (duration, failures, retries, queue depth)
4. **Storage** (S3 errors/latency)
5. **Database** (connections, slow queries)

## Alerting (high-signal)
Initial alerts:
- API 5xx error rate above threshold
- API p95 latency above threshold
- Worker backlog growing for N minutes
- Job failures spike
- Disk space low
- Storage failures spike

## Runbooks (first set)

### Uploads failing
1. Check WebDAV logs (Loki) for upload failures
2. Check traces by assetId/traceId
3. Verify S3 connectivity + permissions
4. Verify DB connectivity

### Worker backlog growing
1. Check queue depth metric
2. Inspect worker errors + retry counts
3. Increase worker concurrency (if safe)
4. Validate DB contention and S3 latency

### “Where is my photo?”
1. Find MediaAsset record (status + traceId)
2. Open Jaeger trace using traceId
3. Identify failing span and error

## Definition of Done: Telemetry
No feature is complete unless:
- logs show start/end with traceId
- metrics exist for success/failure + duration
- traces include meaningful spans
