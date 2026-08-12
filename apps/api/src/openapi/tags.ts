// =============================================================================
// OpenAPI tag taxonomy (epic #414, phase 2)
// =============================================================================
//
// The single declaration of every `@ApiTags(...)` name used in this API, its
// human description, and which sidebar section it belongs to.
//
// Two rules this file exists to enforce:
//
//   1. ONE admin-tag naming convention. The codebase previously carried three
//      separators at once (`Admin - X`, `Admin — X`, `Admin: X`), which the
//      renderer sorted as three unrelated families. `Admin: X` is now the only
//      accepted form, asserted by `openapi.spec.ts`.
//
//   2. NO undeclared and NO orphaned tags. A tag used by a controller but not
//      listed here would render with no description and land outside every
//      group; a tag listed here but used by nobody would render an empty
//      section. Both are failed assertions in `openapi.spec.ts` rather than
//      something a reviewer has to notice.
//
// Ordering is deliberate: `TAG_GROUPS` is emitted verbatim as `x-tagGroups`,
// and the flattened tag order becomes the document's `tags` array, which is
// what a renderer falls back to when it has no group support.
// =============================================================================

export interface OpenApiTag {
  /** Must match the controller's `@ApiTags(...)` argument byte-for-byte. */
  name: string;
  /** One or two sentences. Rendered under the section heading in the sidebar. */
  description: string;
}

export interface OpenApiTagGroup {
  name: string;
  tags: OpenApiTag[];
}

/**
 * Sidebar sections, in render order.
 *
 * A group is a product area, not a module boundary — `Media` and `Storage` live
 * together because a caller uploading a photo touches both, even though they are
 * separate Nest modules.
 */
export const TAG_GROUPS: OpenApiTagGroup[] = [
  {
    name: 'Authentication & Access',
    tags: [
      {
        name: 'Authentication',
        description:
          'Google OAuth sign-in, access-token refresh, logout, and the current-user lookup. ' +
          'Start here: every other section assumes a bearer token obtained through one of these routes.',
      },
      {
        name: 'Device Authorization',
        description:
          'RFC 8628 device authorization grant — how the CLI and the Android app obtain a token on a ' +
          'machine that cannot open a browser, plus management of the resulting device sessions.',
      },
      {
        name: 'Personal Access Tokens',
        description:
          'Long-lived `pat_` bearer credentials for scripts and automation. A PAT carries the full ' +
          'permission set of the user that minted it and is accepted on every authenticated route.',
      },
      {
        name: 'Allowlist',
        description:
          'Pre-authorized email addresses. Access is allowlist-gated: an email absent from this list ' +
          'cannot complete OAuth sign-in at all. Admin only.',
      },
      {
        name: 'Test Authentication',
        description:
          'Token minting for automated tests. Registered only when `NODE_ENV !== "production"`, so ' +
          'these routes are absent from a production document entirely.',
      },
    ],
  },
  {
    name: 'Account & Circles',
    tags: [
      {
        name: 'Users',
        description:
          'User administration (Admin) plus the caller\'s own profile and avatar. The `/users/me/*` ' +
          'routes are self-scoped and need authentication only — no permission.',
      },
      {
        name: 'User Settings',
        description:
          'The caller\'s own JSONB settings document: theme, notification preferences, per-table ' +
          'layouts, and Memories preferences. PATCH merges; PUT replaces.',
      },
      {
        name: 'Circles',
        description:
          'Family circles — the unit of media ownership and sharing. Every media route is scoped to a ' +
          'circle the caller is a member of, at one of three per-circle roles.',
      },
      {
        name: 'Features',
        description:
          'Client-visible feature flags for the calling user. Authentication only, no permission, so ' +
          'non-admin members can resolve gated UI affordances without a 403.',
      },
    ],
  },
  {
    name: 'Media Library',
    tags: [
      {
        name: 'Media',
        description:
          'The core library: listing and filtering media, albums, bulk mutations, archive and trash, ' +
          'the map and explore surfaces, geo lookups, and per-item edits.',
      },
      {
        name: 'Storage',
        description:
          'Raw object lifecycle beneath the media library — resumable and simple uploads, signed ' +
          'downloads, metadata, and deletion.',
      },
      {
        name: 'Metadata',
        description: 'On-demand re-extraction of EXIF, dimensions, geocode, and video-probe data for one item.',
      },
      {
        name: 'Trash Empty Runs',
        description:
          'Progress for the asynchronous "empty trash" run started from a circle, which hard-deletes ' +
          'every trashed item in the background rather than in the request.',
      },
    ],
  },
  {
    name: 'AI & Enrichment',
    tags: [
      {
        name: 'Tagging',
        description: 'Per-item AI auto-tagging status and reruns.',
      },
      {
        name: 'Tag Labels',
        description:
          'The global tag vocabulary the vision model is allowed to draw from, including CSV ' +
          'import/export. Admin only.',
      },
      {
        name: 'Picture Enhancement',
        description:
          'AI photo enhancement: start a run, poll it, then keep-both / replace / discard. Nothing is ' +
          'ever applied without an explicit human decision.',
      },
      {
        name: 'Bursts',
        description:
          'Burst-photo review queue — groups of near-identical rapid-fire shots, with a suggested best ' +
          'copy. Non-destructive until resolved.',
      },
      {
        name: 'Duplicates',
        description:
          'Near-duplicate review queue built on CLIP visual similarity and perceptual hashing. Catches ' +
          're-shared and recompressed copies that exact-hash dedup cannot.',
      },
      {
        name: 'Review Insights',
        description: 'Per-circle aggregate of burst and duplicate review activity.',
      },
      {
        name: 'Review Runs',
        description:
          'The shared asynchronous engine behind every bulk review action (bursts, duplicates, and ' +
          'location suggestions): counters, per-item outcomes, and cancellation.',
      },
      {
        name: 'Location Inference',
        description:
          'GPS coordinates inferred for photos that have none, by interpolating from chronologically ' +
          'nearby same-device photos that do. Reviewed before it sticks, unless high-confidence.',
      },
      {
        name: 'Location Suggestion Runs (deprecated)',
        description:
          'Deprecated aliases for the Review Runs routes, kept so existing clients keep working. Use ' +
          '`/api/review-runs/*` instead.',
      },
      {
        name: 'Location Groups',
        description:
          'Admin-curated canonical place names that merge many raw geocoder spellings ' +
          '("Heredia", "Provincia de Heredia") into one browsable entry per tier.',
      },
    ],
  },
  {
    name: 'People & Faces',
    tags: [
      {
        name: 'People',
        description:
          'Person records within a circle: clustering unknown faces, assigning and merging, hiding, ' +
          'and permanently purging biometric rows.',
      },
      {
        name: 'Face Detection',
        description: 'Detected faces on a single media item, their status, and per-item reruns.',
      },
    ],
  },
  {
    name: 'Search',
    tags: [
      {
        name: 'Search',
        description:
          'Deterministic filter search, optional semantic (vector) ranking, and the streaming agentic ' +
          'search endpoint that drives the conversational UI.',
      },
    ],
  },
  {
    name: 'Memories',
    tags: [
      {
        name: 'Memories',
        description:
          'Auto-curated collections — On This Day, trips, per-person highlights, themes, seasonal, and ' +
          'year in review — plus per-user seen/hidden/favorite state.',
      },
    ],
  },
  {
    name: 'Workflows',
    tags: [
      {
        name: 'Workflows',
        description:
          'Rule-based media automation on a Subject · Trigger · If · Then model: define, preview, and ' +
          'run automations over a circle\'s library.',
      },
      {
        name: 'Workflow Runs',
        description: 'Execution history for a workflow: counters, per-item outcomes, approval, and cancellation.',
      },
    ],
  },
  {
    name: 'Sharing & Public',
    tags: [
      {
        name: 'Sharing',
        description: 'Create, list, expire, and revoke public share links for a media item or an album.',
      },
      {
        name: 'Public Sharing',
        description:
          'Unauthenticated share consumption. Media bytes are proxied by the API — a storage URL is ' +
          'never exposed — and revoked, expired, or trashed targets return an indistinguishable 404.',
      },
      {
        name: 'Public Memories',
        description:
          'Unauthenticated endpoints backing the Memories email digest: cover-image bytes and one-click ' +
          'unsubscribe, each gated by an HMAC-signed capability token rather than a session.',
      },
    ],
  },
  {
    name: 'Notifications',
    tags: [
      {
        name: 'Notifications',
        description:
          'The in-app notification center: paginated inbox, unread badge count, and read / dismiss / ' +
          'delete. Every route is scoped to the calling user.',
      },
    ],
  },
  {
    name: 'Worker Nodes',
    tags: [
      {
        name: 'Nodes',
        description:
          'The worker-node data plane: register, heartbeat, claim jobs, renew leases, and submit ' +
          'results. Media bytes move directly between the node and object storage over presigned URLs.',
      },
      {
        name: 'Nodes: Backup',
        description:
          'Local media backup — the incremental change feed, acknowledgement checkpoints, and run ' +
          'lifecycle a node uses to pull-mirror a circle\'s original bytes onto its own disk.',
      },
      {
        name: 'Node Credentials',
        description:
          'Durable `nod_` bearer credentials. Least-privilege by construction: accepted **only** on ' +
          '`/api/nodes/*`, so a leaked worker credential can never reach media, settings, or admin routes.',
      },
    ],
  },
  {
    name: 'Configuration',
    tags: [
      {
        name: 'System Settings',
        description: 'The global settings document — every feature flag and tuning parameter. Admin only.',
      },
      {
        name: 'AI Settings',
        description:
          'AI provider credentials (encrypted at rest), connectivity tests, model listing, and which ' +
          'provider/model serves each AI feature.',
      },
      {
        name: 'Face Settings',
        description: 'Face-recognition provider configuration, connectivity tests, and biometric erasure.',
      },
      {
        name: 'Geo Settings',
        description: 'Reverse-geocoding provider selection and credentials.',
      },
      {
        name: 'Email Settings',
        description: 'Transactional email provider (SES or SMTP), masked credentials, and test sends.',
      },
      {
        name: 'Storage Settings',
        description:
          'Object-storage providers, connectivity tests, active-provider selection, and copy-only ' +
          'migration between providers.',
      },
    ],
  },
  {
    name: 'Admin & Operations',
    tags: [
      {
        name: 'Health',
        description:
          'Liveness and readiness probes. Liveness stays 200 during maintenance mode; readiness ' +
          'reports 503 so a load balancer drains the instance.',
      },
      {
        name: 'Maintenance',
        description:
          'App-wide maintenance mode. The persisted flag survives the restart it was enabled for; a ' +
          '`MAINTENANCE_MODE` environment override is the break-glass in both directions.',
      },
      {
        name: 'Admin: Job Queue',
        description:
          'The shared enrichment job queue: stats, listing, retry, stuck-job recovery, and the ' +
          'on-demand insights/ETA aggregate.',
      },
      {
        name: 'Admin: Doctor',
        description:
          'On-demand configuration health sweep across every subsystem, running live provider ' +
          'connectivity checks. Nothing is persisted.',
      },
      {
        name: 'Admin: Storage Insights',
        description: 'Precomputed global storage metrics and the manual refresh trigger.',
      },
      {
        name: 'Admin: Media Recovery',
        description:
          'Recovery for storage objects orphaned mid-pipeline or permanently failed, plus missing ' +
          'thumbnail repair.',
      },
      {
        name: 'Admin: Database Backup',
        description:
          'PostgreSQL backup and restore: schedule, run history, signed downloads, and the scratch-' +
          'database restore with its two rollback modes. Backs up the database, not media files.',
      },
      {
        name: 'Admin: Worker Nodes',
        description: 'Fleet-wide node health, per-node job counts, and credential revocation across all owners.',
      },
      {
        name: 'Admin: Workflows',
        description: 'Cross-circle workflow oversight: stats, every workflow and run, force-disable, force-cancel.',
      },
      {
        name: 'Admin: Face Recognition',
        description: 'App-wide face-detection and auto-archive backfills across every circle.',
      },
      {
        name: 'Admin: Tagging',
        description: 'App-wide AI auto-tagging backfill across every circle.',
      },
      {
        name: 'Admin: Metadata',
        description: 'App-wide metadata re-extraction backfill across every circle.',
      },
      {
        name: 'Admin: Bursts',
        description: 'App-wide burst-detection backfill across every circle.',
      },
      {
        name: 'Admin: Duplicates',
        description: 'App-wide duplicate-detection backfill, CLIP model status, and confidence backfill.',
      },
      {
        name: 'Admin: Location Inference',
        description: 'App-wide location-inference sweep across every eligible circle.',
      },
      {
        name: 'Admin: Location Groups',
        description: 'Rebuild of the derived canonical location columns across the whole library.',
      },
      {
        name: 'Admin: Geocode',
        description: 'App-wide reverse-geocode backfill for every media item carrying GPS coordinates.',
      },
      {
        name: 'Admin: Social Media Detection',
        description: 'App-wide social-media video detection backfill and OCR model status.',
      },
      {
        name: 'Admin: Memories',
        description: 'Sharded library-wide Memories backfill, per circle or across every circle.',
      },
      {
        name: 'Admin: AI Picture Enhancer',
        description: 'Readiness status for the AI Picture Enhancer: feature flag, provider, model, and credential.',
      },
    ],
  },
];

/** Every declared tag, flattened in group order. */
export const OPENAPI_TAGS: OpenApiTag[] = TAG_GROUPS.flatMap((group) => group.tags);

/**
 * The `x-tagGroups` value emitted into the document.
 *
 * A vendor extension rather than a standard field: OpenAPI has no concept of
 * tag sections, so every renderer that supports them (Scalar, Redoc) reads this
 * key. Renderers that don't simply fall back to the flat `tags` array, which is
 * why that array is emitted in the same order.
 */
export const OPENAPI_TAG_GROUPS = TAG_GROUPS.map((group) => ({
  name: group.name,
  tags: group.tags.map((tag) => tag.name),
}));
