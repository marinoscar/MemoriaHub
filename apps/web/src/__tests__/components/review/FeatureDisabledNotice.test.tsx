/**
 * Tests for FeatureDisabledNotice (issue #404).
 *
 * Two things are pinned here:
 *
 *  1. THE COMPONENT'S OWN CONTRACT — given `hasExistingWork` and the caller's
 *     admin status, does it show the right copy and the right settings link.
 *     `FeatureDisabledNotice` carries NO flag-reading logic of its own; it is
 *     a dumb banner every page mounts conditionally.
 *
 *  2. THE GATE EVERY PAGE APPLIES before mounting it —
 *     `features !== null && features.<flag> !== true` — via a small local
 *     harness that reproduces the exact expression documented in the
 *     component's own header comment (and duplicated identically at each of
 *     the three call sites). `DuplicatesPage.test.tsx` / `BurstsPage.test.tsx`
 *     / `LocationSuggestionsPage.test.tsx` each separately pin this same gate
 *     against their real page; this harness pins the EXPRESSION ITSELF, once,
 *     isolated from three pages' worth of unrelated setup — a "helpful"
 *     simplification to `features?.<flag> === false` (which would start
 *     claiming a feature is disabled during a flags OUTAGE, since an outage
 *     resolves `features` to `null` rather than throwing) fails here even if
 *     a page-specific case is ever weakened or skipped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import { FeatureDisabledNotice } from '../../../components/review/FeatureDisabledNotice';
import { useFeatureFlags } from '../../../hooks/useFeatureFlags';

vi.mock('../../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(),
}));

const mockUseFeatureFlags = vi.mocked(useFeatureFlags);

function mockFlags(features: Record<string, boolean> | null, isLoading = false) {
  mockUseFeatureFlags.mockReturnValue({
    features,
    pictureEnhancement: null,
    isLoading,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });
}

/**
 * Reproduces the exact gate `DuplicatesPage` (and its two siblings) applies:
 *   const featureDisabled = features !== null && features.duplicateDetection !== true;
 *   {featureDisabled && <FeatureDisabledNotice ... />}
 */
function GatedNotice({ flag }: { flag: string }) {
  const { features } = useFeatureFlags();
  const disabled = features !== null && features[flag] !== true;
  return disabled ? (
    <FeatureDisabledNotice
      featureLabel="Duplicate detection"
      settingsPath="/admin/settings/duplicates"
      hasExistingWork={false}
    />
  ) : null;
}

describe('FeatureDisabledNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // The page gate: features !== null && features.<flag> !== true
  // =========================================================================

  describe('the page gate', () => {
    it('renders when the flag has loaded and is explicitly false', () => {
      mockFlags({ duplicateDetection: false });

      render(<GatedNotice flag="duplicateDetection" />);

      expect(screen.getByText(/duplicate detection is turned off/i)).toBeInTheDocument();
    });

    it('renders when the flag has loaded but the key is simply absent', () => {
      // The real shape a never-configured flag takes: `features` resolved to
      // an object, but that object has no entry for this flag at all.
      mockFlags({});

      render(<GatedNotice flag="duplicateDetection" />);

      expect(screen.getByText(/duplicate detection is turned off/i)).toBeInTheDocument();
    });

    it('does NOT render when the flag has loaded and is true', () => {
      mockFlags({ duplicateDetection: true });

      render(<GatedNotice flag="duplicateDetection" />);

      expect(screen.queryByText(/is turned off/i)).not.toBeInTheDocument();
    });

    it('does NOT render while flags are still loading (features is null, isLoading true)', () => {
      mockFlags(null, true);

      render(<GatedNotice flag="duplicateDetection" />);

      expect(screen.queryByText(/is turned off/i)).not.toBeInTheDocument();
    });

    it('does NOT render on a flags OUTAGE — features resolves to null, never treated as "everything is disabled"', () => {
      // The deliberate departure from the `=== true` convention, documented
      // in FeatureDisabledNotice.tsx: a failed GET /api/features must HIDE
      // the banner, not claim the feature is off. That claim would be a lie
      // the user has no way to distinguish from a real admin-configured
      // toggle, and it is the one most likely to be "corrected" later into
      // `features?.duplicateDetection === false`, which gets this exact case
      // wrong.
      mockFlags(null, false);

      render(<GatedNotice flag="duplicateDetection" />);

      expect(screen.queryByText(/is turned off/i)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Copy varies on hasExistingWork
  // =========================================================================

  describe('copy', () => {
    it('tells the user their existing items are still reviewable when hasExistingWork is true', () => {
      render(
        <FeatureDisabledNotice
          featureLabel="Duplicate detection"
          settingsPath="/admin/settings/duplicates"
          hasExistingWork
        />,
      );

      expect(
        screen.getByText(/items found earlier are listed below and can still be reviewed/i),
      ).toBeInTheDocument();
      expect(screen.queryByText(/no new items will appear here/i)).not.toBeInTheDocument();
    });

    it('tells the user nothing new will ever appear when hasExistingWork is false', () => {
      render(
        <FeatureDisabledNotice
          featureLabel="Duplicate detection"
          settingsPath="/admin/settings/duplicates"
          hasExistingWork={false}
        />,
      );

      expect(screen.getByText(/no new items will appear here/i)).toBeInTheDocument();
      expect(screen.queryByText(/still be reviewed/i)).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Settings link — admin only
  // =========================================================================

  describe('settings link', () => {
    it('renders for an admin, pointed at the caller-supplied settingsPath', () => {
      render(
        <FeatureDisabledNotice
          featureLabel="Duplicate detection"
          settingsPath="/admin/settings/duplicates"
          hasExistingWork={false}
        />,
        { wrapperOptions: { user: mockAdminUser } },
      );

      const link = screen.getByRole('link', { name: /open settings/i });
      expect(link).toHaveAttribute('href', '/admin/settings/duplicates');
      expect(screen.getByText(/turn it back on in the feature settings/i)).toBeInTheDocument();
    });

    it('does not render for a non-admin, and points them at an administrator instead', () => {
      render(
        <FeatureDisabledNotice
          featureLabel="Duplicate detection"
          settingsPath="/admin/settings/duplicates"
          hasExistingWork={false}
        />,
        { wrapperOptions: { user: mockUser } },
      );

      expect(screen.queryByRole('link', { name: /open settings/i })).not.toBeInTheDocument();
      expect(screen.getByText(/an administrator can turn it back on/i)).toBeInTheDocument();
    });
  });
});
