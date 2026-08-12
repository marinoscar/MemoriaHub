// =============================================================================
// The `info.description` Markdown shown at the top of /api/docs (epic #414)
// =============================================================================
//
// This is the getting-started guide. It is baked into the OpenAPI document
// rather than written on a separate page so that it travels with the spec:
// anyone who downloads `/api/openapi.json`, imports it into Postman, or
// generates an SDK from it gets the same orientation the docs page shows.
//
// Keep it task-shaped (how do I get a token, what does a response look like,
// how do I page) rather than a feature tour — the tag sections below it are the
// feature tour.
// =============================================================================

/**
 * Builds the Markdown intro.
 *
 * @param version resolved application version, echoed so a reader can tell
 *   which build they are pointed at without cross-checking `info.version`.
 */
export function buildApiDescription(version: string): string {
  return `
The HTTP API behind **MemoriaHub** — a self-hosted family photo and video library with
AI enrichment, face recognition, semantic search, curated memories, and a distributed
worker fleet.

This page is generated from the running server (build \`${version}\`), so it always matches the
deployment you are pointed at. The machine-readable document is at
[\`/api/openapi.json\`](/api/openapi.json).

---

## Getting a token

Every route is authenticated unless it is explicitly marked **Public**. There are four ways
to obtain a bearer token, in rough order of how often you will want each.

### 1. Your browser session (fastest, for exploring these docs)

If you are already signed in to MemoriaHub in this browser, press **Authorize with my session**
at the top of this page. It calls \`POST /api/auth/refresh\` with your existing refresh cookie
and loads the returned access token into the client below. Nothing to copy or paste, and the
authorization survives a reload.

Access tokens are short-lived (15 minutes by default). If calls start returning \`401\`, press the
button again.

### 2. Personal access token — scripts and automation

Mint a \`pat_…\` token via \`POST /api/pat\` (or the web UI) and send it as
\`Authorization: Bearer pat_…\`. A PAT carries the full permission set of the user that created it
and is accepted on every authenticated route, so treat it like a password. Revoke with
\`DELETE /api/pat/{id}\`.

### 3. Node credential — worker fleet only

A \`nod_…\` credential authenticates like a PAT but is accepted **only** on \`/api/nodes/*\`. That
restriction is the point: a worker running unattended on someone else's hardware cannot reach
media, settings, or admin routes even if its credential leaks, and even if its owner is an Admin.
Mint with \`POST /api/node-credentials\`.

### 4. Device authorization grant — CLI and TV-style clients

For a machine that cannot open a browser, use the RFC 8628 flow: \`POST /api/auth/device/code\`
to get a user code, show it to the user, and poll \`POST /api/auth/device/token\` until they
approve it at \`/activate\`. The CLI's \`memoriahub login\` does exactly this.

---

## Response shape

Most endpoints wrap their payload in a \`data\` envelope:

\`\`\`json
{ "data": { "id": "…", "name": "…" } }
\`\`\`

Paginated endpoints add a sibling \`meta\`. Which pagination style you get depends on the endpoint,
and one endpoint — \`GET /api/media\` — supports **both**, selected by whether you send \`page\`:

- **Offset** (send \`page\`) — \`meta: { page, pageSize, totalItems, totalPages }\`. Backed by a
  \`COUNT(*)\`, so it is the more expensive of the two. Use it when you need a total.
- **Keyset** (omit \`page\`, send \`cursor\`) — \`meta: { pageSize, nextCursor, hasMore }\`. No count
  query. Pass the previous response's \`nextCursor\` back as \`cursor\`. Use it for infinite scroll
  and for anything walking a large library.

A handful of older endpoints return their payload unwrapped. The response schema shown for each
operation is authoritative.

---

## Errors

Every error passes through one filter and comes back in one shape:

\`\`\`json
{
  "statusCode": 409,
  "code": "CONFLICT",
  "message": "A backup is already running",
  "details": { "activeRunId": "…" },
  "timestamp": "2026-08-12T04:37:58.000Z",
  "path": "/api/admin/db-backup/runs"
}
\`\`\`

Endpoint-specific structured data always lives under \`details\` — the filter rebuilds the body from
a fixed key allowlist, so a custom top-level field would be dropped before it reached you.

\`503\` with \`"error": "maintenance"\` means an administrator has put the deployment into maintenance
mode; a \`Retry-After\` header accompanies it.

---

## Permissions

Authorization is two independent layers, and an authenticated call must satisfy **both**.

**System permissions** are granted through system roles — Admin, Contributor, Viewer — and are
named \`resource:action\` (\`media:read\`, \`jobs:write\`, \`db_backup:restore\`). Every operation in
this document states the permissions it requires; those lines are generated from the same
\`@Auth()\` decorator the guards read, so they cannot drift from what the server enforces.

**Per-circle roles** govern which circle you may act in, independently of your system role:

| Role | Can |
| --- | --- |
| \`viewer\` | Browse and download media in the circle |
| \`collaborator\` | Everything a viewer can, plus upload, tag, and organize |
| \`circle_admin\` | Everything a collaborator can, plus manage members and delete the circle |

So \`media:write\` alone is not enough to modify a photo — you also need at least \`collaborator\` in
that photo's circle. Holding \`circles:manage_any\`, \`media:read_any\`, or \`media:write_any\` (Admin)
bypasses the per-circle check entirely.

---

## Conventions

- All timestamps are ISO 8601 in UTC.
- All ids are UUIDs unless documented otherwise.
- Byte counts are returned as **strings**, not numbers — they are 64-bit values and would lose
  precision or fail to serialize as JSON numbers.
- \`204 No Content\` responses have no body.
- The API is served same-origin under \`/api\`; this document's server is \`/\`.

## Further reading

Architecture and feature specifications live in the repository under
[\`docs/specs/\`](https://github.com/marinoscar/MemoriaHub/tree/main/docs/specs) — including the
enrichment queue, distributed worker nodes, search, workflows, memories, and public sharing.
`.trim();
}
