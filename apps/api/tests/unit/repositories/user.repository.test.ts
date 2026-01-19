/**
 * User Repository Tests
 *
 * Tests for user data access layer.
 * Covers CRUD operations, OAuth identity lookup, and transactions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserRepository } from '../../../src/infrastructure/database/repositories/user.repository.js';
import type { OAuthProvider } from '@memoriahub/shared';

// Mock database client
const mockQuery = vi.fn();
const mockWithTransaction = vi.fn();

vi.mock('../../../src/infrastructure/database/client.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  withTransaction: (fn: (client: unknown) => Promise<unknown>) => mockWithTransaction(fn),
}));

// Mock logger
vi.mock('../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('UserRepository', () => {
  let repository: UserRepository;

  const mockUserRow = {
    id: 'user-123',
    oauth_provider: 'google' as OAuthProvider,
    oauth_subject: 'google-subject-456',
    email: 'test@example.com',
    email_verified: true,
    display_name: 'Test User',
    avatar_url: 'https://example.com/avatar.jpg',
    refresh_token_hash: null,
    is_active: true,
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-02'),
    last_login_at: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    repository = new UserRepository();
  });

  describe('findById', () => {
    it('returns user for valid ID', async () => {
      mockQuery.mockResolvedValue({ rows: [mockUserRow] });

      const result = await repository.findById('user-123');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('user-123');
      expect(result?.email).toBe('test@example.com');
      expect(result?.oauthProvider).toBe('google');
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE id = $1 AND is_active = true',
        ['user-123']
      );
    });

    it('returns null for non-existent ID', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.findById('nonexistent-id');

      expect(result).toBeNull();
    });

    it('filters out inactive users', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await repository.findById('inactive-user-id');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('is_active = true'),
        expect.any(Array)
      );
    });
  });

  describe('findByOAuthIdentity', () => {
    it('returns user for valid OAuth identity', async () => {
      mockQuery.mockResolvedValue({ rows: [mockUserRow] });

      const result = await repository.findByOAuthIdentity('google', 'google-subject-456');

      expect(result).not.toBeNull();
      expect(result?.oauthProvider).toBe('google');
      expect(result?.oauthSubject).toBe('google-subject-456');
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE oauth_provider = $1 AND oauth_subject = $2 AND is_active = true',
        ['google', 'google-subject-456']
      );
    });

    it('returns null for non-existent OAuth identity', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.findByOAuthIdentity('google', 'unknown-subject');

      expect(result).toBeNull();
    });

    it('differentiates between providers with same subject', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await repository.findByOAuthIdentity('microsoft', 'google-subject-456');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['microsoft', 'google-subject-456']
      );
    });
  });

  describe('findByEmail', () => {
    it('returns user for valid email and provider', async () => {
      mockQuery.mockResolvedValue({ rows: [mockUserRow] });

      const result = await repository.findByEmail('google', 'test@example.com');

      expect(result).not.toBeNull();
      expect(result?.email).toBe('test@example.com');
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE oauth_provider = $1 AND email = $2 AND is_active = true',
        ['google', 'test@example.com']
      );
    });

    it('returns null for non-existent email', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.findByEmail('google', 'unknown@example.com');

      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('creates new user with required fields', async () => {
      mockQuery.mockResolvedValue({ rows: [mockUserRow] });

      const input = {
        oauthProvider: 'google' as OAuthProvider,
        oauthSubject: 'google-subject-456',
        email: 'test@example.com',
        emailVerified: true,
      };

      const result = await repository.create(input);

      expect(result.id).toBe('user-123');
      expect(result.email).toBe('test@example.com');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        ['google', 'google-subject-456', 'test@example.com', true, null, null]
      );
    });

    it('creates user with optional display name and avatar', async () => {
      mockQuery.mockResolvedValue({ rows: [mockUserRow] });

      const input = {
        oauthProvider: 'google' as OAuthProvider,
        oauthSubject: 'google-subject-456',
        email: 'test@example.com',
        emailVerified: true,
        displayName: 'Test User',
        avatarUrl: 'https://example.com/avatar.jpg',
      };

      const result = await repository.create(input);

      expect(result.displayName).toBe('Test User');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['google', 'google-subject-456', 'test@example.com', true, 'Test User', 'https://example.com/avatar.jpg']
      );
    });
  });

  describe('update', () => {
    it('updates display name', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ ...mockUserRow, display_name: 'Updated Name' }],
      });

      const result = await repository.update('user-123', {
        displayName: 'Updated Name',
      });

      expect(result.displayName).toBe('Updated Name');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users SET display_name'),
        ['Updated Name', 'user-123']
      );
    });

    it('updates avatar URL', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ ...mockUserRow, avatar_url: 'https://new-avatar.jpg' }],
      });

      await repository.update('user-123', {
        avatarUrl: 'https://new-avatar.jpg',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('avatar_url'),
        expect.any(Array)
      );
    });

    it('updates email and emailVerified', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ ...mockUserRow, email: 'new@example.com', email_verified: true }],
      });

      await repository.update('user-123', {
        email: 'new@example.com',
        emailVerified: true,
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('email'),
        expect.arrayContaining(['new@example.com', true])
      );
    });

    it('updates refresh token hash', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ ...mockUserRow, refresh_token_hash: 'new-hash' }],
      });

      await repository.update('user-123', {
        refreshTokenHash: 'new-hash',
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('refresh_token_hash'),
        expect.arrayContaining(['new-hash'])
      );
    });

    it('updates last login at', async () => {
      const loginTime = new Date();
      mockQuery.mockResolvedValue({
        rows: [{ ...mockUserRow, last_login_at: loginTime }],
      });

      await repository.update('user-123', {
        lastLoginAt: loginTime,
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('last_login_at'),
        expect.arrayContaining([loginTime])
      );
    });

    it('updates multiple fields in single query', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ ...mockUserRow, display_name: 'New Name', avatar_url: 'new-url' }],
      });

      await repository.update('user-123', {
        displayName: 'New Name',
        avatarUrl: 'new-url',
      });

      // Should use parameterized query with both values
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringMatching(/display_name.*avatar_url|avatar_url.*display_name/),
        expect.any(Array)
      );
    });

    it('returns current user when no updates provided', async () => {
      mockQuery.mockResolvedValue({ rows: [mockUserRow] });

      // First call for findById
      const result = await repository.update('user-123', {});

      expect(result.id).toBe('user-123');
      // Should have called findById, not update query
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE id = $1 AND is_active = true',
        ['user-123']
      );
    });

    it('throws error when user not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await expect(repository.update('nonexistent', { displayName: 'New' })).rejects.toThrow(
        'User nonexistent not found'
      );
    });
  });

  describe('findOrCreate', () => {
    it('returns existing user when found', async () => {
      const mockClient = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [mockUserRow] }) // SELECT FOR UPDATE
          .mockResolvedValueOnce({ rows: [{ ...mockUserRow, last_login_at: new Date() }] }), // UPDATE
      };

      mockWithTransaction.mockImplementation(async (fn) => fn(mockClient));

      const input = {
        oauthProvider: 'google' as OAuthProvider,
        oauthSubject: 'google-subject-456',
        email: 'test@example.com',
        emailVerified: true,
      };

      const result = await repository.findOrCreate(input);

      expect(result.user.id).toBe('user-123');
      expect(result.created).toBe(false);
    });

    it('creates new user when not found', async () => {
      const mockClient = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE (not found)
          .mockResolvedValueOnce({ rows: [mockUserRow] }), // INSERT
      };

      mockWithTransaction.mockImplementation(async (fn) => fn(mockClient));

      const input = {
        oauthProvider: 'google' as OAuthProvider,
        oauthSubject: 'new-google-subject',
        email: 'newuser@example.com',
        emailVerified: true,
        displayName: 'New User',
      };

      const result = await repository.findOrCreate(input);

      expect(result.created).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        expect.any(Array)
      );
    });

    it('updates existing user profile on login', async () => {
      const mockClient = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [mockUserRow] }) // SELECT FOR UPDATE
          .mockResolvedValueOnce({ rows: [{ ...mockUserRow, display_name: 'Updated Name' }] }), // UPDATE
      };

      mockWithTransaction.mockImplementation(async (fn) => fn(mockClient));

      const input = {
        oauthProvider: 'google' as OAuthProvider,
        oauthSubject: 'google-subject-456',
        email: 'test@example.com',
        emailVerified: true,
        displayName: 'Updated Name',
      };

      await repository.findOrCreate(input);

      // Should update with new profile info
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users SET'),
        expect.arrayContaining(['test@example.com', true, 'Updated Name'])
      );
    });

    it('uses FOR UPDATE lock to prevent race conditions', async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [mockUserRow] }),
      };

      mockWithTransaction.mockImplementation(async (fn) => fn(mockClient));

      const input = {
        oauthProvider: 'google' as OAuthProvider,
        oauthSubject: 'google-subject-456',
        email: 'test@example.com',
        emailVerified: true,
      };

      await repository.findOrCreate(input);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('FOR UPDATE'),
        expect.any(Array)
      );
    });

    it('updates last_login_at on login', async () => {
      const mockClient = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [mockUserRow] })
          .mockResolvedValueOnce({ rows: [mockUserRow] }),
      };

      mockWithTransaction.mockImplementation(async (fn) => fn(mockClient));

      const input = {
        oauthProvider: 'google' as OAuthProvider,
        oauthSubject: 'google-subject-456',
        email: 'test@example.com',
        emailVerified: true,
      };

      await repository.findOrCreate(input);

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('last_login_at = NOW()'),
        expect.any(Array)
      );
    });
  });

  describe('SQL injection prevention', () => {
    it('uses parameterized queries for findById', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await repository.findById("'; DROP TABLE users; --");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ["'; DROP TABLE users; --"]
      );
    });

    it('uses parameterized queries for findByEmail', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await repository.findByEmail('google', "'; DROP TABLE users; --");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.any(String),
        ['google', "'; DROP TABLE users; --"]
      );
    });

    it('uses parameterized queries for create', async () => {
      mockQuery.mockResolvedValue({ rows: [mockUserRow] });

      await repository.create({
        oauthProvider: 'google',
        oauthSubject: "'; DROP TABLE users; --",
        email: 'test@example.com',
        emailVerified: true,
      });

      // All values should be passed as parameters
      expect(mockQuery).toHaveBeenCalledWith(
        expect.not.stringContaining("DROP TABLE"),
        expect.arrayContaining(["'; DROP TABLE users; --"])
      );
    });
  });
});
