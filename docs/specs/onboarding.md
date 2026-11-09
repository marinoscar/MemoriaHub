# First-run onboarding

MemoriaHub's binding of the platform onboarding slice (RETRO-H3, issue #599, epic #584): `@marinoscar/platform-api/onboarding` on the API, `@marinoscar/platform-web/onboarding` on the web. The platform owns the engine, the routes, the stored state and the pages; MemoriaHub registers its media steps, the facts they read and the activation milestone. Platform documentation: the slice READMEs in EnterpriseAppBase (`packages/platform-api/src/onboarding/README.md`, `packages/platform-web/src/onboarding/README.md`).

## 1. What a user and an administrator see

- **Welcome dialog** (once). Opens on the first shell load while `onboarding.welcomeSeenAt` is unset. A user sees what the library is for (upload, circles, people, memories) and goes to **Getting started**; an administrator sees the same, plus a note that storage, email, faces, tagging and memories start switched off, and goes to the **Setup guide**. "Later", Escape and the backdrop all store it as seen.
- **Banner** above the page: "N of M required steps left", administrator first. Hidden while loading, once the required steps are done, once dismissed, on the page it links to, and for an established account (section 4).
- **Getting started** (`/settings/getting-started`, a card in Settings → Account, no permission): the user steps, with Skip for the skippable ones and "Show the welcome again".
- **Setup guide** (`/admin/settings/setup`, a card in Admin → General, `system_settings:read`): the administrator steps in Required / Recommended / Optional groups, Re-check (re-runs the Doctor probes) and the Activation section.
- **User menu → Getting started**: brings the welcome and both checklists back.

Every status is derived on each read of `GET /api/onboarding` from real state; nothing is stored but the user's intent (`onboarding.*` in `user_settings`, written through `PATCH /api/user-settings`). No table, no migration.

## 2. Steps (ids are PERMANENT)

A step id is stored in users' `onboarding.skipped` and the activation milestone names `memoriahub.first_upload`. Titles, links, tiers and order may change; an id never does.

| Step id | Audience | Tier | Done when | Shown when | Permission | Link |
|---|---|---|---|---|---|---|
| `memoriahub.first_upload` | user | required | the user registered a media item (trashed ones count) | always | `media:write` | `/` |
| `memoriahub.create_album` | user | recommended | the user created an album | after the first upload | `media:write` | `/albums` |
| `memoriahub.invite_member` | user | recommended | a collaborator+ circle of the user has another member or a pending invite | the user is `collaborator` or `circle_admin` in a circle | `circles:write` | `/circles` |
| `memoriahub.name_people` | user | recommended | a named, live person exists in one of the user's circles | `features.faceRecognition` is on (hidden, not "todo", while off) | `media:write` | `/people` |
| `memoriahub.connect_device` | user | optional | an active Media Sync device or a live personal access token (the CLI's) | always | `media:write` | `/settings/android-app` |
| `user.profile`, `user.notifications` | user | optional | the platform's | the platform's | none | the platform's |
| `memoriahub.storage_ready` | admin | required | the platform storage slice resolves the active driver as fully configured (settings and secret) | always | `storage_config:read` | `/admin/settings/storage` |
| `admin.email` | admin | required | the platform's Doctor check `email.config` passes (this is MemoriaHub's "email ready" step) | always | `system_settings:read` | `/admin/settings/email` |
| `admin.access` | admin | required | an allowlist entry other than `INITIAL_ADMIN_EMAIL` | always | `allowlist:read` | `/admin/settings/users` |
| `memoriahub.enable_faces` | admin | recommended | `features.faceRecognition` on AND the Doctor check `memoriahub.face.detection` passes (CompreFace reachable) | the check is registered | `face_settings:read` | `/admin/settings/face` |
| `memoriahub.enable_tagging` | admin | recommended | `features.autoTagging` on AND `ai.features.tagging` names a provider with an enabled key | always | `ai_config:read` | `/admin/settings/tagging` |
| `memoriahub.enable_memories` | admin | recommended | `features.memories` on (and `MEMORIES_ENABLED` not `false`) | always | `system_settings:read` | `/admin/settings/memories` |
| `admin.push`, `admin.backup` | admin | recommended | the platform's (`push.vapid`, `backup.schedule`) | always (`push.vapid` comes with the notifications slice, RETRO-D3) | the platform's | the platform's |

Two platform built-ins are **not registered**: `admin.storage` (its page and `storage_config:read` belong to the platform storage slice, not mounted until RETRO-D1; `memoriahub.storage_ready` stands in) and `admin.ai` (it checks the platform AI runtime, which no MemoriaHub feature calls until RETRO-E2, and would point at MemoriaHub's own AI page; `memoriahub.enable_tagging` asks the real question). `admin.org-invite` is registered but never shown (single-organization mode binds no `orgInviteProgress`).

A step a caller cannot act on (permission missing, feature off, Doctor check absent) is omitted, never shown blocked.

## 3. Facts

A step's `applies` and `evaluate` are pure functions of the facts it names; the facts are the only reads, resolved at most once per request and only when an applicable step needs them. Each MemoriaHub fact is a bounded presence test (`count` with `take: 1`) scoped to the caller, or the cached settings document; none returns content or key material.

| Fact | Reads |
|---|---|
| `memoriahub.media_counts` | `media_items` by `added_by_id` |
| `memoriahub.album_counts` | `albums` by `added_by_id` |
| `memoriahub.circle_membership` | the caller's `collaborator`/`circle_admin` memberships (at most 100), then one other member and one unclaimed invite in those circles |
| `memoriahub.people_named` | named, live, unmerged `people` in circles the caller belongs to |
| `memoriahub.devices` | an active `media_sync_devices` row; a `personal_access_tokens` row neither revoked nor expired |
| `memoriahub.feature_readiness` | the cached system settings (5 s), plus the active storage provider's and the tagging provider's credential rows (`select: { id }` only); resolved for administrators only |

`ONBOARDING_FEATURES` reads `features.<name>` from the same cached settings (`memories` also honours `MEMORIES_ENABLED`).

## 4. Accounts that were already active

Onboarding ships into deployments whose users have uploaded for months, and the welcome opens for anybody whose `welcomeSeenAt` is unset. An account whose `memoriahub.first_upload` is already **done** the first time it loads onboarding, and that never saw the welcome nor dismissed a checklist, is **established**: the web shell writes once `establishedAt`, `welcomeSeenAt`, `checklistDismissedAt` and `adminDismissedAt` (all "now") and shows neither the dialog nor the banner. `establishedAt` is MemoriaHub's field in the `onboarding` namespace (`extendOnboardingSettings`); "Getting started" clears only the three platform fields, so the welcome and the checklists still come back on request and the mark is never written twice. The checklists stay reachable through their cards.

## 5. Activation metrics

Milestone `first_upload` ("First upload", 7 days): the first `media_items.created_at` of a user registered in the cohort window. The funnel counts `first_upload` and `create_album`. `GET /api/admin/onboarding/metrics?days=` (`system_settings:read`) returns aggregates only (one read-only statement); no per-user value and no metric label.

## 6. Code

- API: `apps/api/src/platform/onboarding/` (`onboarding.facts.ts`, `onboarding.steps.ts`, `onboarding.manifest.ts`, `onboarding.settings.ts`, the two adapters, `onboarding-host.module.ts`, `onboarding.config.ts`), mounted last in `app.module.ts`; the namespace is appended in `app-registrations/settings.ts`.
- Web: `components/common/Layout.tsx` (provider, banner, welcome), `components/onboarding/`, `platform/onboarding/` (route bindings, the established-account rule), `components/navigation/UserMenu.tsx` (menu item), the two cards in `config/adminSections.tsx` and `config/userSettingsSections.tsx`.
- Tests: `apps/api/test/onboarding/` (steps, facts, a DB-gated facts spec), the `onboarding` conformance suite in `apps/api/test/conformance.spec.ts`, `apps/web/src/__tests__/components/onboarding/`.
