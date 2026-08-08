# CI Known-Failing Tests

These suites are excluded from `test:ci` in each app. Each exclusion is intentional and tracked here as follow-up debt.

> **Lesson (issues #193, #202):** Auditing the rotted-suite exclusions across both apps found that **7 of the 12 were stale** — 2 of the 4 API ones (`system-settings.service`, `search-agent.service`) and 5 of the 8 web ones (`App`, `CircleDetailPage`, `Layout`, `JobsPage`, `Sidebar`). Those tests had already been fixed, or were never actually broken, but nobody ever lifted the exclusion — so the repo carried phantom debt and silently lost that coverage for no reason. Two rules follow: (a) whoever fixes a rotted suite must remove its exclusion in the SAME PR that fixes it, never leaving it for "later"; (b) entries in this file need periodic re-verification — don't trust an old "still failing" note without re-running the suite.

---

## API — Integration Suites (RESOLVED, issues #220 + #221 — nothing excluded)

**Pattern excluded:** none. `test:ci` now ignores only `e2e`.

All 26 `*.integration.spec.ts` suites run in `test:ci`. #220 fixed the harness and repaired five suites; #221 rewrote the sixth (`media/media.integration.spec.ts`) against the circle-scoped API and lifted the last exclusion.

> ### ⚠️ The root cause previously recorded here was wrong
>
> This section used to state that integration specs *"require a live PostgreSQL database… the helper attempts to connect on startup"*, and prescribed adding a `postgres` service container to the CI job. **That was incorrect in every particular**, and following it would have burned a day on infrastructure that could not have helped:
>
> - `createTestApp` defaults to `useMockDatabase: true` and calls `.overrideProvider(PrismaService).useValue(prismaMock)`. It **never opens a database connection.**
> - All 26 integration specs explicitly pass `useMockDatabase: true`. Not one uses a real database.
>
> Recorded here as a worked example of the lesson at the top of this file: an exclusion note is a claim, and claims rot. Re-run the suite before trusting one.

**Actual root cause (fixed):** every integration spec boots the full `AppModule`, which includes `OfflineGeoLocationProvider`. Its `onModuleInit` initializes `local-reverse-geocoder`, which (a) dynamically `import()`s ESM `node-fetch@3` — rejected by Jest's CJS VM with *"A dynamic import callback was invoked without `--experimental-vm-modules`"* — and (b) downloads the GeoNames dataset over the network before resolving. That alone accounted for 22 of the 26 suites failing.

`createTestApp` now replaces that provider with an inert stub for both the mocked-DB and real-DB paths, since the problem is a property of running under Jest, not of how Prisma is wired.

Four further suites were repaired alongside it:

| Suite | What had rotted |
|---|---|
| `settings/system-settings` | `createMockSystemSettings` hardcoded `features: {}`; `getSettings()` returns `value.*` verbatim without merging defaults, so the API appeared to return no feature flags. The fixture now derives from `DEFAULT_SYSTEM_SETTINGS` so it cannot drift again. |
| `media/media-bulk-dashboard` | Asserted a flat `where` object; media filters are now AND-composed into `where.AND[]` (see `docs/audits/search-audit.md`). Now flattened before asserting, so the check no longer depends on descriptor count or order. |
| `storage/storage` | Mocked the injected `STORAGE_PROVIDER` token, which `ObjectsService` stopped consulting when multi-provider routing landed — it resolves via `StorageProviderResolver`. The spec was making **real AWS S3 calls**. Now stubs the resolver. |
| `integration/share` | Asserted `response.body.*` before the global response envelope (`{ data, meta }`) was introduced. |

**Two real (if minor) product bugs were found by these specs once they could run**, both a `@Post` bulk mutation documenting `@ApiResponse({ status: 200 })` with no `@HttpCode`, so Nest's POST default returned 201: `POST /api/media/bulk/tags` (its four sibling `bulk/*` endpoints all had `@HttpCode(HttpStatus.OK)`) and `POST /api/shares/bulk`. Both fixed in the controllers.

**Known, deliberately unfixed:** every `POST /test` connectivity endpoint (`email-settings`, `face`, `geo`, `storage-settings`) has the same doc/behaviour mismatch — all document 200, none sets `@HttpCode`, all return 201. Because they are *consistent* with each other, the email spec was updated to assert 201 rather than change four controllers' status codes from inside a test-repair change. Worth resolving one way or the other in its own PR.

---

## API — `media.integration.spec.ts` — RESOLVED (issue #221)

**No longer excluded.** The spec predated Family Circles: zero references to `circleId` across 1071 lines, factories building items with an `ownerId` field against a schema that had moved to `added_by_id` + `circle_id`, and 35 of its 54 tests failing with 400 because `/api/media*` requires `circleId` plus per-circle membership. That was not assertion drift — it was a spec written against a superseded data model — so #220 deliberately left it out of the harness fix rather than mixing a rewrite into that change.

Rewritten against the current API using `media-bulk-dashboard.integration.spec.ts` as the reference (its `setupCircleMocks` helper, its `circleId`/`addedById` factories, and the `flattenWhere` helper for AND-composed filter predicates). The rewrite also added the per-circle authorization coverage the old spec could not express at all — a non-member getting 403, and a `viewer` refused on every write — which is the invariant the suite most needed to protect.

63 tests, all passing in `test:ci`.

---

## CLI — Rotted Fixture Suites (4 files)

Added when `apps/cli` first gained CI coverage (`cli-test` job in `ci.yml`, issue #151). These fail due to fixture/schema drift unrelated to any recent change — the specs were simply never updated when the code they cover moved on:

| File | Reason |
|------|--------|
| `test/db/migrations.spec.ts` | Asserts sqlite `user_version` is `8`; `src/db/migrations.ts` has since added later migrations, so the version is now higher |
| `test/db/migration-v6.spec.ts` | Same root cause — asserts the pre-migration `user_version`, now stale |
| `test/export/scan-export.spec.ts` | Asserts an export column set that predates the "Fallback date"/"Fallback location" columns added later |
| `test/sync/sync-engine-date-range.spec.ts` | Same fallback-date/location column drift as the export spec |

**Fix:** Update each fixture's expected `user_version` / column list to match the current schema. No behaviour regressions.

## CLI — TUI concurrency flakes: two fixed, a broader pattern tracked as follow-up

`test/tui/menu-nav.spec.tsx` and `test/tui/circle-manager.spec.tsx` failed intermittently under `--ci`/full-suite runs while passing reliably in isolation. Root-caused and fixed (not excluded):

- Both used a **fixed-duration `setTimeout` "flush"** to wait for an async render/state update before asserting — a race that a fast, uncontended machine always wins but a loaded CI runner can lose. Replaced with `test/tui/wait-for.ts`'s `waitForFrame`/`waitForCalls`, which poll for the actual condition (with a bounded timeout) instead of guessing a duration.
- A subtler gap: sending two keystrokes back-to-back (e.g. down-arrow then Enter) without waiting for the first one's effect to commit could have the second processed against a stale closure/selection. Fixed by polling for the intermediate visible state before sending the next input — see the two specs and `wait-for.ts`'s header comment for the detail.
- `circle-manager.spec.tsx` additionally had an unrelated bug surfaced during this fix: a down-arrow keystroke written as the literal characters `'[B'` instead of the escape sequence `'\x1B[B'` (an invisible-control-character transcription artifact), which meant the arrow key was never actually recognized — corrected.
- **`menu-nav.spec.tsx`'s intermediate-state check initially hardcoded the wrong thing** — it matched a literal `'>'` pointer glyph, which is what `ink-select-input` (a third-party dependency) happened to render locally, but real GitHub Actions CI rendered a different Unicode pointer (`❯`) for the same selected row (environment-dependent Unicode-support detection in that library's rendering, not something this codebase controls). This passed every local run and the first attempt at this fix still failed on the real CI runner as a result — corrected by diffing the row's rendered text against its own unselected baseline instead of matching any specific glyph, so the check no longer depends on which pointer character a given environment happens to draw. `circle-manager.spec.tsx`'s equivalent check (`'▶'`) was NOT affected — that marker is a literal hardcoded in the application's own source (`CircleManager.tsx`), not chosen by a third-party library's theming, so it renders identically everywhere.

**Broader latent risk (not fixed here):** ~13 more `test/tui/*.spec.tsx` files share the same fixed-duration-sleep pattern and have not been individually root-caused. One of them, `test/tui/node-register.spec.tsx`, was observed to flake once in ~9 full-suite `--ci` runs while validating the two fixes above. Rather than exclude that coverage wholesale or make unverified blind edits to files not yet read closely, a **retry safety net** is enabled for `test/tui/` specs only (`test/tui/jest.setup.ts`, `jest.retryTimes(2)`): a genuine regression still fails after the retries, while an environment-timing flake gets the extra attempt it needs. This does not fix the underlying pattern — it bounds its cost until each file gets the same treatment as the two above.

**Fix:** Audit the remaining ~13 `test/tui/*.spec.tsx` files using the `flushAsync`/fixed-`setTimeout` pattern (`grep -rl "function flushAsync\|setTimeout(r, [0-9]*))" apps/cli/test/tui/*.spec.tsx`) and convert each to `wait-for.ts`'s poll-based helpers, following the pattern established in `menu-nav.spec.tsx`/`circle-manager.spec.tsx`. Once all are converted, remove `test/tui/jest.setup.ts`'s retry (it will no longer be needed).

---

## API — DB-gated suites must SKIP, never vacuously pass (RESOLVED, issue #288)

Not an exclusion — a reporting-honesty rule, recorded here because it is the same failure mode this file exists to catch: a suite that looks green while covering nothing.

Three suites (`circles/migration-backfill`, `notifications/notification-dedup`, `review-runs/review-runs`) need a real PostgreSQL server and cannot run in CI. `migration-backfill` reported its 15 tests as **passed** with no database anywhere, asserting nothing. Two mistakes combined:

1. **The gate read env vars only.** `.env.test` declares `POSTGRES_HOST` unconditionally, so the check was true even with nothing listening and the `describe` block ran.
2. **The real probe was async, inside `beforeAll`.** Jest fixes `describe`/`it` registration — and therefore skipped-vs-passed — at module-evaluation time, which completes before any `beforeAll` body runs. By the time the probe resolved, the suite was already registered as a normal `describe`. The fallback was a per-test `skipIfNoDb` wrapper whose body was `expect(true).toBe(true); return;` — **a genuine PASS.**

**Rule:** a DB-gated suite gates on `describeMaybeDb` / `isDatabaseReachable` from `apps/api/test/helpers/db-probe.helper.ts`, whose probe is synchronous and evaluated at module load, so a real `describe.skip` is chosen before Jest registers anything. Inside the block the database is known reachable — `prisma` is non-nullable and no test needs a runtime guard. **Never add a per-test guard that returns early with a trivial assertion**; `test/helpers/db-probe.helper.spec.ts` fails the build if one reappears.

With no database, the three suites now report **36 skipped** (previously 15 passed + 21 skipped).

---

## Priority

1. **CLI rotted fixture suites** — update stale fixture expectations (version numbers, column lists) to match current schema.
2. **CLI TUI concurrency-flaky pattern** — convert the remaining ~13 files to the poll-based `wait-for.ts` helpers, then remove the retry safety net.
3. **API DB-gated suites** — they skip honestly today. Running them for real needs a PostgreSQL service container in the CI job plus applied migrations; until then their coverage is local-only, which the skip count now states plainly.
