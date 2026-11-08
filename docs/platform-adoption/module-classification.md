# Module classification

Frozen baseline classification of every top-level MemoriaHub module against EnterpriseAppBase (EAB) and its `@marinoscar/platform-*` packages. Input: the generated reports [drift-baseline.md](drift-baseline.md) (apps view) and [drift-baseline-slices.md](drift-baseline-slices.md) (slice view). Part of the platform retrofit program (epic [#555](https://github.com/marinoscar/MemoriaHub/issues/555)); tracked by issue #568 (RETRO-A1).

| Field | Value |
|---|---|
| EAB commit | `59e377cbebb60e711fe4d7b0d818715f23af8a59` |
| MemoriaHub commit | `928ea684fe95329d4a81e1e4b47ba3c54354e919` |
| Date | 2026-11-08 |

## How the numbers were produced

Both reports come from EAB's `scripts/platform-drift.mjs`, run from a scratch directory. `<EAB>` is a checkout of EnterpriseAppBase at the commit above, `<MEMORIAHUB>` is a checkout of MemoriaHub at its commit, `<SCRATCH>` is a temporary directory. The exact commands are in [README.md](README.md#regenerating-the-reports).

The apps view under-counts the API: EAB's `apps/api/src` holds only bindings, so MemoriaHub's base modules show as app-only with an n/a identity. For API base modules the **Drift** column therefore uses the slice view. Everything else (web, cli, prisma, infra, android, API modules with no slice) uses the apps view. Drift is written `identical % / lines added/removed`, counted over the files under the module's path. Identical % is identical plus normalised-identical files over the base-side files, `n/a` when the base has no file at that path. **Files** counts the MemoriaHub files in the module. A module without a base counterpart (all MemoriaHub-only paths) is `n/a`.

The committed slice report was generated with kvox's `make-slice-view.sh` unchanged. The copy in `scripts/platform-adoption/make-slice-view.sh` is adapted to MemoriaHub module names (`enrichment` to `jobs`, plus `doctor` and `android-app`), so a regeneration adds rows for those three; the `enrichment`, `doctor` and `android-app` drift cells below read `n/a (no slice)`, or the apps view, until it is re-run.

## Categories

- **noise**: differs only in comments, whitespace, identity or issue numbers, or the package covers it with no behaviour loss. The package replaces it. Delete on adoption.
- **backport**: MemoriaHub changed a base module in a way the platform lacks (a feature or a fix). Each one is re-expressed as a MemoriaHub workaround on top of the package (side table, registry entry, override, wrapper) and filed upstream in EAB. The row links the EAB issue.
- **domain**: MemoriaHub product code (media, circles, face, tagging, search, memories, workflows, location, dedup/burst/social, enhancement, review-runs, media-sync, share). Stays in MemoriaHub; packaged as `@marinoscar/memoriahub-*` in Epic J.
- **divergence**: MemoriaHub and EAB solved the same problem differently and MemoriaHub keeps its own design for now. The row says when it converges.

Plan IDs (`RETRO-A1`, `RETRO-C1`, ...) are resolved to issue numbers in the issue map of [#555](https://github.com/marinoscar/MemoriaHub/issues/555). In the tables below the plan column omits the `RETRO-` prefix.

### MemoriaHub workarounds referenced below

To be filled in by the slice issues as each workaround lands.

| Workaround | What it is | Used by |
|---|---|---|
| (none yet) | | |
| User-data decisions (RETRO-H1, #591) | `apps/api/src/platform/user-data/`: the keep-or-delete hints for every owner model, the `StorageObject` hint delegated to `memoriahub.circle.purge` (personal circle only, files routed per row), the user removal hook (reassign shared content, refuse while owning a shared circle with members), four factory reset steps. See [specs/user-data-deletion.md](../specs/user-data-deletion.md) | platform `user-data` slice (mounted), `circles`, `media`, `storage` |


## API: apps/api/src

Drift for mapped modules comes from the slice view; `n/a (no slice)` means the module has no packaged slice counterpart; plain `n/a` on `enrichment`, `doctor` and `android-app` means the committed slice view did not map them (see above). The 4 files directly under `apps/api/src` (`app.module.ts`, `main.ts`, specs) are bindings and are covered by the row `(root files)`.

### API

| Module | Files | Drift | Category | Target | Plan | Upstream (EAB) | Notes |
|---|---|---|---|---|---|---|---|
| `ai` | 10 | 0% / +12/-76 | backport | ai | E1 (#595), E2 (#601), E3 (#605), C4 (#590) | [EAB#1082](https://github.com/marinoscar/EnterpriseAppBase/issues/1082) (`enhanceImage`, `transcribeAudio`, `forSystem`); `embedText` already in the slice | Workaround: image edit and transcription ride the app-side AI feature registry (E2) until the seam ships; `ai_provider_credentials` re-encrypted into platform deployment keys (E3). E1 (#595): the slice is mounted (`platform/ai/ai.config.ts`), no provider SDK is imported or declared in `apps/`, and the call sites run on the legacy adapter `src/ai-port/` over the platform provider adapters until E2. |
| `allowlist` | 8 | 28.6% / +10/-36 | noise | identity (`allowlist`) | B2 (#611) | - | Package covers it; delete on adoption. |
| `android-app` | 22 | n/a | noise | android-app | D5 (#586) | - | EAB harvested this slice from MemoriaHub; remaining diff is identity and ordering. |
| `auth` | 31 | 7.7% / +504/-1174 | noise | identity (`auth`) | B2 (#611) | - | Google OAuth, JWT, refresh rotation. `returnTo` state already in the slice. |
| `burst` | 16 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (burst) | J10 (#624) (jobs: C5 (#594)) | - | Burst detection and review groups. |
| `circles` | 14 | n/a (no slice) | domain | sharing (groups) after I; `@marinoscar/memoriahub-api` until then | I1 (#562), I2 (#569), I3 (#573), I5 (#583) | - | Stays app-owned until Epic I (decision 2). Circle roles map to group roles; `CircleInvite` becomes `GroupInvite` (needs [EAB#1078](https://github.com/marinoscar/EnterpriseAppBase/issues/1078)). |
| `common` | 53 | n/a (no slice) | divergence | host (`core`, `http`, `maintenance`), settings schemas | B1 (#597), B3 (#614) | - | Exception filter, crypto, decorators, maintenance guard and logger have platform equivalents (delete in B1); `schemas/settings.schema.ts` is the hand-maintained namespace copy B3 removes; `geo/` and `time/` helpers stay app-side or move with their domain. |
| `config` | 3 | n/a (no slice) | noise | host (`configuration`) | B1 (#597) | - | Env parsing replaced by the generated env fragments (F2). |
| `db-backup` | 25 | 0% / +1891/-3231 | noise | db-backup | D4 (#580) | - | **Done (RETRO-D4):** deleted; `DbBackupModule.forRoot` in `src/platform/db-backup/` with MemoriaHub's backup target over its own storage providers (shim until D1), the `memoriahub-extensions` restore gate, the Android releases `RestoreCarryOver`, the legacy `db-backups/` prefix (`src/app-registrations/db-backup.ts`) and the legacy-history transform (`src/legacy/legacy-db-backup-migration.ts`). RLS dump flags are the platform's. |
| `dedup` | 25 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (dedup) | J10 (#624) (jobs: C5 (#594)) | - | Near-duplicate detection (CLIP plus dHash). |
| `device-auth` | 17 | 11.8% / +353/-780 | backport | identity (`device-auth`) | B2 (#611) | [EAB#1081](https://github.com/marinoscar/EnterpriseAppBase/issues/1081) (`clientInfo.returnUri`, bounded client labels) | Workaround: shim until the seam ships (`PLATFORM-ADOPTION-SHIM`). |
| `doctor` | 6 | n/a | divergence | doctor (framework) plus 35 app checks | B1b (#602) | - | Framework replaced by `DoctorModule.forRoot`; the 35 checks are ported as registered checks (app-owned ones stay domain). |
| `email` | 22 | 0% / +318/-907 | noise | email | D2 (#570) | - | **D2 (#570) landed:** `src/email` deleted; `EmailModule.forRoot` in `platform/email/`, MemoriaHub's three templates in `src/email-templates/` (registry), senders through `AppEmailSender` (shim until D3), SES has its own key pair (copied once from the S3 credential by `npm run email:migrate-settings`). |
| `enhancement` | 23 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (enhancement) | J10 (#624) (jobs: C4 (#590); AI: E2 (#601)) | - | AI Picture Enhancer and batches. Server-only jobs. |
| `enrichment` | 34 | n/a | divergence | jobs | C1 (#575), C3 (#585), C4 (#590), C5 (#594), C6 (#600), C7 (#604), C8 (#608) | - | **C1 (#575) landed:** `enrichment_jobs` became `jobs` through an adapter for the 38 handlers (`platform/jobs/`), the old queue files were deleted and the admin pages are the platform's; the table is kept as `enrichment_jobs_legacy` for one release. Priority, `skipDedup`, per-type timeouts and rate-limit deferral map to the platform `profile` and terminal state machine (EAB confirmed present), so no upstream issue is needed. |
| `face` | 41 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (face) | J6 (#615) (jobs: C3 (#585)) | - | Face detection, people, clustering, auto-archive. |
| `geo` | 13 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (location) | J10 (#624) (jobs: C6 (#600)) | - | Geocoding providers; credential via the node credential cache ([EAB#1083](https://github.com/marinoscar/EnterpriseAppBase/issues/1083)). |
| `health` | 5 | 0% / +37/-54 | noise | host (`health`) | B1 (#597) | - | Package covers it. |
| `insights` | 9 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (insights) | J10 (#624) (jobs: C8 (#608)) | - | `storage_insights` snapshot. |
| `location-groups` | 17 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (location) | J10 (#624) (jobs: C6 (#600)) | - | Canonical place names and rebuild job. |
| `location-inference` | 21 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (location) | J10 (#624) (jobs: C6 (#600)) | - | GPS inference from timeline anchors. |
| `media-sync` | 10 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (media-sync) | J5 (#613) (D5 (#586) for the device source) | - | Android device config, check-in, runs, diagnostics. |
| `media` | 102 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (media) | J5 (#613) | - | Media items, albums, tags, trash, archive. |
| `memories` | 65 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (memories) | J8 (#619) (jobs: C8 (#608)) | - | Curators, AI titles, email digest. |
| `metadata` | 9 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (media) | J5 (#613) (jobs: C3 (#585)) | - | Metadata re-extraction. |
| `nodes` | 30 | 0% / +1095/-1048 | backport | nodes | C2 (#581) | [EAB#1076](https://github.com/marinoscar/EnterpriseAppBase/issues/1076) (`nod_` reach for app routes), [EAB#1083](https://github.com/marinoscar/EnterpriseAppBase/issues/1083) (credential cache), harvest [EAB#1070](https://github.com/marinoscar/EnterpriseAppBase/issues/1070) | Workaround: `/api/nodes/:id/backup/*` mounted through the supported rung once SEAM-NODE-ROUTES ships; `node_backup_*` side tables stay app-owned. |
| `notifications` | 73 | 0% / +1345/-1922 | backport | notifications | D3 (#576) | [EAB#1077](https://github.com/marinoscar/EnterpriseAppBase/issues/1077) (STATE and COUNTED-EVENT primitives) | Workaround: `upsertState`/`upsertCountedEvent` and the `notifications_review_queue_live_uniq_idx` partial index re-expressed as an app side table or ride the seam; `countAtRead` re-unread rule stays app-side until then. |
| `openapi` | 16 | 22.2% / +133/-320 | noise | host (`openapi`) | B1 (#597) | - | Package covers it. |
| `pat` | 8 | 16.7% / +53/-169 | noise | identity (`pat`) | B2 (#611) | - | Package covers it. |
| `prisma` | 2 | n/a (no slice) | noise | core (PrismaService, `forOrg`) | A5 (#587), I2 (#569) | - | `PrismaService` replaced by the platform one; RLS scope helpers arrive with the org transform. |
| `review-runs` | 20 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (review-runs) | J9 (#622) (jobs: C7 (#604)) | - | Shared bulk review run engine. |
| `search` | 15 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (search) | J7 (#618) | - | Deterministic, semantic and agentic search. |
| `settings` | 20 | 0% / +1190/-610 | noise | settings | B3 (#614) (web: B5 (#621)) | - | Namespaces register through the registry; the three hand-maintained copies are deleted. |
| `share` | 8 | n/a (no slice) | divergence | sharing (link grants) | I4 (#578) | - | `MediaShare` becomes link grants; legacy tokens kept via `importLegacyToken`. Converges in Epic I. |
| `social-media` | 12 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (social-media) | J10 (#624) (jobs: C5 (#594)) | - | Social-media video detection. |
| `storage-settings` | 11 | n/a (no slice) | noise | storage (`config`) | D1 (#563) | - | Multi-provider credential admin; platform storage config owns it. |
| `storage` | 63 | 1.2% / +1072/-567 | backport | storage | D1 (#563), D1b (#567) | [EAB#1079](https://github.com/marinoscar/EnterpriseAppBase/issues/1079) (per-row provider routing, part route, ListParts resume, copy-only migration) | Workaround: `local` driver and part route app-side until the seam ships; stuck-processing recovery and thumbnail repair become queue jobs on the platform pipeline (D1b), not an upstream request. |
| `tagging` | 19 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (tagging) | J7 (#618) (jobs: C4 (#590)) | - | Tag vocabulary and auto-tagging persistence. |
| `test-auth` | 7 | n/a (no slice) | noise | identity (`testing`) | B2 (#611) | - | Test-only login helper. |
| `users` | 15 | 12.5% / +52/-250 | noise | identity (`users`) | B2 (#611) | - | Avatar columns (`avatar_source`, `avatar_storage_key`, `linked_person_id`) and `UserAvatarService` stay app-side as a side table; B2 records the decision. |
| `workflows` | 52 | n/a (no slice) | domain | `@marinoscar/memoriahub-api` (workflows) | J9 (#622) (jobs: C7 (#604)) | - | Rule-based media automation. |
| `(root files)` | 4 | 0% / +195/-106 | divergence | host bindings (`app.module.ts`), `app-registrations` | B1 (#597), C1 (#575) | - | Wiring file; becomes a thin binding of the platform modules. |

Slices adopted with no prior MemoriaHub module (no row above, nothing deleted): **alerts** (RETRO-H5, #609) is mounted in `src/platform/alerts/` with MemoriaHub's two rule kinds and five default rules; `NodeStaleOfflineTask` (app, until C2) still produces the offline state of legacy nodes, and `EnrichmentFailureNotificationListener` stays (the in-app inbox; alerts are the operator channel). Runbook: [alerts.md](../runbooks/alerts.md).

## Web: apps/web/src

`components` and `pages` are split into one row per sub-directory (and `pages (root files)`); every other top-level directory has one row.

### Web

| Module | Files | Drift | Category | Target | Plan | Upstream (EAB) | Notes |
|---|---|---|---|---|---|---|---|
| `__tests__` | 289 | 4.6% / +3153/-4317 | divergence | follows its module | each slice issue | - | Tests are replaced slice by slice with the conformance suites (`runPlatformWebConformance`); domain tests move with their package (J11). |
| `assets` | 1 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - | Brand assets; theme colours come from identity (A2). |
| `components/admin` | 16 | n/a | divergence | web `settings/ui`, `jobs`, `nodes` | B5 (#621), F1 (#571), C2 (#581) | - | Admin cards and pages; platform pages replace generic ones, domain admin pages stay. |
| `components/album` | 7 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `components/auth` | 1 | n/a | noise | identity (`ui`) | B2 (#611) | - | Login and guards. |
| `components/collections` | 1 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `components/common` | 10 | 66.7% / +71/-22 | divergence | shell | F1 (#571) | - | Shared widgets; `scrollableTabsProps` and friends compared in F1. |
| `components/datatable` | 44 | n/a | noise | `platform-web/datatable` | F1 (#571) | - | Deleted in F1. Parity diff: the platform is ahead (theme tokens, `IndeterminateCheckbox`, zone-aware `exportFilename`, `DataTablePreferencesPort` over the same `user_settings.dataTables` shape); nothing to backport. Every consumer imports `datatable/ui`, `/headless`, `/testing`; the identity adapter binds it too. |
| `components/device-activation` | 3 | n/a | backport | identity (`ui`) | B2 (#611) | [EAB#1081](https://github.com/marinoscar/EnterpriseAppBase/issues/1081) | Return deep-link UX. |
| `components/insights` | 5 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `components/locations` | 1 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `components/map` | 8 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `components/media` | 30 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `components/memories` | 9 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `components/navigation` | 6 | 0% / +761/-32 | backport | shell | F1 (#571) | [EAB#1080](https://github.com/marinoscar/EnterpriseAppBase/issues/1080) (SEAM-SHELL, shipped in 0.1.0-next.22) | F1: `AppBar`, `NavigationRail`, `BottomNav` are thin bindings of `ShellAppBar` / `ShellNavigationRail` / `ShellBottomNav`; `NavContextPane` supplies the two `contextPane` contents; `CircleChip` stays domain; `UserMenu` stays a shim ([local exceptions](local-exceptions.md)). |
| `components/notifications` | 5 | n/a | noise | notifications (web) | D3 (#576) | - | Bell, toasts, push helpers. |
| `components/people` | 8 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `components/pwa` | 2 | n/a | noise | host (`ui`) | B1 (#597) | - | `InstallPrompt`, `UpdatePrompt`. |
| `components/review` | 7 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `components/runs` | 2 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - | `RunProgressPanel` shared by review, trash and enhancement runs. |
| `components/search` | 8 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `components/settings` | 28 | n/a | divergence | settings (`ui`) | B5 (#621) | - | Replaced by the packaged `SettingsHub`; domain cards stay. |
| `components/share` | 2 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) (I4 (#578)) | - | Share dialog moves to `ShareDialog` over link grants in I4. |
| `components/user` | 3 | 0% / +6/-6 | noise | identity (`ui`) | B2 (#611) | - | Avatar crop and linked-person card stay app-side with the avatar decision. |
| `components/workflows` | 20 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `config` | 4 | 0% / +283/-162 | divergence | shell, settings hubs | B5 (#621), F1 (#571) | - | `adminSections.tsx` stays a registry; spreads the identity cards. |
| `constants` | 3 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - | Workflow metadata and app constants. |
| `contexts` | 6 | 0% / +56/-8 | divergence | identity (`AuthProvider`), shell | B2 (#611), F1 (#571) | - | `AuthContext`, `ThemeContext` go to the platform; circle, media-preview, refresh and search contexts stay domain. |
| `hooks` | 93 | 11.1% / +433/-38 | divergence | per-slice web hooks | B5 (#621), D3 (#576), C2 (#581), F1 (#571), J11 (#626) | - | Admin hooks (jobs, nodes, doctor, db-backup, email, push) come from platform packages; media, circle and memory hooks stay domain. |
| `lib` | 1 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - | Leaflet setup. |
| `pages/Admin` | 40 | 0% / +331/-24 | divergence | packaged admin pages | B5 (#621), F1 (#571) | - | 42 files; generic pages replaced, domain admin pages stay. |
| `pages/Albums` | 5 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/Archive` | 1 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/Bursts` | 2 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/Circles` | 3 | n/a | domain | sharing groups UI | I6 (#588) | - | Circle UX moves onto platform groups. |
| `pages/Collections` | 1 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/Duplicates` | 2 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/Enhancements` | 4 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/Insights` | 1 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/LocationSuggestions` | 3 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/MediaLibrary` | 2 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/MediaMapPage` | 2 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/Memories` | 2 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/Notifications` | 2 | n/a | noise | notifications (web) | D3 (#576) | - | Inbox page. |
| `pages/People` | 2 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/Places` | 6 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/Profile` | 1 | n/a | noise | identity (`ui`) | B2 (#611) | - | `UserProfilePage` from the package; avatar card stays. |
| `pages/Public` | 1 | n/a | divergence | sharing (link pages) | I4 (#578) | - | `/s/:token` public share pages. |
| `pages/Reviews` | 3 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/Tags` | 3 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/Trash` | 2 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages/Workflows` | 4 | n/a | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `pages (root files)` | 12 | n/a | divergence | identity, settings, host pages | B2 (#611), B5 (#621), B1 (#597) | - | `LoginPage`, `AuthCallbackPage`, `ActivateDevicePage`, `MaintenancePage`, `UserSettingsPage`, `SystemSettingsPage`, `UserManagementPage` come from packages; `HomePage`, `SearchPage`, `MediaSyncPage`, `AndroidAppDownloadPage` stay or follow D5. |
| `services` | 54 | 0% / +273/-35 | divergence | per-slice web clients | B2 (#611), B5 (#621), C2 (#581), D3 (#576), J11 (#626) | - | `api.ts` becomes `createPlatformApiClient`; admin clients go to packages; media-facing services stay domain. |
| `theme` | 4 | 0% / +76/-17 | noise | shell (`createShellTheme`) | F1 (#571), A2 (#572) | - | Identity colours (A2). |
| `types` | 10 | 0% / +252/-69 | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - |  |
| `utils` | 15 | 50% / +0/-0 | domain | `@marinoscar/memoriahub-web` | J11 (#626) | - | Civil-date helpers and others; no base counterpart. |
| `(root files)` | 4 | 0% / +334/-610 | divergence | shell, host | F1 (#571), B1 (#597) | - | `App.tsx`, `main.tsx`, `sw.ts`, `vite-env.d.ts`; rewired to the platform shell and providers. |

## CLI: apps/cli/src

### CLI

| Module | Files | Drift | Category | Target | Plan | Upstream (EAB) | Notes |
|---|---|---|---|---|---|---|---|
| `android` | 18 | n/a | domain | `platform-cli` android group | D5 (#586) | - | `memoriahub android *` becomes `androidCommand`; build and keystore tooling is the platform one. |
| `backup` | 16 | n/a | domain | `@marinoscar/memoriahub-api` (cli) | F3 (#577), C10 (#616) | - | Local Media Backup client; reaches `nod_` routes via [EAB#1076](https://github.com/marinoscar/EnterpriseAppBase/issues/1076). |
| `commands` | 20 | 0% / +1435/-562 | divergence | `createCli` `extraCommands` | F3 (#577) | - | Command registration through `translateLegacyArgs`. |
| `convert` | 5 | n/a | domain | `extraCommands` | F3 (#577) | - |  |
| `date-inference` | 4 | n/a | domain | `extraCommands` | F3 (#577) | - |  |
| `dates` | 1 | n/a | domain | `extraCommands` | F3 (#577) | - |  |
| `db` | 4 | n/a | divergence | `platform-cli` db commands | F3 (#577) | - | Compare with `platform db`; keep only app-specific parts. |
| `export` | 4 | n/a | domain | `extraCommands` | F3 (#577) | - |  |
| `http` | 2 | n/a | divergence | `platform-cli` http client | F3 (#577) | - |  |
| `node` | 29 | 0% / +1892/-1539 | backport | `platform-cli` node engine | C10 (#616) | [EAB#1070](https://github.com/marinoscar/EnterpriseAppBase/issues/1070) (G2: memwatch, runtime tuning, heap-snapshot, URL-input executors, install-deps) | Executors, requirements and doctor checks stay app-side; engine hardening is harvested upstream. |
| `organize` | 3 | n/a | domain | `extraCommands` | F3 (#577) | - |  |
| `render` | 9 | n/a | domain | `extraCommands` | F3 (#577) | - |  |
| `repo` | 5 | n/a | domain | `extraCommands` | F3 (#577) | - |  |
| `reports` | 6 | n/a | domain | `extraCommands` | F3 (#577) | - |  |
| `scan` | 4 | n/a | domain | `extraCommands` | F3 (#577) | - |  |
| `screenshots` | 3 | n/a | domain | `extraCommands` | F3 (#577) | - |  |
| `sync` | 6 | n/a | domain | `extraCommands` | F3 (#577) | - | Resumable importer. |
| `tui` | 49 | 0% / +746/-37 | backport | `platform-cli` TUI framework | F4 (#582) | [EAB#1064](https://github.com/marinoscar/EnterpriseAppBase/issues/1064) (G1 epic) | Menu tree, app context, dashboard sources and component kit harvested upstream; screens re-hosted in F4 (done: `apps/cli/src/tui/`, parity in [tui-parity.md](tui-parity.md)). |
| `(root files)` | 22 | n/a | divergence | `createCli` | F3 (#577) | - | `index.ts` and shared helpers. |

## Android: apps/android/app/src/main/java/memoriahub/marin/cr

The Kotlin sources live under `src/main/java` (the issue text says `kotlin`). Each top-level package is one row. The platform side is `:platform-core` (`platform-infra/android/platform-core`), which carries `auth`, `config`, `net`, `notifications`, `pairing`, `twa`, `update` and `util`.

### Android

| Module | Files | Drift | Category | Target | Plan | Upstream (EAB) | Notes |
|---|---|---|---|---|---|---|---|
| `auth` | 1 | n/a | noise | platform-core (`auth`) | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.auth`. |
| `config` | 2 | n/a | noise | platform-core (`config`) | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.config`. |
| `contract` | 3 | n/a | domain | MemoriaHub Android module | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.contract`. |
| `deeplink` | 1 | n/a | domain | MemoriaHub Android module | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.deeplink`. |
| `diagnostics` | 10 | n/a | divergence | platform-core diagnostics framework; 22 check ids stay domain | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.diagnostics`. |
| `ledger` | 11 | n/a | domain | MemoriaHub Android module | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.ledger`. |
| `media` | 6 | n/a | domain | MemoriaHub Android module | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.media`. |
| `mediasync` | 18 | n/a | domain | MemoriaHub Android module | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.mediasync`. |
| `net` | 5 | n/a | noise | platform-core (`net`) | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.net`. |
| `notifications` | 2 | n/a | noise | platform-core (`notifications`) | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.notifications`. |
| `pairing` | 8 | n/a | noise | platform-core (`pairing`) | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.pairing`. |
| `permissions` | 1 | n/a | divergence | platform-core permissions helpers | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.permissions`. |
| `setup` | 1 | n/a | domain | MemoriaHub Android module | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.setup`. |
| `sync` | 20 | n/a | domain | MemoriaHub Android module | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.sync`. |
| `twa` | 1 | n/a | noise | platform-core (`twa`, `TwaLauncher`) | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.twa`. |
| `ui` | 2 | n/a | divergence | platform-core theme; Hub, Folders, Network, Files screens stay domain | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.ui`. |
| `update` | 2 | n/a | noise | platform-core (`update`) | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.update`. |
| `upload` | 8 | n/a | domain | MemoriaHub Android module | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.upload`. |
| `util` | 2 | n/a | noise | platform-core (`util`) | D5 (#586) | - | Kotlin package `memoriahub.marin.cr.util`. |
| `(root: `MobileApplication.kt`)` | 1 | n/a | domain | MemoriaHub Android module | D5 (#586) | - | Lazy singleton wiring (no Hilt/Dagger). |

## Prisma: apps/api/prisma

### Prisma

| Module | Files | Drift | Category | Target | Plan | Upstream (EAB) | Notes |
|---|---|---|---|---|---|---|---|
| `migrations` | 82 | 7.3% / +0/-0 | divergence | platform-db migrations plus `@marinoscar/memoriahub-db` | A5 (#587), J3 (#606) | - | 82 migrations. Installed migrations are never edited; A5 adds the baseline transform, J3 moves domain migrations into the db package. |
| `schema.prisma` | 1 | n/a | divergence | `prisma/fragments` and generated schema | A4 (#579) | - | Split into fragments; schema output becomes generated. |
| `seed.ts` | 1 | 0% / +283/-14 | divergence | platform seed plus app seed | B2 (#611) | - | Roles and permissions move to the registry; media-specific seed rows stay. |
| `tsconfig.json` | 1 | 0% / +6/-15 | noise | host | A3 (#574) | - | Tooling file. |

## Infra: infra

### Infra

| Module | Files | Drift | Category | Target | Plan | Upstream (EAB) | Notes |
|---|---|---|---|---|---|---|---|
| `aws` | 3 | n/a | domain | app-owned (`infra/aws`) | F2 (#566) | - | S3 bucket helper; kept as app files. |
| `compose` | 6 | 0% / +81/-90 | divergence | generated by `platform:infra:sync` | F2 (#566), T1 (#623) | - | Hand-written compose replaced by generated files plus `app.*.compose.yml` overlays (#566). The Uptrace stack (`otel.compose.yml`) is removed; telemetry comes from the generated `telemetry.compose.yml` (GreptimeDB, T1 #623). |
| `deploy` | 2 | n/a | noise | `platform deploy` | F2 (#566), F3 (#577) | - | `install.sh` and `update.sh` are still present (#566 keeps them until the platform deploy step exists); the mapping is in `docs/platform-adoption/deploy-steps.md`. |
| `nginx` | 2 | 0% / +53/-51 | divergence | generated by `platform:infra:sync` | F2 (#566) | - | Same-origin routing; SSE and upload locations kept as `nginx/app.d/` overlays. |
| `otel` | 2 | 0% / +16/-182 | platform | otel-core, telemetry overlay | T1 (#623) | - | `uptrace.yml` removed in F2 (#566); the collector config is generated from the platform (GreptimeDB, T1 #623). |

## Harvested slices (Epic RETRO-H)

Platform slices MemoriaHub never had a module for; there is nothing to classify or delete, only the binding and MemoriaHub's registrations.

| Slice | Binding | Plan | Notes |
|---|---|---|---|
| onboarding | `apps/api/src/platform/onboarding/`, web `platform/onboarding/` + `components/onboarding/` | H3 (#599) | `OnboardingModule.forRoot` with the platform steps minus `admin.storage` (until D1) and `admin.ai` (until E2), nine permanent `memoriahub.*` steps, six facts, the `first_upload` milestone and the `onboarding.establishedAt` field. Spec: [docs/specs/onboarding.md](../specs/onboarding.md). |

## Migrations and models

Counts come from [drift-baseline.md](drift-baseline.md) (sections "Migrations" and "Prisma models"); the database transform itself is RETRO-A5 (#587) and the baseline runbook is `docs/runbooks/database-baseline.md` in EAB.

- Prisma models: 24 of 46 base models are present in MemoriaHub; 73 models in total; 50 are MemoriaHub-only (domain, moved to `@marinoscar/memoriahub-db` in J3).
- Base models missing from MemoriaHub (arrive with their slices): organizations, memberships, groups, grants, jobs, credentials, webhooks, alerts, AI platform tables.
- Shared models with differing fields (`User`, `Notification`, `DatabaseBackupRun`, `DeviceCode`, `WorkerNode`, ...) are listed in the report and handled by the owning slice issue.

## Summary

Rows per category (modules listed above):

| Category | Rows |
|---|---|
| noise | 33 |
| backport | 9 |
| domain | 77 |
| divergence | 29 |
| total | 148 |

## Backport index

Every `backport` row and its upstream EAB issue (all already filed):

| Row | Upstream |
|---|---|
| api `ai` | [EAB#1082](https://github.com/marinoscar/EnterpriseAppBase/issues/1082) (`enhanceImage`, `transcribeAudio`, `forSystem`); `embedText` already in the slice |
| api `device-auth` | [EAB#1081](https://github.com/marinoscar/EnterpriseAppBase/issues/1081) (`clientInfo.returnUri`, bounded client labels) |
| api `nodes` | [EAB#1076](https://github.com/marinoscar/EnterpriseAppBase/issues/1076) (`nod_` reach for app routes), [EAB#1083](https://github.com/marinoscar/EnterpriseAppBase/issues/1083) (credential cache), harvest [EAB#1070](https://github.com/marinoscar/EnterpriseAppBase/issues/1070) |
| api `notifications` | [EAB#1077](https://github.com/marinoscar/EnterpriseAppBase/issues/1077) (STATE and COUNTED-EVENT primitives) |
| api `storage` | [EAB#1079](https://github.com/marinoscar/EnterpriseAppBase/issues/1079) (per-row provider routing, part route, ListParts resume, copy-only migration) |
| web `components/device-activation` | [EAB#1081](https://github.com/marinoscar/EnterpriseAppBase/issues/1081) |
| web `components/navigation` | [EAB#1080](https://github.com/marinoscar/EnterpriseAppBase/issues/1080) (SEAM-SHELL) |
| cli `node` | [EAB#1070](https://github.com/marinoscar/EnterpriseAppBase/issues/1070) (G2: memwatch, runtime tuning, heap-snapshot, URL-input executors, install-deps) |
| cli `tui` | [EAB#1064](https://github.com/marinoscar/EnterpriseAppBase/issues/1064) (G1 epic) |
