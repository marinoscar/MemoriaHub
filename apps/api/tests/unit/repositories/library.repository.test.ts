/**
 * Library Repository Tests
 *
 * Unit tests for the library repository.
 * Tests library CRUD, member management, and access control queries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LibraryVisibility, LibraryMemberRole } from '@memoriahub/shared';

// Mock the database client
const mockQuery = vi.fn();
vi.mock('../../../src/infrastructure/database/client.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Mock logger
vi.mock('../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock request context
vi.mock('../../../src/infrastructure/logging/request-context.js', () => ({
  getTraceId: () => 'trace-123',
}));

import { LibraryRepository } from '../../../src/infrastructure/database/repositories/library.repository.js';

describe('LibraryRepository', () => {
  let repository: LibraryRepository;

  function createMockLibraryRow(overrides?: Partial<{
    id: string;
    owner_id: string;
    name: string;
    description: string | null;
    visibility: LibraryVisibility;
    cover_asset_id: string | null;
    created_at: Date;
    updated_at: Date;
    owner_email?: string;
    owner_display_name?: string;
    asset_count?: string;
  }>) {
    return {
      id: 'library-123',
      owner_id: 'user-456',
      name: 'Test Library',
      description: 'A test library',
      visibility: 'private' as LibraryVisibility,
      cover_asset_id: null,
      created_at: new Date('2024-01-01T00:00:00Z'),
      updated_at: new Date('2024-01-01T00:00:00Z'),
      ...overrides,
    };
  }

  function createMockMemberRow(overrides?: Partial<{
    id: string;
    library_id: string;
    user_id: string;
    role: LibraryMemberRole;
    invited_by: string | null;
    created_at: Date;
    user_email: string;
    user_display_name: string | null;
    user_avatar_url: string | null;
  }>) {
    return {
      id: 'member-123',
      library_id: 'library-123',
      user_id: 'user-789',
      role: 'viewer' as LibraryMemberRole,
      invited_by: 'user-456',
      created_at: new Date('2024-01-01T00:00:00Z'),
      user_email: 'member@example.com',
      user_display_name: 'Member User',
      user_avatar_url: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    repository = new LibraryRepository();
  });

  describe('findById', () => {
    it('returns library when found', async () => {
      const mockRow = createMockLibraryRow();
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.findById('library-123');

      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM libraries WHERE id = $1',
        ['library-123']
      );
      expect(result).toEqual(expect.objectContaining({
        id: 'library-123',
        ownerId: 'user-456',
        name: 'Test Library',
        visibility: 'private',
      }));
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByIdWithStats', () => {
    it('returns library with owner info and asset count using library_assets table', async () => {
      const mockRow = createMockLibraryRow({
        owner_email: 'owner@example.com',
        owner_display_name: 'Owner User',
        asset_count: '10',
      });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.findByIdWithStats('library-123');

      // Verify it joins with library_assets (not media_assets)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('LEFT JOIN library_assets la ON la.library_id = l.id'),
        ['library-123']
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('COUNT(la.id)'),
        ['library-123']
      );
      expect(result).toEqual(expect.objectContaining({
        id: 'library-123',
        ownerEmail: 'owner@example.com',
        ownerName: 'Owner User',
        assetCount: 10,
      }));
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.findByIdWithStats('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByOwnerId', () => {
    it('returns libraries with asset counts using library_assets table', async () => {
      const mockRow = createMockLibraryRow({
        owner_email: 'owner@example.com',
        owner_display_name: 'Owner User',
        asset_count: '5',
      });
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.findByOwnerId('user-456');

      // Verify it joins with library_assets (not media_assets)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('LEFT JOIN library_assets la ON la.library_id = l.id'),
        expect.any(Array)
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('COUNT(la.id)'),
        expect.any(Array)
      );
      expect(result.libraries).toHaveLength(1);
      expect(result.libraries[0].assetCount).toBe(5);
    });

    it('applies visibility filter', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.findByOwnerId('user-456', { visibility: 'shared' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('l.visibility = $2'),
        expect.arrayContaining(['user-456', 'shared'])
      );
    });

    it('applies pagination', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '50' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.findByOwnerId('user-456', { page: 2, limit: 10 });

      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('LIMIT'),
        expect.arrayContaining(['user-456', 10, 10]) // limit=10, offset=10
      );
    });
  });

  describe('findByMemberId', () => {
    it('returns libraries user owns or is member of with asset counts using library_assets', async () => {
      const mockRow = createMockLibraryRow({
        owner_email: 'owner@example.com',
        owner_display_name: 'Owner User',
        asset_count: '15',
      });
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.findByMemberId('user-456');

      // Verify it uses library_assets subquery (not media_assets)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FROM library_assets la WHERE la.library_id = l.id'),
        expect.any(Array)
      );
      expect(result.libraries).toHaveLength(1);
      expect(result.libraries[0].assetCount).toBe(15);
    });

    it('includes both owned and member libraries', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.findByMemberId('user-456');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('l.owner_id = $1 OR lm.user_id = $1'),
        expect.any(Array)
      );
    });
  });

  describe('create', () => {
    it('creates a library with default visibility', async () => {
      const mockRow = createMockLibraryRow();
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.create({
        ownerId: 'user-456',
        name: 'New Library',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO libraries'),
        ['user-456', 'New Library', null, 'private']
      );
      expect(result.id).toBe('library-123');
    });

    it('creates a library with custom visibility', async () => {
      const mockRow = createMockLibraryRow({ visibility: 'shared' });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.create({
        ownerId: 'user-456',
        name: 'Shared Library',
        description: 'Shared with family',
        visibility: 'shared',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO libraries'),
        ['user-456', 'Shared Library', 'Shared with family', 'shared']
      );
      expect(result.visibility).toBe('shared');
    });
  });

  describe('update', () => {
    it('updates library fields', async () => {
      const mockRow = createMockLibraryRow({ name: 'Updated Name' });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.update('library-123', { name: 'Updated Name' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE libraries SET name = $1'),
        expect.arrayContaining(['Updated Name', 'library-123'])
      );
      expect(result?.name).toBe('Updated Name');
    });

    it('returns null when library not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.update('nonexistent', { name: 'New Name' });

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes library and returns true', async () => {
      mockQuery.mockResolvedValue({ rowCount: 1 });

      const result = await repository.delete('library-123');

      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM libraries WHERE id = $1',
        ['library-123']
      );
      expect(result).toBe(true);
    });

    it('returns false when library not found', async () => {
      mockQuery.mockResolvedValue({ rowCount: 0 });

      const result = await repository.delete('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('hasAccess', () => {
    it('returns true when user is owner', async () => {
      mockQuery.mockResolvedValue({ rows: [{ has_access: true }] });

      const result = await repository.hasAccess('user-456', 'library-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('l.owner_id = $1'),
        ['user-456', 'library-123']
      );
      expect(result).toBe(true);
    });

    it('returns true for public library', async () => {
      mockQuery.mockResolvedValue({ rows: [{ has_access: true }] });

      const result = await repository.hasAccess('other-user', 'library-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("l.visibility = 'public'"),
        expect.any(Array)
      );
      expect(result).toBe(true);
    });

    it('returns false when no access', async () => {
      mockQuery.mockResolvedValue({ rows: [{ has_access: false }] });

      const result = await repository.hasAccess('other-user', 'library-123');

      expect(result).toBe(false);
    });
  });

  describe('canUpload', () => {
    it('returns true when user is owner', async () => {
      mockQuery.mockResolvedValue({ rows: [{ can_upload: true }] });

      const result = await repository.canUpload('user-456', 'library-123');

      expect(result).toBe(true);
    });

    it('returns true when user is contributor', async () => {
      mockQuery.mockResolvedValue({ rows: [{ can_upload: true }] });

      const result = await repository.canUpload('contributor-user', 'library-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("lm.role IN ('contributor', 'admin')"),
        expect.any(Array)
      );
      expect(result).toBe(true);
    });

    it('returns false when user is viewer only', async () => {
      mockQuery.mockResolvedValue({ rows: [{ can_upload: false }] });

      const result = await repository.canUpload('viewer-user', 'library-123');

      expect(result).toBe(false);
    });
  });

  describe('isOwnerOrAdmin', () => {
    it('returns true when user is owner', async () => {
      mockQuery.mockResolvedValue({ rows: [{ is_admin: true }] });

      const result = await repository.isOwnerOrAdmin('user-456', 'library-123');

      expect(result).toBe(true);
    });

    it('returns true when user is admin member', async () => {
      mockQuery.mockResolvedValue({ rows: [{ is_admin: true }] });

      const result = await repository.isOwnerOrAdmin('admin-user', 'library-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("lm.role = 'admin'"),
        expect.any(Array)
      );
      expect(result).toBe(true);
    });

    it('returns false when user is not owner or admin', async () => {
      mockQuery.mockResolvedValue({ rows: [{ is_admin: false }] });

      const result = await repository.isOwnerOrAdmin('viewer-user', 'library-123');

      expect(result).toBe(false);
    });
  });

  describe('getMembers', () => {
    it('returns all members with user info', async () => {
      const mockMemberRows = [
        createMockMemberRow({ role: 'admin' }),
        createMockMemberRow({ id: 'member-456', user_id: 'user-999', role: 'viewer' }),
      ];
      mockQuery.mockResolvedValue({ rows: mockMemberRows });

      const result = await repository.getMembers('library-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FROM library_members lm'),
        ['library-123']
      );
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('admin');
      expect(result[1].role).toBe('viewer');
    });

    it('returns empty array when no members', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.getMembers('library-123');

      expect(result).toEqual([]);
    });
  });

  describe('getMember', () => {
    it('returns member when found', async () => {
      const mockRow = createMockMemberRow();
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.getMember('library-123', 'user-789');

      expect(result).toEqual(expect.objectContaining({
        libraryId: 'library-123',
        userId: 'user-789',
        role: 'viewer',
      }));
    });

    it('returns null when member not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.getMember('library-123', 'nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('addMember', () => {
    it('adds member with specified role', async () => {
      const mockRow = createMockMemberRow({ role: 'contributor' });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.addMember('library-123', 'user-789', 'contributor', 'user-456');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO library_members'),
        ['library-123', 'user-789', 'contributor', 'user-456']
      );
      expect(result.role).toBe('contributor');
    });
  });

  describe('updateMemberRole', () => {
    it('updates member role', async () => {
      const mockRow = createMockMemberRow({ role: 'admin' });
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.updateMemberRole('library-123', 'user-789', 'admin');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE library_members SET role = $3'),
        ['library-123', 'user-789', 'admin']
      );
      expect(result?.role).toBe('admin');
    });

    it('returns null when member not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.updateMemberRole('library-123', 'nonexistent', 'admin');

      expect(result).toBeNull();
    });
  });

  describe('removeMember', () => {
    it('removes member and returns true', async () => {
      mockQuery.mockResolvedValue({ rowCount: 1 });

      const result = await repository.removeMember('library-123', 'user-789');

      expect(mockQuery).toHaveBeenCalledWith(
        'DELETE FROM library_members WHERE library_id = $1 AND user_id = $2',
        ['library-123', 'user-789']
      );
      expect(result).toBe(true);
    });

    it('returns false when member not found', async () => {
      mockQuery.mockResolvedValue({ rowCount: 0 });

      const result = await repository.removeMember('library-123', 'nonexistent');

      expect(result).toBe(false);
    });
  });
});
