/**
 * Component tests — DataTable color contrast, computed against the REAL
 * theme (issue #257).
 *
 * `axe-core`'s `color-contrast` rule is disabled in the conformance suite's
 * axe pass (`conformance/runDataTableConformanceSuite.tsx` documents why:
 * jsdom performs no real layout/paint, so the rule cannot resolve an
 * element's true effective background and is a well-known false-negative
 * trap there). This file is the real substitute: a pure WCAG 2.1
 * relative-luminance / contrast-ratio calculator
 * (`testUtils/contrast.ts`) run directly against the actual
 * `lightTheme` / `darkTheme` palette values the app ships
 * (`../../../theme/light.ts`, `dark.ts`) for the specific foreground/
 * background pairs THIS component paints — not a generic "is the theme
 * accessible" audit.
 */

import { describe, it, expect } from 'vitest';
import { lightPalette } from '../../../theme/light';
import { darkPalette } from '../../../theme/dark';
import {
  contrastRatio,
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_NORMAL_TEXT,
  WCAG_AA_UI_COMPONENT,
} from './testUtils/contrast';

// Component-authored colors that are not part of the theme palette but ARE
// painted by DataTable — the selected-row tint (`DesktopGridRenderer.tsx`'s
// `.MuiDataGrid-row.Mui-selected` equivalent styling, `DataCard.tsx`'s
// selected background) and the bulk-action-bar tint (`BulkActionBar.tsx`).
const SELECTED_ROW_TINT_LIGHT = 'rgba(25, 118, 210, 0.06)';
const SELECTED_ROW_TINT_DARK = 'rgba(144, 202, 249, 0.10)';

describe('DataTable — WCAG contrast (computed against the real theme)', () => {
  describe('body text on the card / paper surface', () => {
    it('light theme: text.primary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(lightPalette.text!.primary!, lightPalette.background!.paper!);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    it('light theme: text.secondary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(lightPalette.text!.secondary!, lightPalette.background!.paper!);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    it('dark theme: text.primary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(darkPalette.text!.primary!, darkPalette.background!.paper!);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    it('dark theme: text.secondary on background.paper meets AA normal text (4.5:1)', () => {
      const ratio = contrastRatio(darkPalette.text!.secondary!, darkPalette.background!.paper!);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  describe('body text over the SELECTED-row tint (translucent, composited)', () => {
    // The tint is painted over `background.paper` (the Card / DataGrid row's
    // own surface); text.primary is what sits on top of it in both
    // `DataCard.tsx` and the grid's selected-row styling. A translucent tint
    // is the one case a naive two-color contrast check gets wrong — the
    // ACTUAL rendered background is the tint alpha-composited over paper, not
    // the tint's own (mostly-transparent) color read in isolation.
    it('light theme: text.primary over the selected-row tint (composited over paper) meets AA', () => {
      const ratio = contrastRatio(
        lightPalette.text!.primary!,
        SELECTED_ROW_TINT_LIGHT,
        lightPalette.background!.paper!,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });

    it('dark theme: text.primary over the selected-row tint (composited over paper) meets AA', () => {
      const ratio = contrastRatio(
        darkPalette.text!.primary!,
        SELECTED_ROW_TINT_DARK,
        darkPalette.background!.paper!,
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  describe('primary-colored UI elements (chips, links, focus/selection accents)', () => {
    // `primary.main` is what `DataCard.tsx`'s "More details" control, the
    // filter chips (`variant="outlined" color="primary"`), and the selected
    // row's border all use. WCAG 1.4.11 (non-text contrast) sets the floor at
    // 3:1 against its background, not the stricter 4.5:1 for body text.
    it('light theme: primary.main on background.paper meets the UI-component floor (3:1)', () => {
      const ratio = contrastRatio(lightPalette.primary!.main!, lightPalette.background!.paper!);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });

    it('dark theme: primary.main on background.paper meets the UI-component floor (3:1)', () => {
      const ratio = contrastRatio(darkPalette.primary!.main!, darkPalette.background!.paper!);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });

    // The "More details" / "Fewer details" toggle and filter-chip labels are
    // `body2`-sized text COLORED with `primary.main`, not just a border or
    // icon — held to the stricter large-text-or-better floor as a matter of
    // this suite's own discipline, even though WCAG's text rule technically
    // only requires 4.5:1 for genuinely small text.
    it('light theme: primary.main text on background.paper clears the large-text floor (3:1)', () => {
      const ratio = contrastRatio(lightPalette.primary!.main!, lightPalette.background!.paper!);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
    });

    it('dark theme: primary.main text on background.paper clears the large-text floor (3:1)', () => {
      const ratio = contrastRatio(darkPalette.primary!.main!, darkPalette.background!.paper!);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT);
    });
  });

  describe('error (destructive) palette', () => {
    // Destructive row/bulk actions (`destructive: true`) paint in
    // `theme.palette.error.main`. Neither `light.ts` nor `dark.ts` overrides
    // `error`, so this pins MUI's OWN default — if a future palette change
    // ever adds a custom override, this test starts exercising it for free.
    it('light theme: the default error.main on background.paper meets the UI-component floor', async () => {
      const { lightTheme } = await import('../../../theme');
      const ratio = contrastRatio(lightTheme.palette.error.main, lightPalette.background!.paper!);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });

    it('dark theme: the default error.main on background.paper meets the UI-component floor', async () => {
      const { darkTheme } = await import('../../../theme');
      const ratio = contrastRatio(darkTheme.palette.error.main, darkPalette.background!.paper!);
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_UI_COMPONENT);
    });
  });
});
