/**
 * API Client Interceptor Tests
 *
 * Tests for the Axios client request/response interceptors,
 * especially the token refresh queue logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

// Mock axios before importing client
vi.mock('axios', async () => {
  const actualAxios = await vi.importActual<typeof import('axios')>('axios');
  return {
    default: {
      create: vi.fn(() => ({
        interceptors: {
          request: { use: vi.fn() },
          response: { use: vi.fn() },
        },
        get: vi.fn(),
        post: vi.fn(),
      })),
      post: vi.fn(),
    },
    AxiosError: actualAxios.AxiosError,
  };
});

vi.mock('../../config/environment', () => ({
  config: {
    apiUrl: '/api',
  },
}));

vi.mock('../storage/token.storage', () => ({
  tokenStorage: {
    getAccessToken: vi.fn(),
    setAccessToken: vi.fn(),
    getRefreshToken: vi.fn(),
    setRefreshToken: vi.fn(),
    clearAll: vi.fn(),
  },
}));

import { tokenStorage } from '../storage/token.storage';

const mockTokenStorage = vi.mocked(tokenStorage);
const mockAxios = vi.mocked(axios);

// Store interceptor callbacks for testing
let requestInterceptor: (config: InternalAxiosRequestConfig) => InternalAxiosRequestConfig;
let responseSuccessInterceptor: (response: AxiosResponse) => AxiosResponse;
let responseErrorInterceptor: (error: AxiosError) => Promise<unknown>;

// Mock the original window.location
const originalLocation = window.location;

describe('apiClient', () => {
  let mockApiClient: {
    interceptors: {
      request: { use: ReturnType<typeof vi.fn> };
      response: { use: ReturnType<typeof vi.fn> };
    };
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Create a mock API client
    mockApiClient = {
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
      get: vi.fn(),
      post: vi.fn(),
    };

    mockAxios.create.mockReturnValue(mockApiClient as unknown as ReturnType<typeof axios.create>);

    // Mock window.location
    delete (window as { location?: Location }).location;
    window.location = { href: '' } as Location;

    // Import fresh module to capture interceptors
    vi.resetModules();
  });

  afterEach(() => {
    window.location = originalLocation;
    vi.resetModules();
  });

  describe('configuration', () => {
    it('uses correct base URL from environment', async () => {
      await import('./client');

      expect(mockAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: '/api',
        })
      );
    });

    it('sets appropriate timeout', async () => {
      await import('./client');

      expect(mockAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 30000,
        })
      );
    });

    it('sets content type to JSON', async () => {
      await import('./client');

      expect(mockAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
          },
        })
      );
    });
  });

  describe('request interceptor', () => {
    beforeEach(async () => {
      await import('./client');

      // Capture the request interceptor
      const requestUseCalls = mockApiClient.interceptors.request.use.mock.calls;
      if (requestUseCalls.length > 0) {
        requestInterceptor = requestUseCalls[0][0] as typeof requestInterceptor;
      }
    });

    it('adds Authorization header when access token exists', () => {
      mockTokenStorage.getAccessToken.mockReturnValue('test-access-token');

      const config: InternalAxiosRequestConfig = {
        headers: {} as InternalAxiosRequestConfig['headers'],
      } as InternalAxiosRequestConfig;

      const result = requestInterceptor(config);

      expect(result.headers?.Authorization).toBe('Bearer test-access-token');
    });

    it('does not add Authorization header when no token', () => {
      mockTokenStorage.getAccessToken.mockReturnValue(null);

      const config: InternalAxiosRequestConfig = {
        headers: {} as InternalAxiosRequestConfig['headers'],
      } as InternalAxiosRequestConfig;

      const result = requestInterceptor(config);

      expect(result.headers?.Authorization).toBeUndefined();
    });

    it('uses Bearer scheme for token', () => {
      mockTokenStorage.getAccessToken.mockReturnValue('my-token');

      const config: InternalAxiosRequestConfig = {
        headers: {} as InternalAxiosRequestConfig['headers'],
      } as InternalAxiosRequestConfig;

      const result = requestInterceptor(config);

      expect(result.headers?.Authorization).toMatch(/^Bearer /);
    });
  });

  describe('response interceptor - success', () => {
    beforeEach(async () => {
      await import('./client');

      // Capture the response interceptors
      const responseUseCalls = mockApiClient.interceptors.response.use.mock.calls;
      if (responseUseCalls.length > 0) {
        responseSuccessInterceptor = responseUseCalls[0][0] as typeof responseSuccessInterceptor;
        responseErrorInterceptor = responseUseCalls[0][1] as typeof responseErrorInterceptor;
      }
    });

    it('passes through successful responses unchanged', () => {
      const response = {
        data: { result: 'success' },
        status: 200,
        statusText: 'OK',
      } as AxiosResponse;

      const result = responseSuccessInterceptor(response);

      expect(result).toBe(response);
    });
  });

  describe('response interceptor - 401 handling', () => {
    beforeEach(async () => {
      await import('./client');

      // Capture the response interceptors
      const responseUseCalls = mockApiClient.interceptors.response.use.mock.calls;
      if (responseUseCalls.length > 0) {
        responseErrorInterceptor = responseUseCalls[0][1] as typeof responseErrorInterceptor;
      }
    });

    it('attempts token refresh on 401 response', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAxios.post.mockResolvedValue({
        data: { data: { accessToken: 'new-token' } },
      });
      mockApiClient.post.mockResolvedValue({ data: {} });

      const error = new AxiosError('Unauthorized', '401', undefined, undefined, {
        status: 401,
        data: {},
        statusText: 'Unauthorized',
        headers: {},
        config: {} as InternalAxiosRequestConfig,
      });
      error.config = {
        headers: {} as InternalAxiosRequestConfig['headers'],
      } as InternalAxiosRequestConfig;

      // The interceptor should attempt refresh
      try {
        await responseErrorInterceptor(error);
      } catch {
        // May throw if refresh fails
      }

      expect(mockAxios.post).toHaveBeenCalledWith(
        '/api/auth/refresh',
        expect.objectContaining({ refreshToken: 'refresh-token' })
      );
    });

    it('redirects to login on refresh failure', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAxios.post.mockRejectedValue(new Error('Refresh failed'));

      const error = new AxiosError('Unauthorized', '401', undefined, undefined, {
        status: 401,
        data: {},
        statusText: 'Unauthorized',
        headers: {},
        config: {} as InternalAxiosRequestConfig,
      });
      error.config = {
        headers: {} as InternalAxiosRequestConfig['headers'],
      } as InternalAxiosRequestConfig;

      try {
        await responseErrorInterceptor(error);
      } catch {
        // Expected to throw
      }

      expect(window.location.href).toBe('/login');
    });

    it('clears tokens on refresh failure', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');
      mockAxios.post.mockRejectedValue(new Error('Refresh failed'));

      const error = new AxiosError('Unauthorized', '401', undefined, undefined, {
        status: 401,
        data: {},
        statusText: 'Unauthorized',
        headers: {},
        config: {} as InternalAxiosRequestConfig,
      });
      error.config = {
        headers: {} as InternalAxiosRequestConfig['headers'],
      } as InternalAxiosRequestConfig;

      try {
        await responseErrorInterceptor(error);
      } catch {
        // Expected to throw
      }

      expect(mockTokenStorage.clearAll).toHaveBeenCalled();
    });

    it('redirects to login when no refresh token', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue(null);

      const error = new AxiosError('Unauthorized', '401', undefined, undefined, {
        status: 401,
        data: {},
        statusText: 'Unauthorized',
        headers: {},
        config: {} as InternalAxiosRequestConfig,
      });
      error.config = {
        headers: {} as InternalAxiosRequestConfig['headers'],
      } as InternalAxiosRequestConfig;

      try {
        await responseErrorInterceptor(error);
      } catch {
        // Expected to throw
      }

      expect(window.location.href).toBe('/login');
    });
  });

  describe('response interceptor - other errors', () => {
    beforeEach(async () => {
      await import('./client');

      // Capture the response interceptors
      const responseUseCalls = mockApiClient.interceptors.response.use.mock.calls;
      if (responseUseCalls.length > 0) {
        responseErrorInterceptor = responseUseCalls[0][1] as typeof responseErrorInterceptor;
      }
    });

    it('passes through 400 errors unchanged', async () => {
      const error = new AxiosError('Bad Request', '400', undefined, undefined, {
        status: 400,
        data: { error: 'Bad request' },
        statusText: 'Bad Request',
        headers: {},
        config: {} as InternalAxiosRequestConfig,
      });
      error.config = {
        headers: {} as InternalAxiosRequestConfig['headers'],
      } as InternalAxiosRequestConfig;

      await expect(responseErrorInterceptor(error)).rejects.toBe(error);
    });

    it('passes through 403 errors unchanged', async () => {
      const error = new AxiosError('Forbidden', '403', undefined, undefined, {
        status: 403,
        data: { error: 'Forbidden' },
        statusText: 'Forbidden',
        headers: {},
        config: {} as InternalAxiosRequestConfig,
      });
      error.config = {
        headers: {} as InternalAxiosRequestConfig['headers'],
      } as InternalAxiosRequestConfig;

      await expect(responseErrorInterceptor(error)).rejects.toBe(error);
    });

    it('passes through 500 errors unchanged', async () => {
      const error = new AxiosError('Internal Server Error', '500', undefined, undefined, {
        status: 500,
        data: { error: 'Server error' },
        statusText: 'Internal Server Error',
        headers: {},
        config: {} as InternalAxiosRequestConfig,
      });
      error.config = {
        headers: {} as InternalAxiosRequestConfig['headers'],
      } as InternalAxiosRequestConfig;

      await expect(responseErrorInterceptor(error)).rejects.toBe(error);
    });

    it('passes through network errors unchanged', async () => {
      const error = new AxiosError('Network Error');
      error.config = {
        headers: {} as InternalAxiosRequestConfig['headers'],
      } as InternalAxiosRequestConfig;

      await expect(responseErrorInterceptor(error)).rejects.toBe(error);
    });
  });

  describe('response interceptor - retry behavior', () => {
    beforeEach(async () => {
      await import('./client');

      // Capture the response interceptors
      const responseUseCalls = mockApiClient.interceptors.response.use.mock.calls;
      if (responseUseCalls.length > 0) {
        responseErrorInterceptor = responseUseCalls[0][1] as typeof responseErrorInterceptor;
      }
    });

    it('does not retry already retried requests', async () => {
      mockTokenStorage.getRefreshToken.mockReturnValue('refresh-token');

      const error = new AxiosError('Unauthorized', '401', undefined, undefined, {
        status: 401,
        data: {},
        statusText: 'Unauthorized',
        headers: {},
        config: {} as InternalAxiosRequestConfig,
      });
      error.config = {
        headers: {} as InternalAxiosRequestConfig['headers'],
        _retry: true, // Already retried
      } as InternalAxiosRequestConfig & { _retry?: boolean };

      await expect(responseErrorInterceptor(error)).rejects.toBe(error);
      expect(mockAxios.post).not.toHaveBeenCalled();
    });
  });
});
