# Agentic Search Specification

| Field | Value |
|-------|-------|
| **Version** | 1.0 |
| **Last Updated** | June 2026 |
| **Status** | Implemented |
| **Branch** | `feat/ai-search` |

---

## Table of Contents

1. [Motivation and Vision Alignment](#1-motivation-and-vision-alignment)
2. [System Architecture](#2-system-architecture)
3. [Searchable Field Registry](#3-searchable-field-registry)
4. [AI Provider Abstraction](#4-ai-provider-abstraction)
5. [Agent Tool-Calling Loop](#5-agent-tool-calling-loop)
6. [SSE Streaming Protocol](#6-sse-streaming-protocol)
7. [Conversation Lifecycle](#7-conversation-lifecycle)
8. [Security Model](#8-security-model)
9. [How to Add a New Search Dimension](#9-how-to-add-a-new-search-dimension)
10. [How to Add a New AI Provider](#10-how-to-add-a-new-ai-provider)
11. [Endpoint and Permission Reference](#11-endpoint-and-permission-reference)
12. [Database Schema](#12-database-schema)

---

## 1. Motivation and Vision Alignment

### Problem

MemoriaHub libraries grow large quickly. A user who has synced several years of family photos may have tens of thousands of items across dozens of locations, camera devices, and date ranges. The existing deterministic `GET /api/media` filter is precise but requires the user to know exactly which fields to combine and which values to use. A query like "show me photos from our trip to Costa Rica last summer" is natural in speech but requires the user to know the `country` field is `"Costa Rica"`, the `capturedAt` date range bounds, etc.

### Vision Alignment

The [VISION.MD](../../VISION.MD) calls out two future search enrichment capabilities:

> **Search by Person** — face recognition so users can find photos of specific family members  
> **Search by Objects and Scenes** — object detection so users can search based on what appears in a photo

Those capabilities require an enrichment pipeline (Phase 09). This feature delivers the conversational search layer that will expose them once the enrichment data exists — without changing the search architecture. The registry-based design means adding face recognition later is a one-line change (see [Section 9](#9-how-to-add-a-new-search-dimension)).

### Intended Outcome

Two complementary search modes are now available:

| Mode | Endpoint | Use Case |
|------|----------|----------|
| **Deterministic** | `POST /api/search` | Precise, machine-generated queries (frontend filter builder, CLI) |
| **Agentic / Conversational** | `POST /api/search/conversations/:id/messages` | Natural-language queries with multi-turn refinement, streamed via SSE |

Both modes are powered by the same `SearchableFieldRegistry` and `buildWhereFromFields` helper, which guarantees they never drift apart.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        AI / SEARCH SUBSYSTEM                                │
│                                                                             │
│  ┌─────────────────────┐    ┌──────────────────────────────────────────┐   │
│  │ SearchController    │    │ ConversationsController                  │   │
│  │ POST /search        │    │ POST   /search/conversations             │   │
│  │ GET  /search/fields │    │ GET    /search/conversations             │   │
│  └────────┬────────────┘    │ GET    /search/conversations/:id        │   │
│           │                 │ PATCH  /search/conversations/:id        │   │
│           │                 │ DELETE /search/conversations/:id        │   │
│           │                 │ POST   /search/conversations/:id/msgs   │   │
│           │                 └──────────────────┬───────────────────────┘   │
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
│  │  • 16 fields: type, classification, favorite, capturedAt, albumId,  │   │
│  │    tag, country, region, locality, place, location, cameraMake,     │   │
│  │    cameraModel, sourceDeviceId, sourceDeviceName, missingGeo        │   │
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
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  ConversationLifecycleTask  (daily cron @ 04:00)                   │   │
│  │  Reads ai.conversations.{archiveAfterDays, deleteAfterArchiveDays}  │   │
│  │  from system settings. Favorites are exempt.                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
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
    ├── agent/
    │   ├── search-agent.service.ts       # Multi-turn tool-call loop + SSE emitter
    │   └── search-tool-schema.ts         # Derives search_media tool from registry
    ├── conversations/
    │   ├── conversations.controller.ts
    │   └── conversations.service.ts
    └── tasks/
        └── conversation-lifecycle.task.ts
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

### Current Registry (16 fields)

| Key | Type | Description |
|-----|------|-------------|
| `type` | enum | `photo` or `video` |
| `classification` | enum | `memory`, `low_value`, or `unreviewed` |
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

### How the Registry Powers Both Search Modes

`buildWhereFromFields(circleId, filters)` composes a `Prisma.MediaItemWhereInput` by iterating over the registry's `buildWhere` functions. The deterministic search endpoint calls this directly. The agent's `search_tool_schema.ts` also iterates `SEARCHABLE_FIELDS` to generate the JSON Schema for the `search_media` tool — the tool and the deterministic endpoint always accept and reject the same fields.

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

The `SearchAgentService.streamTurn()` method is an async generator that executes one conversational turn:

```
┌─────────────────────────────────────────────────────────────────────┐
│  streamTurn({ conversation, userContent, userId, permissions })     │
│                                                                     │
│  1. Load AI settings → providerKey, model                          │
│  2. Decrypt credentials from DB                                     │
│  3. Get provider from AiProviderRegistry                            │
│  4. Build search_media tool def from SEARCHABLE_FIELDS registry     │
│  5. Reconstruct message history from conversation.messages          │
│  6. Append new user message                                         │
│                                                                     │
│  ┌──────────────── TOOL-CALL LOOP ─────────────────────────────┐   │
│  │                                                             │   │
│  │  provider.chat(creds, { model, system, messages, tools })   │   │
│  │                                                             │   │
│  │  for each ChatStreamEvent:                                  │   │
│  │    'text'      → yield { event: 'token', data: { text } }  │   │
│  │    'tool_call' (search_media):                              │   │
│  │      → yield { event: 'tool_call', data: { name, args } }  │   │
│  │      → searchService.runSearch(userId, conversation.circleId│   │
│  │                              permissions, toolInput)        │   │
│  │        NOTE: circleId is ALWAYS from the conversation row   │   │
│  │        — never from the model's tool input                  │   │
│  │      → yield { event: 'results', data: searchResult }      │   │
│  │      → append assistant + tool result messages to history   │   │
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
- Use conversation history across turns for refinement
- Operate strictly within the conversation's circle — the `circleId` constraint is enforced server-side

---

## 6. SSE Streaming Protocol

The `POST /api/search/conversations/:id/messages` endpoint writes raw HTTP response using Fastify's `reply.raw` with `Content-Type: text/event-stream`. All events use the `event: <type>\ndata: <json>\n\n` SSE format.

### Event Types

| Event | Payload | Description |
|-------|---------|-------------|
| `token` | `{ text: string }` | A chunk of the model's text response |
| `tool_call` | `{ name: string, args: Record<string, unknown> }` | The model is calling `search_media` |
| `results` | `{ items: MediaItem[], meta: PaginationMeta }` | Search results returned by the tool |
| `done` | `{ messageId: string }` | Stream complete; `messageId` is the persisted DB ID |
| `error` | `{ message: string }` | Error occurred during streaming |

### Nginx Buffering

The Nginx configuration must include `proxy_buffering off` (or the API sets `X-Accel-Buffering: no`) for SSE to stream in real time. The controller sets this header on every SSE response.

### Post-Stream Persistence

After the stream closes, the controller:

1. Persists the assistant message (accumulated `finalText`, `toolCalls`, `toolResults`) to `search_messages`
2. Touches `search_conversations.updated_at`
3. If the conversation has no title yet, calls `ConversationsService.autoTitle()` — which uses the first user message and assistant response to generate a short title via the AI provider

---

## 7. Conversation Lifecycle

### States

A `SearchConversation` row moves through these states:

```
active (archivedAt IS NULL, deletedAt IS NULL)
    │
    │  inactive for archiveAfterDays (non-favorite)
    ▼
archived (archivedAt IS NOT NULL, deletedAt IS NULL)
    │
    │  archived for deleteAfterArchiveDays (non-favorite)
    ▼
soft-deleted (deletedAt IS NOT NULL)
```

Favorites are exempt from both archive and soft-delete.

### System Settings

Lifecycle windows are stored in system settings under the `ai.conversations` key:

```json
{
  "ai": {
    "features": {
      "search": {
        "provider": "anthropic",
        "model": "claude-opus-4-8"
      }
    },
    "conversations": {
      "archiveAfterDays": 30,
      "deleteAfterArchiveDays": 30
    }
  }
}
```

Admins change these via `PATCH /api/system-settings`.

### Daily Cron

**File:** `apps/api/src/search/tasks/conversation-lifecycle.task.ts`

Runs at 04:00 daily (`@Cron(CronExpression.EVERY_DAY_AT_4AM)`):

1. `updateMany` where `archivedAt IS NULL AND favorite = false AND updatedAt < archiveCutoff` → set `archivedAt = now`
2. `updateMany` where `archivedAt IS NOT NULL AND archivedAt < deleteCutoff AND favorite = false` → set `deletedAt = now`

### User Controls

| Action | Endpoint | Effect |
|--------|----------|--------|
| Rename | `PATCH /api/search/conversations/:id` with `{ title }` | Sets title; also prevents auto-title on next turn |
| Favorite | `PATCH /api/search/conversations/:id` with `{ favorite: true }` | Exempts conversation from archive and delete |
| Unfavorite | `PATCH /api/search/conversations/:id` with `{ favorite: false }` | Re-enrolls in lifecycle |
| Delete | `DELETE /api/search/conversations/:id` | Soft-deletes immediately (sets `deletedAt`) |

---

## 8. Security Model

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

The agent's `search_media` tool receives `circleId` from the `SearchConversation` database row — not from the model's tool call input. The tool schema comment explicitly tells the model not to pass `circleId`:

> "circleId is always fixed to the current conversation context — do NOT pass it."

Before any search executes, `SearchService.runSearch` calls `CircleMembershipService.assertCircleAccess(userId, conversation.circleId, permissions, 'viewer')`. An attacker who crafts a tool call including a different `circleId` value is silently ignored because the service never reads it from tool input.

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

## 9. How to Add a New Search Dimension

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

3. Deploy. Both the deterministic endpoint and the conversational agent now accept `personId` as a filter.

### Worked Example: People / Face Recognition

When face recognition is added (Phase 09 or later), the enrichment pipeline produces `MediaPerson` rows linking a `media_item_id` to a `person_id`. The search integration is:

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

## 10. How to Add a New AI Provider

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

## 11. Endpoint and Permission Reference

### AI Settings (`/api/ai`)

All endpoints in this group require `ROLES.ADMIN` plus the listed permission. They are not accessible to Contributor or Viewer roles.

| Method | Path | Permission | Body / Query | Description |
|--------|------|------------|--------------|-------------|
| `GET` | `/api/ai/settings` | `ai_settings:read` | — | Returns all configured providers (masked `last4`, no ciphertext), known unconfigured providers, active search feature config, and conversation lifecycle settings |
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

### Search Conversations (`/api/search/conversations`)

All endpoints require `search:use`. The `circleId` used for media authorization always comes from the persisted conversation row, never from request input.

| Method | Path | Permission | Body / Query | Description |
|--------|------|------------|--------------|-------------|
| `POST` | `/api/search/conversations` | `search:use` | `{ circleId }` | Create a new conversation. Validates that AI search is configured and the user is a member of the circle. Returns the new conversation object. |
| `GET` | `/api/search/conversations` | `search:use` | `?circleId=&favorite=&archived=&page=&pageSize=` | List the caller's conversations for a circle. Supports filtering by `favorite` and `archived` state. Returns paginated list. |
| `GET` | `/api/search/conversations/:id` | `search:use` | — | Get a single conversation with its full message history. Returns 404 if not found or not owned by the caller. |
| `PATCH` | `/api/search/conversations/:id` | `search:use` | `{ title?, favorite? }` | Update conversation title or favorite flag. Either field is optional. |
| `DELETE` | `/api/search/conversations/:id` | `search:use` | — | Soft-delete the conversation (sets `deletedAt`). Returns 204 No Content. |
| `POST` | `/api/search/conversations/:id/messages` | `search:use` | `{ content }` | Send a user message and receive the AI response as an SSE stream. Persists both the user and assistant messages after the stream closes. See [Section 6](#6-sse-streaming-protocol) for event types. |

### Permissions Summary

| Permission | Granted To | Purpose |
|------------|------------|---------|
| `ai_settings:read` | Admin | View AI provider config, test connectivity, list models |
| `ai_settings:write` | Admin | Configure provider credentials, set active search model |
| `search:use` | Admin, Contributor, Viewer | Use deterministic search, create and use conversations |

---

## 12. Database Schema

### `ai_provider_credentials`

Stores one row per provider (unique by `provider` key).

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

### `search_conversations`

One row per user conversation within a circle.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `circle_id` | UUID FK → circles | The circle this conversation searches within; used for authz |
| `user_id` | UUID FK → users | Owner of the conversation |
| `title` | string? | Set by user or auto-generated; null until first turn completes |
| `provider` | string | Provider key at conversation creation time |
| `model` | string | Model ID at conversation creation time |
| `favorite` | boolean | When true, exempt from archive and delete |
| `archived_at` | timestamptz? | Set by lifecycle cron; null = active |
| `deleted_at` | timestamptz? | Soft-delete timestamp |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | Touched after each turn |

Indexes: `circle_id`, `user_id`, `archived_at`, `favorite`, `deleted_at`.

### `search_messages`

One row per message turn within a conversation.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `conversation_id` | UUID FK → search_conversations CASCADE | |
| `role` | string | `user` or `assistant` |
| `content` | text | Full message text |
| `tool_calls` | JSON? | Array of `{ id, name, input }` for assistant messages that called tools |
| `tool_results` | JSON? | Array of `{ toolCallId, result }` for the corresponding search results |
| `created_at` | timestamptz | |

Index: `conversation_id`.
