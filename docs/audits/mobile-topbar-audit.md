# Mobile Top Bar — Audit and Fix Record

| Field | Value |
|-------|-------|
| **Date** | 2026-07-14 |
| **Issue** | [#95 — "\[Feature]: Improve mobile view top bar"](https://github.com/marinoscar/MemoriaHub/issues/95) |
| **Status** | Implemented |

---

This document records the mobile top bar layout issue reported in GitHub issue #95, its root cause, the fix applied, and the follow-ups explicitly deferred out of scope. It is written as a permanent reference so future contributors understand why `TopbarSearch` is shaped the way it is on phone-width viewports.

---

## Table of Contents

1. [Symptom](#1-symptom)
2. [Root Cause](#2-root-cause)
3. [Fix Applied](#3-fix-applied)
4. [Deferred Follow-Ups](#4-deferred-follow-ups)

---

## 1. Symptom

GitHub issue #95, "[Feature]: Improve mobile view top bar," reported that on mobile/phone-width viewports the top bar didn't render well and wasn't using the full width ("real estate") of the screen. A screenshot attached to the issue showed the AppBar's icons visibly clustered on one side (the left edge) with a large unused gap of empty space on the right.

---

## 2. Root Cause

**File:** `apps/web/src/components/search/TopbarSearch.tsx`

The phone branch of `TopbarSearch` (`isPhone`, driven by `theme.breakpoints.down('sm')`, i.e. <600px) rendered the collapsed search state as a bare `IconButton` with no flex sizing applied to it or its container.

The desktop/tablet branch of the same component already handles this correctly: its search pill is wrapped in a `Box` with `sx={{ flexGrow: 1, ... }}`. As a flex child of the AppBar's `Toolbar` (`apps/web/src/components/navigation/AppBar.tsx`), that `flexGrow: 1` box absorbs all of the Toolbar's remaining horizontal space and pushes the trailing icon cluster (upload, theme toggle, avatar) to the right edge.

On phone, nothing claimed that space. The hamburger, logo, search icon, upload icon, theme toggle, and avatar all packed against the Toolbar's left edge with only the default 8px inter-item gaps between them, leaving the entire right side of the bar empty — exactly what the issue's screenshot showed.

Only the *collapsed* phone state was affected. The expanded phone search overlay is `position: absolute` and already spans the full Toolbar width regardless of flex sizing, so it was never part of the reported symptom.

---

## 3. Fix Applied

The collapsed-phone `IconButton` in `TopbarSearch.tsx` was wrapped in a `Box sx={{ flexGrow: 1, display: 'flex', justifyContent: 'flex-end' }}`, mirroring the existing desktop pattern so the phone branch claims the Toolbar's remaining space the same way the desktop/tablet branch does.

This was a minimal, single-component fix. No changes were needed in `AppBar.tsx`, `Layout.tsx`, `BottomNav.tsx`, `index.html`, or any theme files.

A regression test was added to `apps/web/src/components/search/__tests__/TopbarSearch.test.tsx` asserting that the button's wrapper carries `flexGrow: 1` (checked via `getComputedStyle`, since the test environment's `ThemeContextProvider` + `CssBaseline` inject real emotion stylesheets that jsdom can match against), plus a structural check confirming a distinct wrapping element exists around the button.

---

## 4. Deferred Follow-Ups

The following were identified during this fix but explicitly scoped out by product decision, to keep the change narrowly targeted at the reported "full real estate" complaint:

- **Small touch targets.** The search pill's icon buttons (search/clear/tune) use `size="small"` with `p: 0.75`/`p: 0.5` padding (roughly 30px), below the ~44px recommended minimum touch target size. This is most relevant in the phone-expanded search overlay, where interaction is touch-only.
- **Missing safe-area-inset handling.** `apps/web/index.html`'s viewport meta tag lacks `viewport-fit=cover`, and neither the sticky AppBar nor the fixed-position `BottomNav` (`apps/web/src/components/navigation/BottomNav.tsx`) pad for `env(safe-area-inset-top)` / `env(safe-area-inset-bottom)`. On notched or home-indicator phones, these bars can sit flush against system chrome.

Recommend tracking these as separate follow-up issues if pursued later.
