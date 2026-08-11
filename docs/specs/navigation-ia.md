# Navigation Information Architecture

> **Status:** Proposed — tracked by epic [#388](https://github.com/marinoscar/MemoriaHub/issues/388) (issues [#389](https://github.com/marinoscar/MemoriaHub/issues/389), [#390](https://github.com/marinoscar/MemoriaHub/issues/390), [#391](https://github.com/marinoscar/MemoriaHub/issues/391), [#392](https://github.com/marinoscar/MemoriaHub/issues/392)). Nothing in this document is implemented yet.
> **Interactive mockups:** [`assets/navigation-ia-mockups.html`](assets/navigation-ia-mockups.html) — open in a browser; the three breakpoint layouts are drawn to relative scale.

This spec replaces MemoriaHub's single 22-row navigation drawer with **four primary
destinations** and **two modes** (Library / Console), and gives phone, tablet, and desktop
three genuinely different navigation treatments instead of one drawer stretched across all
of them.

---

## 1. The problem

### 1.1 Item count is the symptom, not the disease

`apps/web/src/components/navigation/Sidebar.tsx` renders **22 rows across 4 sections** for an
admin with all feature flags on:

| Section | Count | Items |
|---|---|---|
| (primary, no subheader) | 7 | Photos, Memories, Explore, Map, Circles, Albums, Notifications |
| `LIBRARY` | 3 | People, Archive, Trash |
| `UTILITIES` | 6 | Review Bursts, Review Duplicates, Review Insights, Location Suggestions, Workflows, AI Enhancements |
| `ADMINISTRATION` | 5 | Settings, Job Queue, Worker Nodes, Storage Insights, Public Sharing |
| (pinned bottom) | 1 | User Settings |

The disease is that the drawer accumulated **one row per shipped feature**, so it mirrors the
API surface rather than any user's mental model. Trimming rows individually only delays the
next time it bloats; the next feature has no principled reason to be excluded and no room to
be included.

### 1.2 Eleven rows duplicate chrome that is already on screen

| Drawer row | Already reachable from | Source |
|---|---|---|
| Notifications | the bell in the AppBar, carrying the same badge | `AppBar.tsx` → `NotificationBell` |
| Circles | UserMenu — circle switcher **and** "Manage Circles" | `UserMenu.tsx:117-141` |
| User Settings | UserMenu → Settings | `UserMenu.tsx:153` |
| Job Queue | the `/admin/settings` hub | `SettingsHubPage.tsx` |
| Worker Nodes | ditto | ditto |
| Storage Insights | ditto | ditto |
| Public Sharing | ditto | ditto |
| Photos, Explore, Map, Albums | BottomNav — visible on the same screen, on mobile | `BottomNav.tsx:55-58` |

The four admin shortcuts are the clearest case: they are an **arbitrary sample of a 25-page
hub**, hoisted into global navigation.

### 1.3 The structural problem underneath

MemoriaHub is self-hosted, so **the same person is both the family photo browser and the
system operator**. Those are two jobs with two cadences — daily versus monthly — competing
for the same 240 px. Every commercial photo app avoids this by not having an operator at
all. The fix is to separate the modes, not to keep re-ranking rows inside one list.

---

## 2. Research basis

Four findings shaped the target design. They are recorded here because they are the reason
for choices that would otherwise look arbitrary.

### 2.1 Google Photos consolidated to three tabs

The year-long redesign collapsed navigation to **Photos, Collections, Search**. People &
pets, Places, Albums, Documents and Moments all moved *into* Collections; Create and the
Updates bell moved to the top bar. The extra tap was accepted explicitly, in exchange for
organized groupings over a flat list. Notably, the redesign also **removed the Memories
tab** — memories surface inside the Photos tab instead.
([9to5google, Mar 2025](https://9to5google.com/2025/03/23/year-long-google-photos-redesign/))

### 2.2 Material 3 deprecated the navigation drawer

In the Material 3 Expressive update the navigation drawer is deprecated, replaced by the
**expanded navigation rail** — mostly the same functionality, adapting far better across
window size classes. A rail is always visible; a drawer costs a tap before navigation can
begin. Google acknowledges an open gap: there is no officially recommended drawer
replacement for phone-sized windows, which is why the phone treatment here is bottom-bar-only.
([m3.material.io](https://m3.material.io/components/navigation-rail/guidelines) ·
[9to5google, May 2025](https://9to5google.com/2025/05/14/material-3-expressive-navigation/))

### 2.3 Apple iOS 18 Photos is the documented failure mode

iOS 18 removed the tab bar entirely for a single scrolling page. Backlash was immediate —
"Albums particularly difficult to reach" — and Apple partially rolled back in 18.1/18.2,
adding **Customize & Reorder**. The lesson: consolidation works, deleting stable
destinations does not, and user pinning should be designed in from the start rather than
added after complaints.
([MacRumors, Nov 2024](https://www.macrumors.com/2024/11/21/apples-photos-app-overhaul-controversial/))

### 2.4 Bottom navigation: three to five destinations

Bottom tab navigation is the settled mobile standard, with 3–5 destinations the consistent
recommendation. Four is the ceiling that still leaves each label readable at 360 px — the
narrowest viewport this app already accounts for (see
[`docs/audits/mobile-topbar-audit.md`](../audits/mobile-topbar-audit.md)).

### 2.5 The through-line

Every serious photo app consolidated into a **small set of stable destinations plus one rich
hub**; the one that instead removed destinations entirely had to reverse course. This design
sits deliberately on the Google side of that line, with Apple's correction (pinning) built
in up front.

---

## 3. Target information architecture

### 3.1 Four destinations

Every user action is one of four verbs:

| Destination | Route | Verb | Contents |
|---|---|---|---|
| **Photos** | `/` | *look* | The timeline, with the Memories carousel on top (already rendered there today) |
| **Collections** | `/collections` | *browse* | Albums, People, Places, Memories, Map, Favorites, Archive, Trash |
| **Search** | `/search` | *find* | Text, semantic, and agentic search |
| **Review** | `/review` | *decide* | Bursts, Duplicates, Locations, Enhancements, Insights, Automations |

**Review is the destination worth defending.** Unlike every app surveyed in §2, MemoriaHub
*generates work for its user*: bursts to resolve, duplicates to merge, locations to confirm,
enhancements to approve, workflow runs to authorize. That is a genuine product
differentiator that currently costs six quiet drawer rows which read as furniture. One
badged inbox reads as work, and matches the actual rhythm — these queues are empty most of
the time and full immediately after an import.

### 3.2 Two modes

**Library mode** (default) carries the four destinations above.

**Console mode** is entered at any `/admin/*` route. The navigation chrome swaps its
contents rather than the app shell, plus a persistent **← Back to library** affordance at
the top so the mode is always obviously escapable. The circle chip stays; the search pill is
hidden.

The items it swaps to are **not new information architecture** — `SettingsHubPage` already
groups all 23 admin pages into five sections (General, AI & Enrichment, Media, Storage,
Operations), each card carrying its own permission gate. Console mode promotes that existing
structure from a *page* into *navigation*, which is what removes the current cost of every
admin-to-admin move routing back through a landing page. Console reuses the hub's groups,
labels, and gates verbatim.

**On a phone this mode does not exist** — there is no rail to swap, so the admin surface is
a drill-down hierarchy instead. See §4.4.

This is the cheapest structural change in the proposal — a conditional on
`location.pathname.startsWith('/admin')` inside one component — and it permanently removes
five rows while giving the admin surface room to grow past 25 pages without ever touching
global navigation again.

### 3.3 Complete destination mapping

Nothing is deleted. All 22 rows land somewhere specific:

| Today | New home | Rationale |
|---|---|---|
| Photos | **Photos** | Unchanged — the daily destination |
| Memories | **Photos** carousel + **Collections › Memories** | The feed already renders on Home via `GET /api/memories/feed`; Google removed its Memories tab for the same reason (§2.1) |
| Explore | **Search** | It routes to `/search` — name it what it is (see §3.4) |
| Map | **Collections › Places › Map** | A browse mode over places, not a peer of the timeline |
| Circles | **Top-bar circle chip** | The app's most important state, currently two taps deep in the avatar menu |
| Albums | **Collections › Albums** | The canonical curated container |
| Notifications | **Bell → "See all notifications"** | The bell is always visible and already badged |
| People | **Collections › People** | A collection of faces |
| Archive | **Collections**, bottom group | Where every peer app puts it |
| Trash | **Collections**, bottom group | ditto |
| Review Bursts | **Review › Bursts** | One inbox, one aggregate badge |
| Review Duplicates | **Review › Duplicates** | ditto |
| Location Suggestions | **Review › Locations** | ditto |
| AI Enhancements | **Review › Enhancements** | ditto |
| Review Insights | **Review › Insights** | Analytics *about* the queues, not a queue |
| Workflows | **Review › Automations** | "Make the reviewing happen without me" |
| Settings | **Console** | Separate mode, own cadence |
| Job Queue | **Console › Jobs** | ditto |
| Worker Nodes | **Console › Nodes** | ditto |
| Storage Insights | **Console › Storage** | ditto |
| Public Sharing | **Console › Sharing** | ditto |
| User Settings | **Avatar menu** | Already there |

### 3.4 Naming corrections

Two collisions are fixed as part of this work:

- **"Explore" currently routes to `/search`**, while a *separate* explore-style hub lives at
  `/places` (`PlacesOverviewPage`). Two different things called explore. Resolution:
  `/search` is named **Search**; `/places` becomes **Places** inside Collections.
- **"Review Insights"** sits among four review *queues* but is an analytics page. It becomes
  a tab inside Review rather than a sibling of the queues.

---

## 4. Per-breakpoint layouts

The four destinations **never change between breakpoints**. What changes is the chrome that
carries them, and what each screen does with the space it saves.

Breakpoints use the MUI theme values already in the codebase (`xs 0 / sm 600 / md 900 /
lg 1200`), which align closely with Material 3's compact / medium / expanded window classes.

### 4.1 Phone — `< md` (bottom bar, **no drawer**)

```
┌──────────────────────────────────┐
│ ▣  Familia ▾        ⬆  🔔•   ◯  │  top bar: logo, circle chip,
├──────────────────────────────────┤  upload, bell, avatar
│ MEMORIES                         │  NO hamburger, NO search field
│ ▭▭▭  ▭▭▭  ▭▭▭                    │
│ SAT 8 AUG                        │
│ ▪ ▪ ▪                            │
│ ▪ ▪ ▪                            │
│ ▪ ▪ ▪                            │
├──────────────────────────────────┤
│  ▦       ◈        ⌕       ✓•     │  4-item bottom bar
│ Photos Collections Search Review │
└──────────────────────────────────┘
```

- **The drawer is deleted outright.** No hamburger. The screen in the original bug report
  stops existing.
- **Search becomes a tab**, which pulls the search field *out* of the top bar. Per
  [`docs/audits/mobile-topbar-audit.md`](../audits/mobile-topbar-audit.md) that toolbar
  already measures ~354 px against 360 px of viewport with the search pill present; removing
  it resolves that crowding permanently rather than tuning gaps again.
- **The circle chip replaces the wordmark.** On a phone, which circle you are in matters more
  than the app's name.
- Review carries a dot indicator rather than a numeric badge at this size.

### 4.2 Tablet — `md` to `lg` (collapsed rail)

```
┌──────────────────────────────────────────────┐
│ ▣ Familia ▾ [ ⌕ Search your photos ] ⬆ 🔔• ◯ │
├────┬─────────────────────────────────────────┤
│ ▦  │ MEMORIES                                │
│Phot│ ▭▭▭  ▭▭▭  ▭▭▭  ▭▭▭                      │
│ ◈  │ SAT 8 AUG                               │
│Coll│ ▪ ▪ ▪ ▪                                 │
│ ✓• │ ▪ ▪ ▪ ▪                                 │
│Revw│ ▪ ▪ ▪ ▪                                 │
│    │                                         │
│ ⚙  │                                         │
│Cons│                                         │
└────┴─────────────────────────────────────────┘
   ↑ 52px, always visible
```

- **Collapsed navigation rail instead of a temporary drawer** — Material 3's own replacement
  (§2.2). Always visible, so navigating costs **zero taps instead of one**.
- **~52 px of chrome instead of 240.** On a 768 px screen that is roughly one additional
  column of photos.
- **Search returns to the top bar** where there is width for it, and gives up its rail slot.
  This is the one place the destination set differs by form factor, and it is deliberate:
  the destination still exists, it is simply carried by different chrome.
- Console sits pinned at the rail's foot, visually separated.

### 4.3 Desktop — `≥ lg` (expanded rail + context pane)

```
┌────────────────────────────────────────────────────────────────┐
│ ▣ Familia ▾ [ ⌕ Search your photos, people, places… ] ⬆ 🔔• ◯ │
├────────────┬──────────────┬────────────────────────────────────┤
│ ▦ Photos   │ COLLECTIONS  │ ALBUMS · 24                        │
│ ◈ Collect… │ ▪ Albums  24 │ ▪ ▪ ▪ ▪ ▪ ▪                        │
│ ✓ Review 12│ ▪ People  61 │ ▪ ▪ ▪ ▪ ▪ ▪                        │
│ ─────────  │ ▪ Places  38 │ ▪ ▪ ▪ ▪ ▪ ▪                        │
│ PINNED     │ ▪ Memories17 │ ▪ ▪ ▪ ▪ ▪ ▪                        │
│ ◈ People   │ ▪ Map        │ ▪ ▪ ▪ ▪ ▪ ▪                        │
│            │ ──────────   │                                    │
│            │ ▪ Favorites  │                                    │
│            │ ▪ Archive    │                                    │
│ ⚙ Console  │ ▪ Trash      │                                    │
└────────────┴──────────────┴────────────────────────────────────┘
   ↑ 220px       ↑ 240px context pane (only for Collections/Review)
```

- **Expanded rail + context pane.** The second column shows what is *inside* the selected
  destination, so depth costs a glance rather than a tap. This is what recovers the extra tap
  that §6.1 concedes.
- The context pane renders **only for Collections and Review**. Photos and Search are
  single-surface destinations and render at full width.
- **Pinning lives here** (§5). A user who works in People daily pins it into the rail.
- The rail **collapses to the tablet treatment on demand** and remembers the choice.

### 4.4 Console mode on a phone — a drill-down, not a mode

Console mode (§3.2) is defined as "the rail swaps its contents." On a phone there is no
rail, so there is nothing to swap. **The resolution is that Console mode does not exist on
a phone at all: the admin surface is a drill-down hierarchy, and `SettingsHubPage` is the
navigation.**

```
  Hub  (/admin/settings)              Detail  (/admin/settings/jobs)
┌──────────────────────────────┐    ┌──────────────────────────────┐
│ ←  Settings              ◯   │    │ ←  Job Queue             ◯   │
├──────────────────────────────┤    ├──────────────────────────────┤
│ ⌕ Search settings            │    │                              │
│                              │    │  <JobsPage renders here>     │
│ GENERAL                      │    │                              │
│  ▸ System                    │    │                              │
│  ▸ Users & Allowlist         │    │                              │
│  ▸ Archiving & Deletion      │    │                              │
│  ▸ Email                     │    │                              │
│ AI & ENRICHMENT              │    │                              │
│  ▸ AI Providers              │    │                              │
│  ▸ Tagging & Descriptions    │    │                              │
│  …                           │    │                              │
├──────────────────────────────┤    ├──────────────────────────────┤
│  ▦    ◈     ⌕     ✓•         │    │  ▦    ◈     ⌕     ✓•         │
│Photos Coll Search Review     │    │Photos Coll Search Review     │
└──────────────────────────────┘    └──────────────────────────────┘
       ↑ bottom bar stays LIBRARY nav in both — always one tap out
```

**Why not a scrollable tab strip** (the first proposal, rejected):

- Tabs are for **parallel** content; drill-down is for **hierarchical** content. Console is
  23 pages inside 5 groups — a hierarchy.
- 23 destinations in a horizontal strip is the documented anti-pattern: excess tabs force
  horizontal scrolling that reduces discoverability, and shifting tab rows destroy the
  spatial memory users rely on to remember where they have been
  ([NN/g, *Tabs, Used Right*](https://www.nngroup.com/articles/tabs-used-right/)).
- Apple's tab-bar ceiling on iPhone is 3–5 items.
- iOS Settings — the reference mobile settings experience — is a drill-down, so every phone
  user already holds the model.

**Four requirements make this excellent rather than merely correct:**

1. **Scroll position MUST be restored when returning to the hub.** This is the single
   make-or-break detail. SPAs break it by default — `history.pushState` does not restore
   position, and asynchronously rendered content means the browser does not know the page
   height at restore time. Without it, returning from a page near the bottom of a 23-card
   list dumps the user at the top to re-find their place, which is what makes drill-down
   feel bad. With it, the pattern feels native.
2. **The bottom bar stays Library navigation on every admin screen.** This is what keeps
   the admin surface from being a trap: the user is always one tap from Photos. It is also
   why no "← Back to library" affordance is needed on phone, unlike the rail treatments.
3. **A back affordance in the top bar that agrees with the OS.** It navigates up one level
   (detail → hub) and must never diverge from the browser/system back gesture.
4. **A "Search settings" filter at the top of the hub.** A client-side filter over the
   `sections` array `SettingsHubPage` already declares, matching on card title. Twenty-three
   items across five groups is past the point where scanning beats typing — the same reason
   iOS Settings has a search field. It also benefits desktop, and it is the only approach
   that **scales**: at 40 admin pages a rail or tab strip degrades, while search stays
   constant-effort for the user.

**Top bar in the admin drill-down on phone:** back arrow + page title + avatar. The circle
chip and upload button are dropped — nearly every admin page is global rather than
circle-scoped, and the space is better spent on the title.

**No new route, no new component, no change to any admin page.** The hierarchy already
exists in `SettingsHubPage`'s five sections; this treatment simply stops hiding it behind a
landing page the user must return to manually.

---

## 5. Persistence — `user_settings.navigation`

A new optional namespace in the existing `user_settings` JSONB. **No migration, no new
endpoint, no new table, no new permission** — read and written through the existing
`GET`/`PATCH`/`PUT /api/user-settings`, exactly like the `dataTables` namespace (issue #255)
and the `notifications` namespace (issue #251).

```ts
navigation: {
  pinned?: string[];        // ≤ 6 entries, each a known destination key
  railCollapsed?: boolean;  // desktop rail collapse preference
}
```

**Every field is optional with no `.default()`.** Absent means "use the built-in defaults" —
nothing pinned, rail expanded. This mirrors the explicit warning already documented for
`dataTables` and `notifications` in `CLAUDE.md`: adding a `.default()` anywhere in this
namespace inverts the absent-means-default rule and pins stored blobs to a snapshot of
today's defaults.

**PATCH merges field-wise** (`UserSettingsService.mergeNavigation`, shaped like the existing
`mergeNotifications`): an unlisted field is untouched, a listed one is replaced wholesale,
a field set to `null` is deleted, and `navigation: null` clears the namespace.

`pinned` entries are validated against the known destination-key enum, and **unknown keys
are dropped on read rather than rejected** — a pin referencing a destination removed in a
later release must degrade to "not pinned", never to a 500 on every settings read.

> **Three hand-maintained copies.** Per the pitfall documented in `CLAUDE.md`, this namespace
> must be added to **all three** of `systemSettingsSchema`'s user-settings equivalents:
> `userSettingsSchema` and its patch twin in
> `apps/api/src/common/schemas/settings.schema.ts`, **and** the wire DTO in
> `apps/api/src/settings/dto/`. A namespace present only in the first two validates
> perfectly in unit tests while every real PATCH silently no-ops, because `nestjs-zod`
> strips unknown keys.

---

## 6. Trade-offs and rejected alternatives

### 6.1 People, Map and Albums each cost one more tap — accepted

Real and unavoidable; it is the same trade Google made deliberately (§2.1). It is only worth
it if **Collections is visually rich enough to be a destination in its own right**: cover
thumbnails, live counts, recently-viewed first. **If Collections ships as a text list, this
proposal makes the app worse.** Desktop pinning and the context pane (§4.3) recover the cost
entirely for power users.

### 6.2 Queues become less visible — mitigated by existing machinery

Three mitigations already exist: the aggregate badge on Review, the hourly `review_queue_*`
notifications written by `NotificationReconcileTask`, and the Home review banners. The
current design arguably *under*-signals: six quiet rows read as furniture, one badge reads
as work.

### 6.3 Rejected — hiding Review when its count is zero

Tempting and wrong. Navigation that changes shape is worse than navigation that is slightly
long: users cannot find a feature they know exists, and cannot build muscle memory against a
moving target. **Keep the destination, drop the badge.**

### 6.4 Rejected — a collapsible `UTILITIES` section, collapsed by default

Cheaper than the Review hub, but it hides the problem rather than fixing the IA. The six rows
still exist, still mirror the feature list, and the next review queue still adds a seventh.

### 6.5 Rejected — removing destinations entirely (the iOS 18 model)

§2.3. Documented to fail, and reversed by its own author.

---

## 7. Accessibility requirements

Non-negotiable, and part of each issue's acceptance criteria:

- The rail is a `<nav>` with an accessible name; the active destination carries
  `aria-current="page"`.
- Every rail item exposes its label to assistive technology **even when collapsed**, where
  the visible label is truncated or hidden.
- Badges are not the sole carrier of meaning: the accessible name includes the count
  ("Review, 12 items pending").
- Focus order follows visual order across top bar → rail → context pane → main.
- Keyboard focus has a visible state on every navigation control.
- The rail collapse toggle is a real `<button>` with `aria-expanded`.
- `prefers-reduced-motion` suppresses the rail expand/collapse transition.

---

## 8. Phasing

Each phase stands alone and is independently revertible. Phase 1 removes eight rows without
adding a single page.

Tracked by epic [#388](https://github.com/marinoscar/MemoriaHub/issues/388).

| Phase | Issue | Delivers | Rows |
|---|---|---|---|
| 1 | [#389](https://github.com/marinoscar/MemoriaHub/issues/389) | Console mode, duplicate removal, top-bar circle chip — no new routes, no new API | 22 → 14 |
| 2 | [#390](https://github.com/marinoscar/MemoriaHub/issues/390) | The Review hub — one new route wrapping existing pages | 14 → 9 |
| 3 | [#391](https://github.com/marinoscar/MemoriaHub/issues/391) | The Collections hub — one new route; the riskiest phase (§6.1) | 9 → 4 |
| 4 | [#392](https://github.com/marinoscar/MemoriaHub/issues/392) | Rail, bottom bar, pinning — replaces the drawer; adds `user_settings.navigation` | chrome |

**If scope must shrink:** Phase 1 alone is a clean win. Phases 1 + 2 + 4 deliver the full
three-breakpoint chrome and skip the risky hub. Phase 3 is the only one that can make the
app *worse* if executed poorly — see the bar it must clear in §6.1.

---

## 9. Testing requirements

Per phase, at minimum:

- **Unit (RTL):** the navigation component renders the expected destination set at each
  breakpoint (`useMediaQuery` mocked); permission- and feature-flag-gated entries appear and
  disappear correctly; `aria-current` tracks the active route.
- **Regression:** every removed drawer row's destination is still reachable by its existing
  route. This is the single most important test in the epic — the design's central claim is
  that nothing becomes unreachable.
- **Settings (Phase 4):** `navigation` namespace round-trips through PATCH/PUT; an unlisted
  field is untouched; `null` clears; an over-cap `pinned` array is a 400, not a 500; an
  unknown pinned key degrades to "not pinned".
- **Typecheck** (`npm run typecheck`) and existing `Sidebar.test.tsx` updated rather than
  deleted.
