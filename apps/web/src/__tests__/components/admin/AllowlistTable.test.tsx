import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import { AllowlistTable } from '../../../components/admin/AllowlistTable';

// Mock the hooks
vi.mock('../../../hooks/useAllowlist', () => ({
  useAllowlist: vi.fn(),
}));

import { useAllowlist } from '../../../hooks/useAllowlist';

const mockUseAllowlist = vi.mocked(useAllowlist);

describe('AllowlistTable', () => {
  const mockFetchAllowlist = vi.fn();
  const mockAddEmail = vi.fn();
  const mockRemoveEmail = vi.fn();

  const mockPendingEntry = {
    id: 'entry-1',
    email: 'pending@example.com',
    notes: 'Test note',
    addedById: 'admin-id',
    addedAt: '2024-01-15T10:00:00Z',
    claimedById: null,
    claimedAt: null,
    addedBy: {
      id: 'admin-id',
      email: 'admin@example.com',
    },
    claimedBy: null,
  };

  const mockClaimedEntry = {
    id: 'entry-2',
    email: 'claimed@example.com',
    notes: null,
    addedById: 'admin-id',
    addedAt: '2024-01-15T10:00:00Z',
    claimedById: 'user-id',
    claimedAt: '2024-01-16T10:00:00Z',
    addedBy: {
      id: 'admin-id',
      email: 'admin@example.com',
    },
    claimedBy: {
      id: 'user-id',
      email: 'user@example.com',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementation
    mockUseAllowlist.mockReturnValue({
      entries: [],
      total: 0,
      isLoading: false,
      error: null,
      fetchAllowlist: mockFetchAllowlist,
      addEmail: mockAddEmail.mockResolvedValue(undefined),
      removeEmail: mockRemoveEmail.mockResolvedValue(undefined),
    });
  });

  describe('Rendering', () => {
    it('should render table with entries', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockPendingEntry, mockClaimedEntry],
        total: 2,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('pending@example.com')).toBeInTheDocument();
        expect(screen.getByText('claimed@example.com')).toBeInTheDocument();
      });
    });

    it('should show loading spinner while loading', () => {
      mockUseAllowlist.mockReturnValue({
        entries: [],
        total: 0,
        isLoading: true,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('should show error alert when error exists', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [],
        total: 0,
        isLoading: false,
        error: 'Failed to load allowlist',
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Failed to load allowlist')).toBeInTheDocument();
      });
    });

    it('should show empty state when no entries', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [],
        total: 0,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('No emails in allowlist')).toBeInTheDocument();
      });
    });

    it('should show search empty state when no results', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [],
        total: 0,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      const user = userEvent.setup();

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      // Type in search box
      const searchInput = screen.getByLabelText(/search by email/i);
      await user.type(searchInput, 'nonexistent');

      await waitFor(() => {
        expect(
          screen.getByText('No emails found matching your search'),
        ).toBeInTheDocument();
      });
    });
  });

  describe('Status Display', () => {
    it('should show "Pending" status for unclaimed entries', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockPendingEntry],
        total: 1,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Pending')).toBeInTheDocument();
      });
    });

    it('should show "Claimed" status for claimed entries', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockClaimedEntry],
        total: 1,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Claimed')).toBeInTheDocument();
      });
    });
  });

  describe('Remove Button', () => {
    it('should disable remove button for claimed entries', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockClaimedEntry],
        total: 1,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('claimed@example.com')).toBeInTheDocument();
      });

      // Find delete button (it should be disabled)
      const deleteButtons = screen.getAllByRole('button', { name: '' });
      const deleteButton = deleteButtons.find((btn) => btn.disabled);
      expect(deleteButton).toBeDefined();
    });

    it('should enable remove button for pending entries', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockPendingEntry],
        total: 1,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('pending@example.com')).toBeInTheDocument();
      });

      // Delete button should be enabled
      const deleteButtons = screen.getAllByRole('button', { name: '' });
      const enabledDeleteButton = deleteButtons.find(
        (btn) => !btn.disabled && btn.querySelector('svg'),
      );
      expect(enabledDeleteButton).toBeDefined();
    });

    it('should call removeEmail when remove button clicked and confirmed', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockPendingEntry],
        total: 1,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      // Mock window.confirm
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      const user = userEvent.setup();

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('pending@example.com')).toBeInTheDocument();
      });

      // Click delete button
      const deleteButtons = screen.getAllByRole('button', { name: '' });
      const deleteButton = deleteButtons.find(
        (btn) => !btn.disabled && btn.querySelector('svg'),
      );
      await user.click(deleteButton!);

      expect(confirmSpy).toHaveBeenCalled();
      expect(mockRemoveEmail).toHaveBeenCalledWith(mockPendingEntry.id);

      confirmSpy.mockRestore();
    });

    it('should not call removeEmail when remove cancelled', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockPendingEntry],
        total: 1,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      // Mock window.confirm to return false (cancelled)
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      const user = userEvent.setup();

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('pending@example.com')).toBeInTheDocument();
      });

      // Click delete button
      const deleteButtons = screen.getAllByRole('button', { name: '' });
      const deleteButton = deleteButtons.find(
        (btn) => !btn.disabled && btn.querySelector('svg'),
      );
      await user.click(deleteButton!);

      expect(confirmSpy).toHaveBeenCalled();
      expect(mockRemoveEmail).not.toHaveBeenCalled();

      confirmSpy.mockRestore();
    });
  });

  describe('Search Functionality', () => {
    it('should have search input field', () => {
      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(screen.getByLabelText(/search by email/i)).toBeInTheDocument();
    });

    it('should call fetchAllowlist with search parameter', async () => {
      const user = userEvent.setup();

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const searchInput = screen.getByLabelText(/search by email/i);
      await user.type(searchInput, 'test@example.com');

      await waitFor(() => {
        expect(mockFetchAllowlist).toHaveBeenCalledWith(
          expect.objectContaining({
            search: 'test@example.com',
            page: 1,
          }),
        );
      });
    });

    it('should reset to first page when searching', async () => {
      const user = userEvent.setup();

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const searchInput = screen.getByLabelText(/search by email/i);
      await user.type(searchInput, 'search');

      await waitFor(() => {
        expect(mockFetchAllowlist).toHaveBeenCalledWith(
          expect.objectContaining({
            page: 1,
          }),
        );
      });
    });
  });

  describe('Add Email Button', () => {
    it('should have "Add Email" button', () => {
      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      expect(
        screen.getByRole('button', { name: /add email/i }),
      ).toBeInTheDocument();
    });

    it('should open dialog when "Add Email" button clicked', async () => {
      const user = userEvent.setup();

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      const addButton = screen.getByRole('button', { name: /add email/i });
      await user.click(addButton);

      await waitFor(() => {
        expect(
          screen.getByRole('dialog', { name: /add email to allowlist/i }),
        ).toBeInTheDocument();
      });
    });
  });

  describe('Pagination', () => {
    it('should display pagination controls', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockPendingEntry, mockClaimedEntry],
        total: 25,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/1–10 of 25/i)).toBeInTheDocument();
      });
    });

    it('should call fetchAllowlist when page changes', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: Array.from({ length: 10 }, (_, i) => ({
          ...mockPendingEntry,
          id: `entry-${i}`,
          email: `user${i}@example.com`,
        })),
        total: 25,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      const user = userEvent.setup();

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByLabelText(/next page/i)).toBeInTheDocument();
      });

      const nextButton = screen.getByLabelText(/next page/i);
      await user.click(nextButton);

      await waitFor(() => {
        expect(mockFetchAllowlist).toHaveBeenCalledWith(
          expect.objectContaining({
            page: 2,
          }),
        );
      });
    });

    it('should have pagination with rows per page selector', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockPendingEntry],
        total: 100,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText(/rows per page/i)).toBeInTheDocument();
      });

      // Pagination controls should be present
      expect(screen.getByText(/1–10 of 100/i)).toBeInTheDocument();
    });
  });

  describe('Data Display', () => {
    it('should display email addresses', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockPendingEntry],
        total: 1,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('pending@example.com')).toBeInTheDocument();
      });
    });

    it('should display added by information', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockPendingEntry],
        total: 1,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('admin@example.com')).toBeInTheDocument();
      });
    });

    it('should display notes when present', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockPendingEntry],
        total: 1,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        expect(screen.getByText('Test note')).toBeInTheDocument();
      });
    });

    it('should display dash when no notes', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockClaimedEntry],
        total: 1,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        const cells = screen.getAllByRole('cell');
        expect(cells.some((cell) => cell.textContent === '-')).toBe(true);
      });
    });

    it('should format dates', async () => {
      mockUseAllowlist.mockReturnValue({
        entries: [mockPendingEntry],
        total: 1,
        isLoading: false,
        error: null,
        fetchAllowlist: mockFetchAllowlist,
        addEmail: mockAddEmail,
        removeEmail: mockRemoveEmail,
      });

      render(<AllowlistTable />, {
        wrapperOptions: { user: mockAdminUser },
      });

      await waitFor(() => {
        // Date should be formatted (actual format depends on locale)
        const cells = screen.getAllByRole('cell');
        const dateCell = Array.from(cells).find((cell) =>
          cell.textContent?.includes('2024') || cell.textContent?.includes('/'),
        );
        expect(dateCell).toBeDefined();
      });
    });
  });
});
