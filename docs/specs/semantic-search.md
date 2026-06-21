# Semantic Search — End-to-End Reference

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
| **Status** | Implemented |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Infrastructure Prerequisite](#2-infrastructure-prerequisite)
3. [Embedding Feature Configuration](#3-embedding-feature-configuration)
4. [Data Model](#4-data-model)
5. [Embedding Pipeline](#5-embedding-pipeline)
6. [Search Algorithm](#6-search-algorithm)
7. [Graceful Degradation](#7-graceful-degradation)
8. [Backfill and Re-Embed](#8-backfill-and-re-embed)
9. [API Reference](#9-api-reference)
10. [Operational Notes](#10-operational-notes)

---

## 1. Overview

Semantic search lets users find photos by describing their visual content in natural language — "birthday cake with candles", "kids laughing in the garden", "sunset over the ocean" — rather than specifying exact metadata. It works by comparing a vector embedding of the user's query against pre-computed embeddings stored for each photo.

Embeddings are generated at the end of every successful [auto-tagging](auto-tagging.md) job. The embedding text combines the photo's AI-generated `description`, `tags`, and any assigned people names into a single string that is fed to an embedding model (currently OpenAI only).

Semantic search is **optional and additive**:

- If the embedding feature is not configured, `POST /api/search` and the agentic `search_media` tool continue to work exactly as before using structured filters only.
- When configured, callers can pass a `semanticQuery` string alongside (or instead of) structured filters to get results ranked by cosine similarity.

---

## 2. Infrastructure Prerequisite

Semantic search requires the **pgvector** Postgres extension. The database image must be `pgvector/pgvector:pg16` (or equivalent) rather than the stock `postgres:16-alpine`.

The `infra/compose/test.compose.yml` was updated to use this image for the integration test database. The development and production compose files must also use a pgvector-capable image before enabling the embedding feature.

**Important:** the `media_item_embedding.embedding` column is `vector(1536)`. Switching to a different embedding model or dimension later requires:
1. Dropping the column (and all stored embeddings).
2. Re-running the tagging backfill for all circles so embeddings are recomputed with the new model.

There is no automatic migration path for dimension changes.

---

## 3. Embedding Feature Configuration

The embedding feature is a separate AI feature setting stored in `system_settings` under `ai.features.embedding`:

```json
{
  "ai": {
    "features": {
      "embedding": {
        "provider": "openai",
        "model": "text-embedding-3-small"
      }
    }
  }
}
```

Set via `PUT /api/ai/features/embedding` (Admin, `ai_settings:write`). The same provider credential already stored via `PUT /api/ai/credentials/openai` is used — no separate credential is needed.

**Provider constraint:** only providers that implement `embedText` can be selected. Currently `openai` is the only supported provider; `anthropic` does not offer an embeddings API and throws if called. Attempting to configure a provider without `embedText` support will silently skip embedding at job time (the tagging step still succeeds).

**Supported OpenAI embedding models:**

| Model | Dimensions | Notes |
|-------|-----------|-------|
| `text-embedding-3-small` | 1536 | Recommended — cost-effective, high quality |
| `text-embedding-3-large` | 3072 | Higher quality but requires matching the DB column dimension |

The `media_item_embedding` table is created with `vector(1536)` so only 1536-d models are usable without a schema change.

**Admin UI — AI Description Search:** The AI Settings page exposes a dedicated "AI Description Search" section where an admin can enable the embedding feature, select the OpenAI model, and click "Test" to verify connectivity. The Test button calls `POST /api/ai/test/embedding` and surfaces a dimension-mismatch warning (dimensions != 1536) inline before the admin saves the configuration. Embeddings require OpenAI credentials (`PUT /api/ai/credentials/openai`) — no other provider supports `embedText`. The embedding model list is retrieved via `GET /api/ai/models?provider=openai&capability=embedding`.

---

## 4. Data Model

### `media_item_embedding`

One row per media item. Written and queried exclusively via raw SQL using pgvector operators — Prisma cannot read/write `Unsupported("vector(1536)")` columns directly.

| Column | Type | Notes |
|--------|------|-------|
| `media_item_id` | UUID PK | FK → `media_items` (cascade delete) |
| `circle_id` | UUID | Denormalized from `media_items`; no FK constraint; used for efficient circle-scoped KNN |
| `embedding` | `vector(1536)` | pgvector column; not visible to Prisma |
| `model` | String | Name of the embedding model that produced this vector |
| `updated_at` | Timestamptz | Auto-updated on each upsert |

An HNSW cosine index exists on the `embedding` column:

```sql
CREATE INDEX ON media_item_embedding USING hnsw (embedding vector_cosine_ops);
```

An additional `btree` index on `circle_id` allows the KNN query to filter by circle efficiently.

### `media_items.description`

A nullable text column on `media_items` written by the auto-tagging handler:

| Column | Max length | Notes |
|--------|-----------|-------|
| `description` | 8 192 chars | 1–3 sentence description; always overwritten on successful parse |

There is no `title` column on `media_items`.

---

## 5. Embedding Pipeline

Embedding is the final step of every successful `auto_tagging` enrichment job, implemented in `AutoTaggingService.embedAndStore`.

```
description + tag names + people names
         ↓ joined with ". "
    embedding text string
         ↓ embedText(creds, model, text)
    float[] vector (1536-d)
         ↓ INSERT ... ON CONFLICT DO UPDATE (raw SQL)
    media_item_embedding row
```

**Embedding text construction:**

```typescript
const text = [description, ...tagNames, ...peopleNames]
  .filter(Boolean)
  .join('. ');
```

If the resulting string is empty (e.g. no description, no tags, no people), `embedAndStore` returns early without making an API call.

**Best-effort semantics:** `embedAndStore` wraps all logic in a try/catch. Any failure — provider not configured, credential error, `embedText` not implemented, API error, SQL error — is logged as a warning and swallowed. Embedding failures **never** flip `media_tag_status` to `failed` and **never** cause the enrichment job to retry.

**Upsert behavior:** the raw SQL uses `ON CONFLICT (media_item_id) DO UPDATE`, so re-running auto-tagging always overwrites the stored embedding with the current output.

---

## 6. Search Algorithm

### `semanticQuery` on `POST /api/search`

Add a `semanticQuery` string to the request body alongside the existing `filters` object:

```json
{
  "circleId": "uuid",
  "semanticQuery": "birthday cake with candles",
  "filters": { "capturedAt": { "from": "2024-01-01" } },
  "page": 1,
  "pageSize": 20
}
```

`semanticQuery` is a string of 1–512 characters. It is validated by the DTO but is **not** in `SEARCHABLE_FIELDS` and is not a structured filter key — passing it inside `filters` has no effect.

**Algorithm when `semanticQuery` is provided and embedding succeeds:**

1. **Embed the query** — call `SemanticSearchService.embedQuery(semanticQuery)` using the configured provider and model. Returns `null` on any failure (see [Section 7](#7-graceful-degradation)).
2. **KNN query** — call `SemanticSearchService.knnMediaIds(circleId, vec, knnLimit)`:
   ```sql
   SELECT e.media_item_id AS id, (e.embedding <=> $vector::vector) AS distance
   FROM media_item_embedding e
   JOIN media_items m ON m.id = e.media_item_id
   WHERE e.circle_id = $circleId AND m.deleted_at IS NULL
   ORDER BY e.embedding <=> $vector::vector
   LIMIT $knnLimit
   ```
   `knnLimit = min(max(pageSize × 5, 100), 500)` — a superset large enough that the filter intersection can still produce a full page.
3. **Intersect with structured filters** — build the standard `WHERE` clause from `filters` and AND it with `id IN (orderedIds)`, then fetch matching items in one query (no database-level pagination).
4. **Re-order in application** — sort the intersection by the KNN distance rank (closest first).
5. **Paginate in application** — slice `[start, start + pageSize]`.

Results are ordered by semantic similarity (ascending distance), not by `sortBy`/`sortOrder`. The `sortBy` and `sortOrder` fields in the request body are ignored when a `semanticQuery` is present and the embedding succeeds.

### `semanticQuery` on the agentic `search_media` tool

The agent's `search_media` tool also accepts `semanticQuery` as a top-level parameter. It delegates to the same `SearchService.runSearch` path. The agent system prompt instructs the model when to prefer semantic vs structured filters:

- Use `semanticQuery` for visual content, mood, activity, or scene descriptions.
- Use structured filters for concrete metadata (dates, places, people, type, favorite).
- Both can be combined in one call for hybrid search.

`GET /api/search/fields` returns a descriptor for `semanticQuery` (appended after the registry fields) so the frontend filter builder and the agent tool schema are aware of it. It is surfaced as a `string`-type field with the description:

> Natural-language description of photo content; ranks results by semantic similarity. Requires the embedding feature to be configured in AI Settings. Can be combined with structured filters for hybrid search.

---

## 7. Graceful Degradation

The entire semantic search path degrades gracefully when the embedding feature is unavailable or fails:

| Condition | Behavior |
|-----------|---------|
| Embedding feature not configured in system settings | `embedQuery` returns `null`; falls back to filter-only search |
| Provider credential missing or decryption error | `embedQuery` returns `null`; falls back to filter-only search |
| Provider does not implement `embedText` (e.g. Anthropic) | `embedQuery` returns `null`; falls back to filter-only search |
| Provider API error during query embedding | `embedQuery` returns `null`; falls back to filter-only search |
| pgvector extension not installed | Raw SQL throws; `embedQuery` swallows and returns `null`; falls back to filter-only |
| KNN returns 0 results | Returns empty result set immediately (no filter-only fallback) |
| `semanticQuery` not provided | Normal filter-only path; no embedding call made |

In all fall-back cases, the search endpoint returns a valid (non-error) response. No `4xx` or `5xx` is returned solely because the embedding feature is not configured.

---

## 8. Backfill and Re-Embed

### Backfill via `POST /api/tagging/backfill`

The existing backfill endpoint enqueues `auto_tagging` jobs for photos in a circle. Because embedding is the final step of every successful tagging job, backfilling also produces embeddings for all processed items — no separate embedding backfill endpoint exists.

Items that have already been tagged but have no embedding (e.g. photos tagged before the embedding feature was enabled) can be re-embedded by running backfill with `"force": true`, which re-processes all items regardless of their current `processed` status.

### Re-Embed on People Change

When face assignments change for a media item — via assign, unassign, merge, or soft-delete in the People API — the `PeopleService` automatically re-enqueues an `auto_tagging` job (priority 0, reason `rerun`) for each affected item, gated on the circle's `autoTaggingEnabled`. This refreshes the description and embedding to incorporate the updated people names.

See [auto-tagging.md — People-Change Re-Enqueue](auto-tagging.md#people-change-re-enqueue) for details.

---

## 9. API Reference

### `PUT /api/ai/features/embedding`

Set the active AI provider and model for text embedding.

- **Auth**: Admin role + `ai_settings:write`
- **Request body**:
  ```json
  { "provider": "openai", "model": "text-embedding-3-small" }
  ```
  Both fields accept `null` to clear the setting (disables embedding).
- **Response** `200`:
  ```json
  { "provider": "openai", "model": "text-embedding-3-small" }
  ```

### `POST /api/search` — `semanticQuery` parameter

Standard deterministic search with optional semantic ranking. See [Search Algorithm](#6-search-algorithm) for full behavior.

- **Auth**: `media:read` + `search:use`
- **Body** (excerpt — full schema in [agentic-search.md](agentic-search.md)):
  ```json
  {
    "circleId": "uuid",
    "semanticQuery": "birthday cake with candles",
    "filters": {},
    "page": 1,
    "pageSize": 20
  }
  ```
  `semanticQuery`: optional string, 1–512 characters.

### `GET /api/search/fields`

Returns the field descriptor for `semanticQuery` appended after the registry fields. The descriptor is hand-authored and not part of `SEARCHABLE_FIELDS` (to avoid triggering the unknown-key guard in `buildWhereFromFields`).

### `POST /api/search/agent` — `semanticQuery` in tool calls

The agentic search tool `search_media` accepts `semanticQuery` as a top-level parameter. Behavior is identical to the deterministic endpoint. See [agentic-search.md — Section 5](agentic-search.md#5-agent-tool-calling-loop) for the tool-call loop.

---

## 10. Operational Notes

### Monitoring

- Embedding failures appear as `WARN` log lines from `AutoTaggingService` (`embedAndStore`) and `SemanticSearchService` (`embedQuery`).
- Items without an embedding row (because embedding was not configured at tagging time, or because the run failed) will return no semantic results for that item. Use `force: true` backfill to backfill embeddings after enabling the feature.
- The `/admin/jobs` dashboard shows `auto_tagging` job outcomes. Embedding failures do not affect the displayed job status — a job can show `succeeded` even if its embedding step was skipped or failed.

### Model and Dimension Lock

The `media_item_embedding` table is fixed at `vector(1536)`. Changing the embedding model to one with a different output dimension (e.g. `text-embedding-3-large` which produces 3072-d) requires a database migration to drop and recreate the column with the new dimension, followed by a full backfill. Plan for this before changing models in a production environment.

### pgvector Index

An HNSW index is created on `embedding` for efficient approximate nearest-neighbor search. For very large libraries (millions of items) the index build time and memory requirements should be planned ahead of enabling the feature.
