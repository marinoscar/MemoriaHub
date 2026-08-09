/**
 * Component tests — MemoriesSettings (epic #300, issue #313).
 *
 * The PATCH payloads ARE the contract here. `user_settings.memories` is stored
 * sparsely and absent means "no preference", so a component that writes a
 * materialized namespace would pin every user to today's defaults forever and
 * nothing would visibly break until a default changed. Every assertion below is
 * therefore about the exact object sent to the API — one key, and `null` (a
 * JSON Merge Patch delete) rather than `[]` / `false` when a preference is
 * cleared.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser } from '../../utils/test-utils';
import type { UserSettings } from '../../../types';

vi.mock('../../../hooks/useFeatureFlags', () => ({
  useFeatureFlags: vi.fn(),
}));

vi.mock('../../../services/face', () => ({
  listPeople: vi.fn(),
  getPerson: vi.fn(),
  createPerson: vi.fn(),
  updatePerson: vi.fn(),
  assignFaces: vi.fn(),
  unassignFace: vi.fn(),
  clusterUnknownFaces: vi.fn(),
  bulkHidePeople: vi.fn(),
  bulkUnhidePeople: vi.fn(),
  purgePeople: vi.fn(),
}));

import { MemoriesSettings } from '../../../components/settings/MemoriesSettings';
import { useFeatureFlags } from '../../../hooks/useFeatureFlags';
import { listPeople } from '../../../services/face';

const mockFlags = vi.mocked(useFeatureFlags);
const mockListPeople = vi.mocked(listPeople);

function setFlags(memories: boolean | null, isLoading = false) {
  mockFlags.mockReturnValue({
    features: memories === null ? null : { memories },
    pictureEnhancement: null,
    isLoading,
    error: null,
    refresh: vi.fn(),
  });
}

function makeSettings(memories?: UserSettings['memories']): UserSettings {
  return {
    theme: 'system',
    profile: { useProviderImage: true },
    memories,
    updatedAt: '2026-08-01T00:00:00.000Z',
    version: 3,
  };
}

function renderSection(
  settings: UserSettings,
  updateSettings = vi.fn().mockResolvedValue(undefined),
) {
  const result = render(
    <MemoriesSettings settings={settings} updateSettings={updateSettings} />,
    { wrapperOptions: { authenticated: true, user: mockUser } },
  );
  return { ...result, updateSettings };
}

beforeEach(() => {
  vi.clearAllMocks();
  setFlags(true);
  mockListPeople.mockResolvedValue({
    items: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Abuela',
        isUnlabeled: false,
        faceCount: 42,
        coverFace: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        favorite: false,
      },
    ],
    meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
  });
});

// ---------------------------------------------------------------------------

describe('MemoriesSettings — feature gating', () => {
  it('renders nothing and loads no people when the flag is off', async () => {
    setFlags(false);
    renderSection(makeSettings());

    expect(screen.queryByText('Memories')).not.toBeInTheDocument();
    // Not merely unrendered — the request must never be made.
    await waitFor(() => expect(mockListPeople).not.toHaveBeenCalled());
  });

  it('stays hidden while the flags are still resolving', () => {
    setFlags(null, true);
    renderSection(makeSettings());
    expect(screen.queryByText('Memories')).not.toBeInTheDocument();
  });
});

describe('MemoriesSettings — email digest toggle', () => {
  it('is ON when the preference is absent', () => {
    renderSection(makeSettings());
    expect(screen.getByLabelText('Email me memory digests')).toBeChecked();
  });

  it('is OFF only when the user explicitly opted out', () => {
    renderSection(makeSettings({ emailDigestOptOut: true }));
    expect(screen.getByLabelText('Email me memory digests')).not.toBeChecked();
  });

  it('opting out writes the single key', async () => {
    const user = userEvent.setup();
    const { updateSettings } = renderSection(makeSettings());

    await user.click(screen.getByLabelText('Email me memory digests'));

    expect(updateSettings).toHaveBeenCalledWith({
      memories: { emailDigestOptOut: true },
    });
  });

  it('re-subscribing DELETES the key rather than writing false', async () => {
    const user = userEvent.setup();
    const { updateSettings } = renderSection(makeSettings({ emailDigestOptOut: true }));

    await user.click(screen.getByLabelText('Email me memory digests'));

    // `null` = JSON Merge Patch delete: the user returns to the default instead
    // of being pinned to an explicit `false` that would survive a default change.
    expect(updateSettings).toHaveBeenCalledWith({
      memories: { emailDigestOptOut: null },
    });
  });
});

describe('MemoriesSettings — hidden people', () => {
  it('shows a stored person as a selected chip once people load', async () => {
    renderSection(makeSettings({ hiddenPersonIds: ['11111111-1111-4111-8111-111111111111'] }));
    expect(await screen.findByText('Abuela')).toBeInTheDocument();
  });

  it('keeps an id it cannot resolve instead of silently un-hiding that person', async () => {
    // A preference set in another circle, or a person since deleted or merged.
    renderSection(makeSettings({ hiddenPersonIds: ['99999999-9999-4999-8999-999999999999'] }));
    expect(await screen.findByText('99999999')).toBeInTheDocument();
  });

  it('clearing the last hidden person deletes the key', async () => {
    const user = userEvent.setup();
    const { updateSettings } = renderSection(
      makeSettings({ hiddenPersonIds: ['99999999-9999-4999-8999-999999999999'] }),
    );

    const chip = await screen.findByText('99999999');
    const remove = chip.parentElement?.querySelector(
      '[data-testid="CancelIcon"]',
    ) as HTMLElement;
    await user.click(remove);

    expect(updateSettings).toHaveBeenCalledWith({ memories: { hiddenPersonIds: null } });
  });
});

describe('MemoriesSettings — hidden date ranges', () => {
  it('commits a complete range explicitly, not on every keystroke', async () => {
    const user = userEvent.setup();
    const { updateSettings } = renderSection(makeSettings());

    await user.click(screen.getByRole('button', { name: /add date range/i }));

    const from = screen.getByLabelText('From') as HTMLInputElement;
    const to = screen.getByLabelText('To') as HTMLInputElement;

    // A half-typed range must never be PATCHed — the API would reject it.
    await user.type(from, '2021-06-01');
    expect(updateSettings).not.toHaveBeenCalled();

    await user.type(to, '2021-06-30');
    expect(updateSettings).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /save dates/i }));
    expect(updateSettings).toHaveBeenCalledWith({
      memories: { hiddenDateRanges: [{ from: '2021-06-01', to: '2021-06-30' }] },
    });
  });

  it('refuses to save a range whose start is after its end', async () => {
    const user = userEvent.setup();
    const { updateSettings } = renderSection(makeSettings());

    await user.click(screen.getByRole('button', { name: /add date range/i }));
    await user.type(screen.getByLabelText('From'), '2021-06-30');
    await user.type(screen.getByLabelText('To'), '2021-06-01');

    expect(
      screen.getByText('The start date must not be after the end date.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save dates/i })).toBeDisabled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('removing the last stored range deletes the key', async () => {
    const user = userEvent.setup();
    const { updateSettings } = renderSection(
      makeSettings({ hiddenDateRanges: [{ from: '2021-06-01', to: '2021-06-30' }] }),
    );

    await user.click(screen.getByRole('button', { name: /remove date range 1/i }));
    await user.click(screen.getByRole('button', { name: /save dates/i }));

    expect(updateSettings).toHaveBeenCalledWith({ memories: { hiddenDateRanges: null } });
  });

  it('seeds the editor from the stored ranges', () => {
    renderSection(
      makeSettings({ hiddenDateRanges: [{ from: '2021-06-01', to: '2021-06-30' }] }),
    );
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2021-06-01');
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('2021-06-30');
  });
});
