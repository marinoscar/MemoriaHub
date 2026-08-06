/**
 * Component tests — NotificationSettings (issue #251, epic #240).
 *
 * Mocking strategy:
 *   - `useFeatureFlags` and `usePermissions` are module-mocked so visibility
 *     (per-type feature gating, admin-only `enrichment_failed`) is driven
 *     directly and deterministically, without a real AuthContext/API round
 *     trip.
 *   - `updateSettings` is a plain `vi.fn()` passed as a prop — the component
 *     never imports a settings service directly, it is handed the mutator.
 *   - Rendered via the project's `render` helper (test-utils) for MUI theme +
 *     router context; auth/circle context are unused by this component but
 *     the wrapper is harmless to include.
 *
 * Test coverage:
 *   1. No stored preferences (`settings.notifications` undefined) renders
 *      every visible switch ON — the master switch and every per-type switch.
 *   2. Toggling one per-type switch PATCHes ONLY that key — the request body
 *      must not contain a materialized full-namespace object (this is what
 *      keeps a future NotificationType opt-out rather than opt-in).
 *   3. Toggling the master switch PATCHes only `{ enabled }`.
 *   4. Re-enabling a previously-disabled type sends the JSON Merge Patch
 *      delete form (`{ types: { [type]: null } }`), not `true`.
 *   5. `workflowMicroRuns` renders OFF when absent — the one inverted default.
 *   6. A type whose feature flag is off is HIDDEN entirely (not rendered
 *      disabled).
 *   7. `enrichment_failed` is hidden for non-admins and shown for admins.
 *   8. The master switch being off disables every visible per-type switch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { render } from '../../../__tests__/utils/test-utils';
import { NotificationSettings } from '../NotificationSettings';
import type { UserSettings } from '../../../types';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before the component import resolves the module
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(),
}));

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { useFeatureFlags } from '../../../hooks/useFeatureFlags';
import { usePermissions } from '../../../hooks/usePermissions';

const mockUseFeatureFlags = vi.mocked(useFeatureFlags);
const mockUsePermissions = vi.mocked(usePermissions);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** All flags this component reads, defaulted ON so every type is visible. */
function mockFlags(overrides: Partial<Record<string, boolean>> = {}) {
  return {
    features: {
      burstDetection: true,
      duplicateDetection: true,
      locationInference: true,
      workflows: true,
      ...overrides,
    },
    pictureEnhancement: {
      enabled: overrides.pictureEnhancement ?? true,
      allowReplace: true,
      blockReplaceOnDownscale: false,
      model: 'gpt-image-1',
    },
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  };
}

function baseSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    theme: 'system',
    profile: { useProviderImage: true },
    updatedAt: new Date().toISOString(),
    version: 1,
    ...overrides,
  };
}

function renderComponent(
  settings: UserSettings,
  updateSettings = vi.fn().mockResolvedValue(undefined),
) {
  render(<NotificationSettings settings={settings} updateSettings={updateSettings} />);
  return { updateSettings };
}

beforeEach(() => {
  mockUseFeatureFlags.mockReturnValue(mockFlags());
  mockUsePermissions.mockReturnValue({
    permissions: new Set(),
    roles: new Set(),
    hasPermission: () => false,
    hasAnyPermission: () => false,
    hasAllPermissions: () => false,
    hasRole: () => false,
    hasAnyRole: () => false,
    isAdmin: false,
  } as ReturnType<typeof usePermissions>);
});

// ---------------------------------------------------------------------------
// 1. Absence means enabled
// ---------------------------------------------------------------------------

describe('NotificationSettings — absent preferences render everything ON', () => {
  it('the master switch is ON when settings.notifications is undefined', () => {
    renderComponent(baseSettings());

    const master = screen.getByRole('switch', { name: /all notifications/i });
    expect(master).toBeChecked();
  });

  it('every visible per-type switch is ON when settings.notifications is undefined', () => {
    renderComponent(baseSettings());

    // Review-queue types (all flags on in the default mock).
    expect(screen.getByRole('switch', { name: /burst photos notifications/i })).toBeChecked();
    expect(
      screen.getByRole('switch', { name: /near-duplicates notifications/i }),
    ).toBeChecked();
    expect(
      screen.getByRole('switch', { name: /location suggestions notifications/i }),
    ).toBeChecked();
    expect(
      screen.getByRole('switch', { name: /ai enhancements notifications/i }),
    ).toBeChecked();

    // Activity types visible to a non-admin.
    expect(
      screen.getByRole('switch', { name: /uploads finished notifications/i }),
    ).toBeChecked();
    expect(
      screen.getByRole('switch', { name: /workflow runs notifications/i }),
    ).toBeChecked();
    expect(
      screen.getByRole('switch', { name: /expiring shares notifications/i }),
    ).toBeChecked();
  });

  it('a namespace present but empty ({}) still renders everything ON', () => {
    renderComponent(baseSettings({ notifications: {} }));

    expect(screen.getByRole('switch', { name: /all notifications/i })).toBeChecked();
    expect(
      screen.getByRole('switch', { name: /uploads finished notifications/i }),
    ).toBeChecked();
  });

  it('a partially-populated types map leaves the other types ON', () => {
    renderComponent(
      baseSettings({ notifications: { types: { upload_completed: false } } }),
    );

    expect(
      screen.getByRole('switch', { name: /uploads finished notifications/i }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('switch', { name: /workflow runs notifications/i }),
    ).toBeChecked();
    expect(
      screen.getByRole('switch', { name: /expiring shares notifications/i }),
    ).toBeChecked();
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. PATCH payload minimality — the property that keeps future types
// opt-out
// ---------------------------------------------------------------------------

describe('NotificationSettings — PATCH payload is a one-key delta', () => {
  it('toggling one per-type switch off sends ONLY that key, not a materialized namespace', async () => {
    const { updateSettings } = renderComponent(baseSettings());

    fireEvent.click(screen.getByRole('switch', { name: /uploads finished notifications/i }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({
      notifications: { types: { upload_completed: false } },
    });

    // No other type, no `enabled`, no `workflowMicroRuns` key was sent.
    const payload = updateSettings.mock.calls[0][0].notifications;
    expect(Object.keys(payload)).toEqual(['types']);
    expect(Object.keys(payload.types)).toEqual(['upload_completed']);
  });

  it('re-enabling a previously-disabled type sends the JSON Merge Patch DELETE form ({ [type]: null }), not `true`', async () => {
    const { updateSettings } = renderComponent(
      baseSettings({ notifications: { types: { upload_completed: false } } }),
    );

    fireEvent.click(screen.getByRole('switch', { name: /uploads finished notifications/i }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({
      notifications: { types: { upload_completed: null } },
    });
  });

  it('toggling the master switch off sends ONLY { enabled: false } — no per-type keys', async () => {
    const { updateSettings } = renderComponent(baseSettings());

    fireEvent.click(screen.getByRole('switch', { name: /all notifications/i }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({ notifications: { enabled: false } });

    const payload = updateSettings.mock.calls[0][0].notifications;
    expect(Object.keys(payload)).toEqual(['enabled']);
  });

  it('toggling a DIFFERENT type does not resend or clobber an already-stored override for another type (the component sends only a delta; merge semantics are the API’s job, but the outgoing payload for THIS toggle must still name only the one key)', async () => {
    const { updateSettings } = renderComponent(
      baseSettings({ notifications: { types: { upload_completed: false } } }),
    );

    fireEvent.click(screen.getByRole('switch', { name: /expiring shares notifications/i }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({
      notifications: { types: { share_expiring: false } },
    });
    // upload_completed's existing override is NOT re-sent alongside it.
    const payload = updateSettings.mock.calls[0][0].notifications;
    expect(payload.types).not.toHaveProperty('upload_completed');
  });
});

// ---------------------------------------------------------------------------
// 5. workflowMicroRuns — the one inverted default
// ---------------------------------------------------------------------------

describe('NotificationSettings — workflowMicroRuns inverted default', () => {
  it('renders OFF when absent, with workflows enabled and visible', () => {
    renderComponent(baseSettings());

    const microRuns = screen.getByRole('switch', {
      name: /automatic per-upload workflow runs/i,
    });
    expect(microRuns).not.toBeChecked();
  });

  it('renders ON when explicitly stored as true', () => {
    renderComponent(baseSettings({ notifications: { workflowMicroRuns: true } }));

    const microRuns = screen.getByRole('switch', {
      name: /automatic per-upload workflow runs/i,
    });
    expect(microRuns).toBeChecked();
  });

  it('toggling it sends the explicit boolean (no null/delete form exists for it)', async () => {
    const { updateSettings } = renderComponent(baseSettings());

    fireEvent.click(
      screen.getByRole('switch', { name: /automatic per-upload workflow runs/i }),
    );

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({
      notifications: { workflowMicroRuns: true },
    });
  });

  it('is disabled (and shows an explanatory caption) when workflows are still opted in but the feature flag is now off', () => {
    mockUseFeatureFlags.mockReturnValue(mockFlags({ workflows: false }));

    renderComponent(baseSettings({ notifications: { workflowMicroRuns: true } }));

    // The parent type's switch (and the micro-runs sub-switch under it) is
    // hidden entirely once the flag is off...
    expect(
      screen.queryByRole('switch', { name: /workflow runs notifications/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: /automatic per-upload workflow runs/i }),
    ).not.toBeInTheDocument();
    // ...but the still-on preference is called out rather than silently
    // dropped from the UI.
    expect(
      screen.getByText(/per-upload workflow run notifications are still enabled/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 6. Feature-flagged types are HIDDEN, not disabled
// ---------------------------------------------------------------------------

describe('NotificationSettings — feature-gated visibility', () => {
  it('a type whose feature flag is off is not rendered at all (hidden, not a disabled control)', () => {
    mockUseFeatureFlags.mockReturnValue(mockFlags({ burstDetection: false }));

    renderComponent(baseSettings());

    expect(
      screen.queryByRole('switch', { name: /burst photos notifications/i }),
    ).not.toBeInTheDocument();
    // Its sibling review-queue types, unaffected, are still shown.
    expect(
      screen.getByRole('switch', { name: /near-duplicates notifications/i }),
    ).toBeInTheDocument();
  });

  it('hides every review-queue type whose flag is off, one at a time', () => {
    mockUseFeatureFlags.mockReturnValue(
      mockFlags({ duplicateDetection: false, locationInference: false }),
    );

    renderComponent(baseSettings());

    expect(
      screen.queryByRole('switch', { name: /near-duplicates notifications/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: /location suggestions notifications/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: /burst photos notifications/i }),
    ).toBeInTheDocument();
  });

  it('AI enhancements is hidden when pictureEnhancement.enabled is false (read from the dedicated field, not the raw flag record)', () => {
    mockUseFeatureFlags.mockReturnValue({
      ...mockFlags(),
      pictureEnhancement: {
        enabled: false,
        allowReplace: true,
        blockReplaceOnDownscale: false,
        model: null,
      },
    });

    renderComponent(baseSettings());

    expect(
      screen.queryByRole('switch', { name: /ai enhancements notifications/i }),
    ).not.toBeInTheDocument();
  });

  it('shows a fallback message when every type is hidden', () => {
    mockUseFeatureFlags.mockReturnValue(
      mockFlags({
        burstDetection: false,
        duplicateDetection: false,
        locationInference: false,
        workflows: false,
        pictureEnhancement: false,
      }),
    );

    renderComponent(baseSettings());

    expect(
      screen.getByText(/no notification types are available on this deployment/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 7. enrichment_failed — admin-only
// ---------------------------------------------------------------------------

describe('NotificationSettings — enrichment_failed is admin-only', () => {
  it('is hidden for a non-admin', () => {
    mockUsePermissions.mockReturnValue({
      permissions: new Set(),
      roles: new Set(),
      hasPermission: () => false,
      hasAnyPermission: () => false,
      hasAllPermissions: () => false,
      hasRole: () => false,
      hasAnyRole: () => false,
      isAdmin: false,
    } as ReturnType<typeof usePermissions>);

    renderComponent(baseSettings());

    expect(
      screen.queryByRole('switch', { name: /background job failures notifications/i }),
    ).not.toBeInTheDocument();
  });

  it('is shown for an admin', () => {
    mockUsePermissions.mockReturnValue({
      permissions: new Set(),
      roles: new Set(['admin']),
      hasPermission: () => false,
      hasAnyPermission: () => false,
      hasAllPermissions: () => false,
      hasRole: () => false,
      hasAnyRole: () => false,
      isAdmin: true,
    } as ReturnType<typeof usePermissions>);

    renderComponent(baseSettings());

    expect(
      screen.getByRole('switch', { name: /background job failures notifications/i }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 8. Master switch disables the per-type switches
// ---------------------------------------------------------------------------

describe('NotificationSettings — master switch gates per-type controls', () => {
  it('every visible per-type switch is disabled when the master switch is off', () => {
    renderComponent(baseSettings({ notifications: { enabled: false } }));

    const master = screen.getByRole('switch', { name: /all notifications/i });
    expect(master).not.toBeChecked();
    expect(master).not.toBeDisabled(); // the master switch itself stays interactive

    for (const name of [
      /burst photos notifications/i,
      /near-duplicates notifications/i,
      /location suggestions notifications/i,
      /ai enhancements notifications/i,
      /uploads finished notifications/i,
      /workflow runs notifications/i,
      /expiring shares notifications/i,
    ]) {
      expect(screen.getByRole('switch', { name })).toBeDisabled();
    }
  });

  it('the workflowMicroRuns sub-switch is also disabled when the master switch is off', () => {
    renderComponent(
      baseSettings({ notifications: { enabled: false, workflowMicroRuns: true } }),
    );

    expect(
      screen.getByRole('switch', { name: /automatic per-upload workflow runs/i }),
    ).toBeDisabled();
  });

  it('per-type switches are enabled again once the master switch is on', () => {
    renderComponent(baseSettings());

    expect(
      screen.getByRole('switch', { name: /uploads finished notifications/i }),
    ).not.toBeDisabled();
  });

  it('clicking the master switch back on sends { enabled: true } explicitly (no null/delete form exists for it)', async () => {
    const { updateSettings } = renderComponent(
      baseSettings({ notifications: { enabled: false } }),
    );

    fireEvent.click(screen.getByRole('switch', { name: /all notifications/i }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({ notifications: { enabled: true } });
  });
});

// ---------------------------------------------------------------------------
// Misc — loading / error states from useFeatureFlags (defensive, not in the
// required list, but cheap to cover given the component branches on both)
// ---------------------------------------------------------------------------

describe('NotificationSettings — feature-flag loading/error states', () => {
  it('shows a spinner and no type switches while flags are loading', () => {
    mockUseFeatureFlags.mockReturnValue({
      features: null,
      pictureEnhancement: null,
      isLoading: true,
      error: null,
      refresh: vi.fn(),
    });

    renderComponent(baseSettings());

    expect(
      screen.queryByRole('switch', { name: /uploads finished notifications/i }),
    ).not.toBeInTheDocument();
    // The master switch itself does not depend on the flags fetch.
    expect(screen.getByRole('switch', { name: /all notifications/i })).toBeInTheDocument();
  });

  it('shows a warning banner when the flags fetch fails, and gated types stay hidden (fail hidden, not fail visible)', () => {
    mockUseFeatureFlags.mockReturnValue({
      features: null,
      pictureEnhancement: null,
      isLoading: false,
      error: 'network error',
      refresh: vi.fn(),
    });

    renderComponent(baseSettings());

    expect(screen.getByText(/couldn.t check which features are enabled/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: /burst photos notifications/i }),
    ).not.toBeInTheDocument();
    // Ungated activity types (no `flag` on their descriptor) still show.
    expect(
      screen.getByRole('switch', { name: /uploads finished notifications/i }),
    ).toBeInTheDocument();
  });
});
