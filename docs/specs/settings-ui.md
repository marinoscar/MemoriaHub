# Settings UI

MemoriaHub's copy of the platform's Settings UI Pattern (EnterpriseAppBase `docs/specs/settings-ui.md`), adopted in RETRO-B5 (issue #621). Every settings surface, admin and per-user, is a **registry-driven hub** rendered by the packaged `SettingsHub` (`@marinoscar/platform-web/settings/ui`).

## 1. The two registries

| Surface | Hub route | Registry | Binding |
|---|---|---|---|
| Admin (Console) | `/admin/settings` | `ADMIN_SECTIONS`, `apps/web/src/config/adminSections.tsx` | `apps/web/src/pages/Admin/SettingsHubPage.tsx` (`hubKey="admin-settings-hub"`, redirects a non-admin to `/`) |
| Per-user | `/settings` | `USER_SETTINGS_SECTIONS`, `apps/web/src/config/userSettingsSections.tsx` | `apps/web/src/pages/UserSettingsHubPage.tsx` (`hubKey="user-settings-hub"`, no route gate) |

Both registries use the platform types (`SettingsCardDef`, `SettingsSectionDef`) and spread the platform's cards as data: `identityAdminSections.access` (Users & Allowlist), `doctorSettingsPage.card` (Doctor) and `identityUserSettingsSections.security` (Access Tokens). The organization cards (`identityAdminSections.organizations`, `feature: 'orgs'`) are not spread: MemoriaHub runs in single-organization mode and routes no organization page. The `orgs` feature key is declared and resolved in `apps/web/src/config/settingsFeatures.ts` (`useOrgsFeature`).

The same `ADMIN_SECTIONS` also feeds the Console rail (`visibleAdminSections`, a wrapper over the packaged `visibleSettingsSections`) and the AppBar title (`adminPageTitle`, over `settingsPageTitle`), so the three surfaces share one gate.

### Per-user cards

| Section | Card | Route | Permission |
|---|---|---|---|
| Account | Profile | `/settings/profile` (`/profile` redirects here) | none |
| Account | Appearance | `/settings/appearance` | none |
| Account | Time zone | `/settings/time-zone` | none |
| Account | Notifications | `/settings/notifications` | none |
| Account | Memories | `/settings/memories` | none |
| Account | Search | `/settings/search` | none |
| Account | Getting started (onboarding slice, RETRO-H3) | `/settings/getting-started` | none |
| Android | Android app | `/settings/android-app` | none |
| Android | Media sync | `/settings/media-sync` | `media:read` |
| Security | Access Tokens (identity slice) | `/settings/tokens` | none |

These replace the old stacked `/settings` page; its anchors (`#notifications`, `#search-fields`, `#android-app`) redirect to the card page holding that section. The card pages share `apps/web/src/pages/settings/UserSettingsCardPage.tsx`. Time zone stays MemoriaHub's page rather than the packaged time zone UI: the package stores `profile.timezone`, while MemoriaHub stores a top-level `timezone` where absent means "never chose", not UTC (issue #444).

## 2. Rules

1. **Every settings page is a card** in one of the two registries, and every card's `path` is routed under its hub. A route without a card is a defect (`__tests__/config/settingsRoutes.test.ts`); the only exceptions are a child page reached from its card's page (`/admin/settings/nodes/:id/backup`) and redirects.
2. **Append, never insert.** A new card goes at the end of its section (or in a new section after the existing ones); existing cards keep their order.
3. **Never a tab.** A settings page is never added as a tab of another settings page. Tabs are only for genuinely parallel content inside one destination (Users and Allowlist on the Users page).
4. **A card's `permission` is the exact string the API controller enforces**, never invented. The admin list, card by card with its controller, is pinned in `settingsRoutes.test.ts`; the platform suite checks every string against the generated catalog (`apps/api/prisma/catalog/permissions.json`). Each admin card route is wrapped in `RequirePermission` with that same string, so a card and its route cannot disagree. Writes are gated inside the page.
5. **Never fork `SettingsHub`.** Both hubs are bindings over the packaged component; hub behaviour (grid, search, drill-down list, empty state) changes only in the package.

## 3. Breakpoint gates

The five coupled gates (rail, bottom bar self-gate, `<main>` bottom padding, `SettingsHub`'s `isCompactWindow`, AppBar's `isCompactWindow`) move together or not at all; the boundary is `sm` (600px), never `md`. Gate 4 is now the packaged `SettingsHub`'s `down('sm')` (both hubs); the other four stay in the app (`components/common/Layout.tsx` lists them) until RETRO-F1 moves the shell.

## 4. Conformance

`apps/web/src/__tests__/conformance.test.ts` runs the platform's `settings-*` web conformance suites (`@marinoscar/platform-web/settings/testing`) over both registries, the live `App.tsx` and the permission catalog. Two suites are skipped with a reason: `settings-route-ownership` (`/settings` is deliberately owned by no destination; `destinations.test.ts` pins ownership until RETRO-F1) and `settings-ai-cards` (MemoriaHub AI is not on the platform AI slice until RETRO-E4; its cards gate on `ai_settings:read`).
