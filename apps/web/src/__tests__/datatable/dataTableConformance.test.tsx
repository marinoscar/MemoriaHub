/**
 * The platform DataTable conformance suite (`@marinoscar/platform-web/datatable/testing`),
 * replacing the app copy's `components/datatable/__tests__/DataTableConformance.test.tsx`
 * now that every MemoriaHub table renders through the platform component
 * (RETRO-F1, #571). It runs the suite's own fixture under MemoriaHub's REAL
 * light and dark themes, so the contrast and both-theme accessibility passes
 * check the app's palettes rather than MUI's defaults.
 *
 * Why not against the Job Queue and Public Sharing contracts, as #571 asks:
 * no MemoriaHub table declares a `sortable` column (sorting is not offered by
 * any of their list endpoints), and the suite's sort, resize and #243-guard
 * cases require one; its contract-default visibility case also counts the Job
 * Queue's `filterOnly` "Processed within" column as a header. Both are suite
 * assumptions, reported as a seam gap (RETRO-F1 report); the per-page tests
 * (`JobsPage.test.tsx`, `PublicSharesPage.test.tsx`) cover those tables.
 */
import { runDataTableConformanceSuite } from '@marinoscar/platform-web/datatable/testing';
import { darkTheme, lightTheme } from '../../theme';

runDataTableConformanceSuite({
  label: 'DataTable (MemoriaHub themes)',
  themes: { light: lightTheme, dark: darkTheme },
});
