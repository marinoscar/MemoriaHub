import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { render, mockAdminUser, mockUser } from '../utils/test-utils.js';
import { createFakeAdminPort } from '../../src/core/testing/index.js';
import type { MediaShare } from '../../src/shares/headless/types.js';

const hook = vi.fn();
vi.mock('../../src/shares/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMediaShares: (...args: unknown[]) => hook(...args),
}));
vi.mock('../../src/core/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMemoriahubAdmin: () => createFakeAdminPort().port,
}));

import PublicSharesPage from '../../src/shares/ui/pages/PublicSharesPage.js';
import { buildShareColumns, statusFromFilters, toShareQuery, withStatusFilter } from '../../src/shares/ui/sharesTable.js';

const share = (overrides: Partial<MediaShare> = {}): MediaShare => ({
  id: 'abcdef12-0000-0000-0000-000000000001',
  publicUrl: 'https://app.example.test/s#lnk_token-one-two-three-four-five',
  targetType: 'album',
  status: 'active',
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-01-15T10:00:00.000Z',
  itemCount: 4,
  preview: { thumbnailUrl: null },
  ...overrides,
});

const result = (shares: MediaShare[]) => ({
  shares,
  meta: { page: 1, pageSize: 20, totalItems: shares.length, totalPages: 1 },
  isLoading: false,
  error: null,
  refetch: vi.fn().mockResolvedValue(undefined),
  updateShare: vi.fn().mockResolvedValue(undefined),
  revokeShare: vi.fn().mockResolvedValue(undefined),
  bulkAction: vi.fn().mockResolvedValue({ affected: 1 }),
});

describe('PublicSharesPage through the fake admin port', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hook.mockReturnValue(result([share()]));
  });

  it('renders the header, the status tabs and the row with a truncated link', () => {
    render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });
    expect(screen.getByRole('heading', { name: /public sharing/i })).toBeInTheDocument();
    for (const name of ['All', 'Active', 'Expired', 'Revoked']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('abcdef12')).toBeInTheDocument();
    expect(screen.queryByText(/token-one-two-three-four-five/)).not.toBeInTheDocument();
  });

  it('does not render for a non-admin', () => {
    render(<PublicSharesPage />, { wrapperOptions: { user: mockUser } });
    expect(screen.queryByText(/public sharing/i)).not.toBeInTheDocument();
  });

  it('asks the hook for the tab chosen, as a filter-model write', async () => {
    render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });
    fireEvent.click(screen.getByRole('tab', { name: 'Revoked' }));
    await waitFor(() => expect(hook).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'revoked', page: 1 })));
  });

  it('offers the bulk actions once a row is selected', () => {
    render(<PublicSharesPage />, { wrapperOptions: { user: mockAdminUser } });
    fireEvent.click(screen.getByLabelText(/Select abcdef12/));
    const bar = within(screen.getByRole('toolbar', { name: 'Bulk actions' }));
    expect(bar.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(bar.getByRole('button', { name: 'Set expiration' })).toBeInTheDocument();
  });
});

describe('sharesTable declarations', () => {
  it('keeps the credential column out of the export and the status column out of the generic filter picker', () => {
    const columns = buildShareColumns({ onCopy: vi.fn() });
    expect(columns.find((c) => c.id === 'publicUrl')?.exportable).toBe(false);
    expect(columns.find((c) => c.id === 'status')?.filterable).toBeUndefined();
    expect(columns.find((c) => c.id === 'targetType')?.filterable).toEqual(['is']);
  });

  it('round-trips the status tab through the filter model and the query', () => {
    const model = withStatusFilter([], 'expired');
    expect(statusFromFilters(model)).toBe('expired');
    expect(toShareQuery(model)).toEqual({ status: 'expired' });
    expect(withStatusFilter(model, 'all')).toEqual([]);
  });
});
