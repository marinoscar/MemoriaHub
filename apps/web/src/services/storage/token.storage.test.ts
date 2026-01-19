/**
 * Token Storage Service Tests
 *
 * Tests for token persistence using sessionStorage and localStorage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tokenStorage } from './token.storage';

// Create mock storage
const createMockStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    _getStore: () => store,
  };
};

describe('tokenStorage', () => {
  let mockSessionStorage: ReturnType<typeof createMockStorage>;
  let mockLocalStorage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    mockSessionStorage = createMockStorage();
    mockLocalStorage = createMockStorage();

    // Replace window.sessionStorage and localStorage
    Object.defineProperty(window, 'sessionStorage', {
      value: mockSessionStorage,
      writable: true,
    });

    Object.defineProperty(window, 'localStorage', {
      value: mockLocalStorage,
      writable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('access token', () => {
    it('getAccessToken reads from sessionStorage', () => {
      mockSessionStorage.getItem.mockReturnValue('my-access-token');

      const result = tokenStorage.getAccessToken();

      expect(mockSessionStorage.getItem).toHaveBeenCalledWith('memoriahub_access_token');
      expect(result).toBe('my-access-token');
    });

    it('setAccessToken writes to sessionStorage', () => {
      tokenStorage.setAccessToken('new-access-token');

      expect(mockSessionStorage.setItem).toHaveBeenCalledWith(
        'memoriahub_access_token',
        'new-access-token'
      );
    });

    it('removeAccessToken removes from sessionStorage', () => {
      tokenStorage.removeAccessToken();

      expect(mockSessionStorage.removeItem).toHaveBeenCalledWith('memoriahub_access_token');
    });

    it('getAccessToken returns null when not set', () => {
      mockSessionStorage.getItem.mockReturnValue(null);

      const result = tokenStorage.getAccessToken();

      expect(result).toBeNull();
    });
  });

  describe('refresh token', () => {
    it('getRefreshToken reads from localStorage', () => {
      mockLocalStorage.getItem.mockReturnValue('my-refresh-token');

      const result = tokenStorage.getRefreshToken();

      expect(mockLocalStorage.getItem).toHaveBeenCalledWith('memoriahub_refresh_token');
      expect(result).toBe('my-refresh-token');
    });

    it('setRefreshToken writes to localStorage', () => {
      tokenStorage.setRefreshToken('new-refresh-token');

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
        'memoriahub_refresh_token',
        'new-refresh-token'
      );
    });

    it('removeRefreshToken removes from localStorage', () => {
      tokenStorage.removeRefreshToken();

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('memoriahub_refresh_token');
    });

    it('getRefreshToken returns null when not set', () => {
      mockLocalStorage.getItem.mockReturnValue(null);

      const result = tokenStorage.getRefreshToken();

      expect(result).toBeNull();
    });
  });

  describe('clear', () => {
    it('removes access token', () => {
      tokenStorage.clearAll();

      expect(mockSessionStorage.removeItem).toHaveBeenCalledWith('memoriahub_access_token');
    });

    it('removes refresh token', () => {
      tokenStorage.clearAll();

      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('memoriahub_refresh_token');
    });

    it('removes both tokens in single call', () => {
      tokenStorage.clearAll();

      expect(mockSessionStorage.removeItem).toHaveBeenCalledTimes(1);
      expect(mockLocalStorage.removeItem).toHaveBeenCalledTimes(1);
    });
  });

  describe('hasTokens', () => {
    it('returns true when both tokens exist', () => {
      mockSessionStorage.getItem.mockReturnValue('access-token');
      mockLocalStorage.getItem.mockReturnValue('refresh-token');

      const result = tokenStorage.hasTokens();

      expect(result).toBe(true);
    });

    it('returns true when only access token exists', () => {
      mockSessionStorage.getItem.mockReturnValue('access-token');
      mockLocalStorage.getItem.mockReturnValue(null);

      const result = tokenStorage.hasTokens();

      expect(result).toBe(true);
    });

    it('returns true when only refresh token exists', () => {
      mockSessionStorage.getItem.mockReturnValue(null);
      mockLocalStorage.getItem.mockReturnValue('refresh-token');

      const result = tokenStorage.hasTokens();

      expect(result).toBe(true);
    });

    it('returns false when both tokens missing', () => {
      mockSessionStorage.getItem.mockReturnValue(null);
      mockLocalStorage.getItem.mockReturnValue(null);

      const result = tokenStorage.hasTokens();

      expect(result).toBe(false);
    });

    it('returns false for empty string tokens', () => {
      mockSessionStorage.getItem.mockReturnValue('');
      mockLocalStorage.getItem.mockReturnValue('');

      const result = tokenStorage.hasTokens();

      // Empty strings are falsy, so should return false
      expect(result).toBe(false);
    });
  });

  describe('storage keys', () => {
    it('uses correct key for access token', () => {
      tokenStorage.getAccessToken();

      expect(mockSessionStorage.getItem).toHaveBeenCalledWith('memoriahub_access_token');
    });

    it('uses correct key for refresh token', () => {
      tokenStorage.getRefreshToken();

      expect(mockLocalStorage.getItem).toHaveBeenCalledWith('memoriahub_refresh_token');
    });
  });

  describe('storage separation', () => {
    it('access token uses sessionStorage (cleared on tab close)', () => {
      tokenStorage.setAccessToken('token');

      expect(mockSessionStorage.setItem).toHaveBeenCalled();
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
    });

    it('refresh token uses localStorage (persists across sessions)', () => {
      tokenStorage.setRefreshToken('token');

      expect(mockLocalStorage.setItem).toHaveBeenCalled();
      expect(mockSessionStorage.setItem).not.toHaveBeenCalled();
    });
  });
});
