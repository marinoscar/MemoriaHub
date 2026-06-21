# Agentic Search Specification

| Field | Value |
|-------|-------|
| **Version** | 2.0 |
| **Last Updated** | June 2026 |
| **Status** | Implemented |
| **Branch** | `feat/ui-immich-overhaul` |

---

## Table of Contents

1. [Motivation and Vision Alignment](#1-motivation-and-vision-alignment)
2. [System Architecture](#2-system-architecture)
3. [Searchable Field Registry](#3-searchable-field-registry)
4. [AI Provider Abstraction](#4-ai-provider-abstraction)
5. [Agent Tool-Calling Loop](#5-agent-tool-calling-loop)
6. [SSE Streaming Protocol](#6-sse-streaming-protocol)
7. [Security Model](#7-security-model)
8. [How to Add a New Search Dimension](#8-how-to-add-a-new-search-dimension)
9. [How to Add a New AI Provider](#9-how-to-add-a-new-ai-provider)
10. [Endpoint and Permission Reference](#10-endpoint-and-permission-reference)
11. [Database Schema](#11-database-schema)

---

## 1. Motivation and Vision Alignment

### Problem

MemoriaHub libraries grow large quickly. A user who has synced several years of family photos may have tens of thousands of items across dozens of locations, camera devices, and date ranges. The existing deterministic `GET /api/media` filter is precise but requires the user to know exactly which fields to combine and which values to use. A query like "show me photos from our trip to Costa Rica last summer" is natural in speech but requires the user to know the `country` field is `"Costa Rica"`, the `capturedAt` date range bounds, etc.

### Vision Alignment

The [VISION.MD](../../VISION.MD) calls out two future search enrichment capabilities:

> **Search by Person** — face recognition so users can find photos of specific family members  
> **Search by Objects and Scenes** — object detection so users can search based on what appears in a photo

Those capabilities require an enrichment pipeline (Phase 09). This feature delivers the conversational search layer that will expose them once the enrichment data exists — without changing the search architecture. The registry-based design means adding face recognition later is a one-line change (see [Section 8](#8-how-to-add-a-new-search-dimension)).

### Intended Outcome

Two complementary search modes are available:

| Mode | Endpoint | Use Case |
|------|----------|----------|
| **Deterministic** | `POST /api/search` | Precise, machine-generated queries (frontend filter builder, CLI) |
| **Agentic** | `POST /api/search/agent` | Natural-language queries with multi-turn refinement, streamed via SSE |

Both modes are powered by the same `SearchableFieldRegistry` and `buildWhereFromFields` helper, which guarantees they never drift apart.

### Stateless Design

Agentic search is **stateless on the server**. No conversation rows, message rows, or history is persisted to the database. The client (frontend or any API consumer) is responsible for maintaining message history in memory and sending the full history with each request. This eliminates the need for conversation lifecycle management and simplifies the server contract to a single SSE endpoint.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        AI / SEARCH SUBSYSTEM                                │
│                                                                             │
│  ┌─────────────────────┐    ┌──────────────────────────────────────────┐   │
│  │ SearchController    │    │ SearchAgentController                    │   │
│  │ POST /search        │    │ POST /search/agent                       │   │
│  │ GET  /search/fields │    │ (stateless SSE — no DB conversation row) │   │
│  └────────┬────────────┘    └──────────────────┬───────────────────────┘   │
│           │                                    │                           │
│           ▼                                    ▼                           │
│  ┌────────────────────┐    ┌──────────────────────────────────────────┐   │
│  │  SearchService     │    │  SearchAgentService                      │   │
│  │  (deterministic)   │    │  (agentic tool-call loop, SSE emitter)  │   │
│  └────────┬───────────┘    └──────────────────┬───────────────────────┘   │
│           │                                    │                           │
│           └────────────────────────────────────┘                           │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  SEARCHABLE FIELD REGISTRY  (single source of truth)               │   │
│  │  searchable-fields.registry.ts                                      │   │
│  │  • 17 fields: type, favorite, capturedAt, albumId, tag, country,    │   │
│  │    region, locality, place, location, cameraMake, cameraModel,      │   │
│  │    sourceDeviceId, sourceDeviceName, missingGeo, noFaces, people    │   │
│  │  • Each field carries: key, label, type, description, buildWhere()  │   │
│  └───────────────────────────────┬─────────────────────────────────────┘   │
│                                   │                                         │
│              ┌────────────────────┴──────────────────────┐                 │
│              ▼                                            ▼                 │
│  ┌─────────────────────────┐          ┌─────────────────────────────────┐  │
│  │  media-where.builder.ts │          │  search-tool-schema.ts          │  │
│  │  Leaf where-clause      │          │  Derives search_media tool      │  │
│  │  helpers (whereType,    │          │  JSON Schema from the registry  │  │
│  │  whereCountry, etc.)    │          │  on every request — no drift    │  │
│  └─────────────────────────┘          └─────────────────────────────────┘  │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  AI PROVIDER REGISTRY                                               │   │
│  │  ai-provider.registry.ts                                            │   │
│  │  • anthropic → AnthropicProvider                                    │   │
│  │  • openai    → OpenAiProvider (also handles OpenAI-compatible APIs) │   │
│  └─────────────────────────────┬───────────────────────────────────────┘   │
│                                 │                                           │
│  ┌──────────────────────────────┼──────────────────────────────────────┐   │
│  │                              ▼                                       │   │
│  │  AiSettingsController   AI settings + credentials management        │   │
│  │  PUT  /ai/credentials/:provider   (Admin — ai_settings:write)       │   │
│  │  DELETE /ai/credentials/:provider (Admin — ai_settings:write)       │   │
│  │  GET  /ai/settings                (Admin — ai_settings:read)        │   │
│  │  POST /ai/test                    (Admin — ai_settings:read)        │   │
│  │  GET  /ai/models                  (Admin — ai_settings:read)        │   │
│  │  PUT  /ai/features/search         (Admin — ai_settings:write)       │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Module Locations

```
apps/api/src/
├── ai/
│   ├── ai.module.ts
│   ├── ai-settings.controller.ts
│   ├── ai-settings.service.ts
│   ├── dto/
│   │   └── ai-credentials.dto.ts
│   └── providers/
│       ├── ai-provider.interface.ts      # AiProvider interface + type defs
│       ├── ai-provider.registry.ts       # Registry: anthropic, openai
│       ├── anthropic.provider.ts         # Anthropic SDK streaming adapter
│       └── openai.provider.ts            # OpenAI SDK streaming adapter (+ compat)
└── search/
    ├── search.module.ts
    ├── search.controller.ts              # POST /search, GET /search/fields
    ├── search.service.ts
    ├── searchable-fields.registry.ts     # SEARCHABLE_FIELDS array + buildWhereFromFields
    ├── media-where.builder.ts            # Leaf where-clause helpers
    ├── dto/
    │   └── search-query.dto.ts
    └── agent/
        ├── search-agent.controller.ts    # POST /search/agent (SSE)
        ├── search-agent.service.ts       # Multi-turn tool-call loop + SSE emitter
        └── search-tool-schema.ts         # Derives search_media tool from registry
```

---

## 3. Searchable Field Registry

**File:** `apps/api/src/search/searchable-fields.registry.ts`

The registry is the single source of truth for all media filter dimensions. Every field is a `SearchableField` object:

```typescript
export interface SearchableField {
  key: string;               // filter key used in API requests
  label: string;             // human-readable name (for UI and agent prompts)
  type: SearchFieldType;     // 'string' | 'enum' | 'date-range' | 'boolean' | 'geo'
  enumValues?: string[];     // allowed values for 'enum' type fields
  description: string;       // used verbatim in the agent's tool schema
  buildWhere(value: unknown): Prisma.MediaItemWhereInput;
}
```

The `buildWhere` function delegates to a named leaf helper in `media-where.builder.ts`, so the Prisma where-clause logic is never duplicated.

### Current Registry (17 fields)

| Key | Type | Description |
|-----|------|-------------|
| `type` | enum | `photo` or `video` |
| `favorite` | boolean | Only favorited items |
| `capturedAt` | date-range | `{ from?, to? }` ISO 8601 |
| `albumId` | string | Album UUID |
| `tag` | string | Exact tag name (case-insensitive) |
| `country` | geo | Country name (partial) or ISO code (exact) |
| `region` | geo | Administrative region / state (partial) |
| `locality` | geo | City or locality (partial) |
| `place` | geo | Named place (partial) |
| `location` | geo | Free text across all geographic tiers |
| `cameraMake` | string | Camera manufacturer (partial) |
| `cameraModel` | string | Camera model name (partial) |
| `sourceDeviceId` | string | Exact source device identifier |
| `sourceDeviceName` | string | Source device name (partial) |
| `missingGeo` | boolean | Items without GPS coordinates |
| `noFaces` | boolean | Items with no detected or manually-added faces |
| `people` | person-set | `{ ids: UUID[], mode: 'any' \| 'all' }` — filter by people appearing in photos |

### How the Registry Powers Both Search Modes

`buildWhereFromFields(circleId, filters)` composes a `Prisma.MediaItemWhereInput` by iterating over the registry's `buildWhere` functions. The deterministic search endpoint calls this directly. The agent's `search-tool-schema.ts` also iterates `SEARCHABLE_FIELDS` to generate the JSON Schema for the `search_media` tool — the tool and the deterministic endpoint always accept and reject the same fields.

---

## 4. AI Provider Abstraction

**File:** `apps/api/src/ai/providers/ai-provider.interface.ts`

### AiProvider Interface

```typescript
export interface AiProvider {
  /** Unique key: 'openai' | 'anthropic' */
  readonly key: string;

  /** Stream a chat completion. Yields ChatStreamEvents. */
  chat(creds: AiProviderCredentials, req: ChatRequest): AsyncIterable<ChatStreamEvent>;

  /** Return model IDs available for this provider. */
  listModels(creds: AiProviderCredentials): Promise<string[]>;

  /** Ping with a minimal call. Used for credential verification. */
  testModel(creds: AiProviderCredentials, model: string): Promise<{ ok: boolean; error?: string }>;
}
```

### Supporting Types

```typescript
export interface AiProviderCredentials {
  apiKey: string;
  baseUrl?: string;   // overrides default endpoint; enables OpenAI-compatible providers
}

export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'done'; stopReason?: string };
```

### AI Provider Registry

**File:** `apps/api/src/ai/providers/ai-provider.registry.ts`

The `AiProviderRegistry` NestJS service holds a map of key → provider instance. Currently registered:

| Key | Provider Class | Notes |
|-----|---------------|-------|
| `anthropic` | `AnthropicProvider` | Uses `@anthropic-ai/sdk`. Curated model list: `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`. |
| `openai` | `OpenAiProvider` | Uses `openai` SDK. When `baseUrl` is set, queries the compatible endpoint's `/models` list dynamically. Curated fallback: `gpt-5`, `gpt-5.5`. |

Credentials are retrieved from `ai_provider_credentials` (decrypted at query time) and passed to the provider's `chat()` / `listModels()` / `testModel()` methods. The plaintext key never passes through any log or response.

---

## 5. Agent Tool-Calling Loop

**File:** `apps/api/src/search/agent/search-agent.service.ts`

The `SearchAgentService.streamTurn()` method is an async generator that executes one conversational turn. Because search is stateless, the full message history is passed in by the caller on every request — the service never reads from or writes to a database conversation table.

```
┌─────────────────────────────────────────────────────────────────────┐
│  streamTurn({ circleId, messages, userId, permissions })            │
│                                                                     │
│  1. Load AI settings → providerKey, model                          │
│  2. Decrypt credentials from DB                                     │
│  3. Get provider from AiProviderRegistry                            │
│  4. Build search_media tool def from SEARCHABLE_FIELDS registry     │
│  5. Assert circle viewer membership for circleId                    │
│  6. Use messages array as-is (client-supplied full history)         │
│                                                                     │
│  ┌──────────────── TOOL-CALL LOOP ─────────────────────────────┐   │
│  │                                                             │   │
│  │  provider.chat(creds, { model, system, messages, tools })   │   │
│  │                                                             │   │
│  │  for each ChatStreamEvent:                                  │   │
│  │    'text'      → yield { event: 'token', data: { text } }  │   │
│  │    'tool_call' (search_media):                              │   │
│  │      → yield { event: 'tool_call', data: { name, args } }  │   │
│  │      → searchService.runSearch(userId, circleId,           │   │
│  │                              permissions, toolInput)        │   │
│  │        NOTE: circleId is ALWAYS from the request body —    │   │
│  │        the model cannot override it via tool input          │   │
│  │      → yield { event: 'results', data: searchResult }      │   │
│  │      → append assistant + tool result to in-flight history  │   │
│  │    'done':                                                  │   │
│  │      stopReason === 'tool_use' → loop again (continue)      │   │
│  │      else → break (model finished)                          │   │
│  │                                                             │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

The loop continues until the model emits a `done` event with `stopReason !== 'tool_use'`, meaning the model has finished its final natural-language response after seeing all tool results.

### System Prompt

The agent is instructed to:

- Use the `search_media` tool to translate natural-language requests into filter calls
- Summarize results: total count, date range, notable locations
- When no results are found, say so plainly and suggest 1-3 adjacent searches
- Use the message history provided by the client for multi-turn refinement
- Operate strictly within the `circleId` supplied in the request — the constraint is enforced server-side

---

## 6. SSE Streaming Protocol

The `POST /api/search/agent` endpoint writes raw HTTP response using Fastify's `reply.raw` with `Content-Type: text/event-stream`. All events use the `event: <type>\ndata: <json>\n\n` SSE format.

### Request Body

```json
{
  "circleId": "uuid",
  "messages": [
    { "role": "user", "content": "Show me photos from Costa Rica last summer" },
    { "role": "assistant", "content": "I found 42 photos from Costa Rica in July 2024..." },
    { "role": "user", "content": "Only show the ones from San José" }
  ]
}
```

- `circleId` — required; must be a circle the caller has at least `viewer` membership in
- `messages` — required; the full conversation history; the last entry must have `role: 'user'`
- Message history is held in client memory; nothing is persisted server-side

### Event Types

| Event | Payload | Description |
|-------|---------|-------------|
| `token` | `{ text: string }` | A chunk of the model's text response |
| `tool_call` | `{ name: string, args: Record<string, unknown> }` | The model is calling `search_media` |
| `results` | `{ items: MediaItem[], meta: PaginationMeta }` | Search results returned by the tool |
| `done` | `{}` | Stream complete |
| `error` | `{ message: string }` | Error occurred during streaming |

### Nginx Buffering

The Nginx configuration must include `proxy_buffering off` (or the API sets `X-Accel-Buffering: no`) for SSE to stream in real time. The controller sets this header on every SSE response.

---

## 7. Security Model

### AI Provider Key Encryption at Rest

**File:** `apps/api/src/common/crypto/secret-cipher.ts`

Provider API keys are stored AES-256-GCM encrypted in `ai_provider_credentials.encrypted_key`. The encryption key is loaded from the `SECRETS_ENCRYPTION_KEY` environment variable (base64-encoded 32-byte value).

Payload layout (all base64-encoded in the DB column):

```
[iv: 12 bytes][authTag: 16 bytes][ciphertext: variable]
```

Generate the key:

```bash
openssl rand -base64 32
```

**The raw API key is never stored, never logged, and never returned by any endpoint.** The `GET /ai/settings` response returns only `last4` (the final four characters) plus `baseUrl` and `enabled`. The ciphertext column is excluded from all Prisma `select` calls in the service layer.

### Circle-Scoped Agent Authorization

The agent's `search_media` tool always uses the `circleId` from the request body — not from the model's tool call input. The tool schema comment explicitly tells the model not to pass `circleId`:

> "circleId is always fixed to the current request context — do NOT pass it."

Before any search executes, `SearchService.runSearch` calls `CircleMembershipService.assertCircleAccess(userId, circleId, permissions, 'viewer')`. An attacker who crafts a tool call including a different `circleId` value is silently ignored because the service never reads it from tool input.

### Permission Requirements

| Resource | Permission | Granted To |
|----------|------------|------------|
| AI settings (read) | `ai_settings:read` | Admin only |
| AI settings (write) | `ai_settings:write` | Admin only |
| Search (all) | `search:use` | All roles (Admin, Contributor, Viewer) |

### Encryption Key Rotation

To rotate `SECRETS_ENCRYPTION_KEY`:

1. Generate a new key with `openssl rand -base64 32`
2. For each row in `ai_provider_credentials`, decrypt the `encrypted_key` with the old key, re-encrypt with the new key, and update the row
3. Update the environment variable
4. Restart the API

No built-in rotation tooling exists today; it is a manual migration step.

---

## 8. How to Add a New Search Dimension

### The One-File Rule

Adding a new search dimension requires a single edit to `apps/api/src/search/searchable-fields.registry.ts`. Both the deterministic `POST /api/search` endpoint and the agent's `search_media` tool schema are derived from `SEARCHABLE_FIELDS` automatically on the next deploy. No other files change.

### Step-by-Step

1. Add a named leaf helper to `media-where.builder.ts` (optional but recommended for testability):

```typescript
export function wherePersonId(personId: string): Prisma.MediaItemWhereInput {
  return {
    mediaPersons: {
      some: { personId },
    },
  };
}
```

2. Import the helper in `searchable-fields.registry.ts` and add one `SearchableField` entry to `SEARCHABLE_FIELDS`:

```typescript
import { wherePersonId } from './media-where.builder';

// Inside SEARCHABLE_FIELDS array:
{
  key: 'personId',
  label: 'Person (face recognition)',
  type: 'string',
  description:
    'Filter to items where the specified person appears. ' +
    'Pass the person UUID as returned by GET /api/persons.',
  buildWhere: (v) => wherePersonId(String(v)),
},
```

3. Deploy. Both the deterministic endpoint and the agentic search now accept `personId` as a filter.

### Worked Example: People / Face Recognition

When face recognition data is available, the enrichment pipeline produces `MediaPerson` rows linking a `media_item_id` to a `person_id`. The search integration is:

**`apps/api/src/search/media-where.builder.ts`** — add one export:

```typescript
export function wherePersonId(personId: string): Prisma.MediaItemWhereInput {
  return { mediaPersons: { some: { personId } } };
}
```

**`apps/api/src/search/searchable-fields.registry.ts`** — add one entry:

```typescript
{
  key: 'personId',
  label: 'Person (face recognition)',
  type: 'string',
  description:
    'Filter to items where the identified person appears. ' +
    'Pass the person UUID. Future: accepts a display name resolved by the API.',
  buildWhere: (v) => wherePersonId(String(v)),
},
```

After this change:

- `POST /api/search` with `{ "filters": { "personId": "uuid-of-lucia" } }` returns all media where Lucia appears.
- A user who types "show me photos of Lucia" triggers the agent, which calls `search_media({ personId: "uuid-of-lucia" })` after looking up Lucia's UUID. The agent description field guides the model to understand the parameter semantics.

No changes to the agent service, tool schema builder, controller, or any other file are required.

---

## 9. How to Add a New AI Provider

### Native Provider (new SDK)

1. Create a class in `apps/api/src/ai/providers/` that implements `AiProvider`:

```typescript
export class MyProvider implements AiProvider {
  readonly key = 'myprovider';

  async *chat(creds, req): AsyncIterable<ChatStreamEvent> { /* ... */ }
  async listModels(creds): Promise<string[]> { /* ... */ }
  async testModel(creds, model): Promise<{ ok: boolean; error?: string }> { /* ... */ }
}
```

2. Register it in `AiProviderRegistry`:

```typescript
private readonly providers = new Map<string, AiProvider>([
  ['anthropic', new AnthropicProvider()],
  ['openai',    new OpenAiProvider()],
  ['myprovider', new MyProvider()],  // add here
]);
```

3. The new provider key becomes valid for `PUT /ai/credentials/myprovider` and `PUT /ai/features/search { provider: "myprovider", model: "..." }`.

### OpenAI-Compatible Provider (config only — no new code)

Many inference providers expose an OpenAI-compatible API (same `/chat/completions` and `/models` endpoints). The `OpenAiProvider` honors `creds.baseUrl` when set, so these providers work with zero new code.

**Example: Moonshot.ai**

```bash
# Admin stores a credential via the API:
PUT /api/ai/credentials/openai
{
  "apiKey": "sk-moonshot-...",
  "baseUrl": "https://api.moonshot.cn/v1"
}

# Admin selects the model:
PUT /api/ai/features/search
{
  "provider": "openai",
  "model": "moonshot-v1-8k"
}
```

When `baseUrl` is set, `OpenAiProvider.listModels()` calls `GET {baseUrl}/models` to return the provider's actual model list. `OpenAiProvider.chat()` directs all completions to `{baseUrl}/chat/completions` using the stored API key.

Other OpenAI-compatible providers that work the same way (config only, no new code):
- Together AI — `https://api.together.xyz/v1`
- Groq — `https://api.groq.com/openai/v1`
- Ollama (local) — `http://localhost:11434/v1`
- LM Studio (local) — `http://localhost:1234/v1`

---

## 10. Endpoint and Permission Reference

### AI Settings (`/api/ai`)

All endpoints in this group require `ROLES.ADMIN` plus the listed permission. They are not accessible to Contributor or Viewer roles.

| Method | Path | Permission | Body / Query | Description |
|--------|------|------------|--------------|-------------|
| `GET` | `/api/ai/settings` | `ai_settings:read` | — | Returns all configured providers (masked `last4`, no ciphertext), known unconfigured providers, and active search feature config |
| `PUT` | `/api/ai/credentials/:provider` | `ai_settings:write` | `{ apiKey, baseUrl?, enabled? }` | Upsert provider credentials. Key is encrypted at rest. Returns masked summary. |
| `DELETE` | `/api/ai/credentials/:provider` | `ai_settings:write` | — | Remove provider credentials. Returns `{ deleted: true, provider }`. |
| `POST` | `/api/ai/test` | `ai_settings:read` | `{ provider, model, apiKey?, baseUrl? }` | Test provider connectivity. Returns `{ ok: boolean, error? }`. |
| `GET` | `/api/ai/models` | `ai_settings:read` | `?provider=<key>` | List available models for a provider using stored credentials. Returns `{ provider, models: string[] }`. |
| `PUT` | `/api/ai/features/search` | `ai_settings:write` | `{ provider, model }` | Set the active AI provider and model for the search feature. Stored in system settings under `ai.features.search`. |

### Deterministic Search (`/api/search`)

| Method | Path | Permission | Body / Query | Description |
|--------|------|------------|--------------|-------------|
| `POST` | `/api/search` | `media:read` + `search:use` | `{ circleId, filters, page?, pageSize?, sort? }` | Execute a deterministic media search using explicit filter criteria. Unknown filter keys return 400. Returns the same paginated envelope as `GET /api/media`. |
| `GET` | `/api/search/fields` | `search:use` | — | Return the full `SEARCHABLE_FIELDS` registry (key, label, type, description, enumValues). Used by the frontend filter builder and displayed to the agent at tool construction time. |

### Agentic Search (`/api/search/agent`)

| Method | Path | Permission | Body | Description |
|--------|------|------------|------|-------------|
| `POST` | `/api/search/agent` | `search:use` | `{ circleId, messages[] }` | Send the full message history and stream the AI response via SSE. `messages` is an array of `{ role: 'user'|'assistant'; content: string }` objects; the last entry must be `role: 'user'`. Circle membership is verified server-side. Nothing is persisted. See [Section 6](#6-sse-streaming-protocol) for event types. |

### Permissions Summary

| Permission | Granted To | Purpose |
|------------|------------|---------|
| `ai_settings:read` | Admin | View AI provider config, test connectivity, list models |
| `ai_settings:write` | Admin | Configure provider credentials, set active search model |
| `search:use` | Admin, Contributor, Viewer | Use deterministic search and agentic search |

---

## 11. Database Schema

### `ai_provider_credentials`

Stores one row per provider (unique by `provider` key). This is the only table owned by the AI/search subsystem. No conversation or message data is stored.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `provider` | string UNIQUE | e.g. `anthropic`, `openai` |
| `encrypted_key` | text | AES-256-GCM ciphertext (IV + authTag + payload, base64) |
| `base_url` | string? | Optional endpoint override for compatible providers |
| `last4` | string | Last four characters of the plaintext key, for display only |
| `enabled` | boolean | Whether this provider is active |
| `updated_by_user_id` | UUID FK → users | Admin who last updated the credential |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |
