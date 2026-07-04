/**
 * Unit tests for MicrosoftGraphClient.
 *
 * Mocks the global `fetch`. Tests cover:
 *  - buildAuthorizeUrl(): contains tenant, offline_access Files.Read User.Read
 *    scopes, response_type=code, redirect_uri
 *  - exchangeCodeForTokens() / refreshAccessToken(): POST the right grant params
 *    and parse tokens
 *  - HTTP 429 => throws RateLimitError with providerKey === 'onedrive' and a
 *    parsed retryAfterMs from Retry-After (token endpoint AND graphGet path)
 *  - invalid_grant / 401 => throws OneDriveConnectionExpiredError
 *  - listChildren(): follows @odata.nextLink across pages and filters to
 *    image/video (and folders where applicable)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MicrosoftGraphClient, ONEDRIVE_SCOPES } from './microsoft-graph.client';
import { OneDriveConnectionExpiredError } from './onedrive.errors';
import { RateLimitError } from '../enrichment/rate-limit.error';

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (key: string) => headers[key.toLowerCase()] ?? headers[key] ?? null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const CONFIG_VALUES: Record<string, string> = {
  'microsoft.tenant': 'common',
  'microsoft.clientId': 'test-client-id',
  'microsoft.clientSecret': 'test-client-secret',
  'microsoft.redirectUri': 'https://app.example.com/api/onedrive/auth/callback',
};

describe('MicrosoftGraphClient', () => {
  let client: MicrosoftGraphClient;
  let fetchMock: jest.Mock;
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(async () => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MicrosoftGraphClient,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => CONFIG_VALUES[key],
          },
        },
      ],
    }).compile();

    client = module.get<MicrosoftGraphClient>(MicrosoftGraphClient);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // buildAuthorizeUrl
  // =========================================================================

  describe('buildAuthorizeUrl', () => {
    it('contains the tenant, correct scopes, response_type=code, and redirect_uri', () => {
      const url = client.buildAuthorizeUrl('signed-state-value');

      expect(url).toContain('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
      const parsed = new URL(url);
      expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('redirect_uri')).toBe(
        'https://app.example.com/api/onedrive/auth/callback',
      );
      expect(parsed.searchParams.get('scope')).toBe(ONEDRIVE_SCOPES);
      expect(parsed.searchParams.get('scope')).toBe('offline_access Files.Read User.Read');
      expect(parsed.searchParams.get('state')).toBe('signed-state-value');
    });
  });

  // =========================================================================
  // exchangeCodeForTokens
  // =========================================================================

  describe('exchangeCodeForTokens', () => {
    it('POSTs the authorization_code grant with the right params and parses tokens', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          access_token: 'access-123',
          refresh_token: 'refresh-123',
          expires_in: 3600,
          scope: 'offline_access Files.Read User.Read',
        }),
      );

      const tokens = await client.exchangeCodeForTokens('auth-code-abc');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
      expect(options.method).toBe('POST');
      const body = new URLSearchParams(options.body);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe('test-client-id');
      expect(body.get('client_secret')).toBe('test-client-secret');
      expect(body.get('code')).toBe('auth-code-abc');
      expect(body.get('redirect_uri')).toBe('https://app.example.com/api/onedrive/auth/callback');

      expect(tokens).toEqual({
        accessToken: 'access-123',
        refreshToken: 'refresh-123',
        expiresIn: 3600,
        scopes: 'offline_access Files.Read User.Read',
      });
    });
  });

  // =========================================================================
  // refreshAccessToken
  // =========================================================================

  describe('refreshAccessToken', () => {
    it('POSTs the refresh_token grant with the right params and parses tokens', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          access_token: 'new-access-456',
          expires_in: 3600,
          scope: 'offline_access Files.Read User.Read',
          // no refresh_token => not rotated
        }),
      );

      const tokens = await client.refreshAccessToken('stored-refresh-token');

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
      const body = new URLSearchParams(options.body);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('stored-refresh-token');
      expect(body.get('client_id')).toBe('test-client-id');

      expect(tokens.accessToken).toBe('new-access-456');
      expect(tokens.refreshToken).toBeUndefined();
    });

    it('throws OneDriveConnectionExpiredError on invalid_grant', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(400, {
          error: 'invalid_grant',
          error_description: 'The refresh token has expired',
        }),
      );

      await expect(client.refreshAccessToken('expired-token')).rejects.toBeInstanceOf(
        OneDriveConnectionExpiredError,
      );
    });

    it('throws RateLimitError with providerKey=onedrive and parsed retryAfterMs on HTTP 429', async () => {
      fetchMock.mockResolvedValue(jsonResponse(429, {}, { 'retry-after': '30' }));

      let caught: unknown;
      try {
        await client.refreshAccessToken('some-token');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RateLimitError);
      const rateLimitError = caught as RateLimitError;
      expect(rateLimitError.providerKey).toBe('onedrive');
      expect(rateLimitError.retryAfterMs).toBe(30_000);
    });

    it('throws a generic Error for other non-ok responses', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(500, { error: 'server_error', error_description: 'boom' }),
      );

      await expect(client.refreshAccessToken('token')).rejects.toThrow(/server_error|boom/);
    });
  });

  // =========================================================================
  // graphGet (401 / 429) — exercised via getUserProfile
  // =========================================================================

  describe('graphGet — error mapping', () => {
    it('throws OneDriveConnectionExpiredError on HTTP 401', async () => {
      fetchMock.mockResolvedValue(jsonResponse(401, {}));

      await expect(client.getUserProfile('access-token')).rejects.toBeInstanceOf(
        OneDriveConnectionExpiredError,
      );
    });

    it('throws RateLimitError with providerKey=onedrive and parsed retryAfterMs on HTTP 429', async () => {
      fetchMock.mockResolvedValue(jsonResponse(429, {}, { 'retry-after': '15' }));

      let caught: unknown;
      try {
        await client.getUserProfile('access-token');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(RateLimitError);
      expect((caught as RateLimitError).providerKey).toBe('onedrive');
      expect((caught as RateLimitError).retryAfterMs).toBe(15_000);
    });

    it('getUserProfile parses id and mail from the Graph /me response', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { id: 'ms-oid-1', mail: 'someone@example.com', userPrincipalName: 'someone@example.onmicrosoft.com' }),
      );

      const profile = await client.getUserProfile('access-token');

      expect(profile).toEqual({ id: 'ms-oid-1', email: 'someone@example.com' });
    });

    it('getUserProfile falls back to userPrincipalName when mail is null', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { id: 'ms-oid-2', mail: null, userPrincipalName: 'someone@example.onmicrosoft.com' }),
      );

      const profile = await client.getUserProfile('access-token');

      expect(profile.email).toBe('someone@example.onmicrosoft.com');
    });
  });

  // =========================================================================
  // listChildren
  // =========================================================================

  describe('listChildren', () => {
    it('follows @odata.nextLink across pages, accumulating all items', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(200, {
            value: [
              { id: 'item-1', name: 'photo1.jpg', size: 100, file: { mimeType: 'image/jpeg' } },
            ],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/drive/root/children?page=2',
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            value: [
              { id: 'item-2', name: 'photo2.png', size: 200, file: { mimeType: 'image/png' } },
            ],
            // no nextLink => last page
          }),
        );

      const items = await client.listChildren('access-token', null);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.id)).toEqual(['item-1', 'item-2']);
    });

    it('filters to image/video only when imagesAndVideosOnly is set, excluding other file types and folders', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          value: [
            { id: 'img-1', name: 'a.jpg', size: 10, file: { mimeType: 'image/jpeg' } },
            { id: 'vid-1', name: 'b.mp4', size: 20, file: { mimeType: 'video/mp4' } },
            { id: 'doc-1', name: 'c.pdf', size: 30, file: { mimeType: 'application/pdf' } },
            { id: 'folder-1', name: 'Subfolder', folder: { childCount: 2 } },
          ],
        }),
      );

      const items = await client.listChildren('access-token', null, { imagesAndVideosOnly: true });

      expect(items.map((i) => i.id).sort()).toEqual(['img-1', 'vid-1']);
    });

    it('filters to folders only when foldersOnly is set', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          value: [
            { id: 'img-1', name: 'a.jpg', size: 10, file: { mimeType: 'image/jpeg' } },
            { id: 'folder-1', name: 'Subfolder', folder: { childCount: 2 } },
          ],
        }),
      );

      const items = await client.listChildren('access-token', null, { foldersOnly: true });

      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('folder-1');
      expect(items[0].isFolder).toBe(true);
    });

    it('builds the children URL from a folder path, URL-encoding path segments', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { value: [] }));

      await client.listChildren('access-token', 'Photos/2024 Trip', {});

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('/me/drive/root:/Photos/2024%20Trip:/children');
    });

    it('lists the drive root when folderPathOrNull is null', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { value: [] }));

      await client.listChildren('access-token', null, {});

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://graph.microsoft.com/v1.0/me/drive/root/children');
    });
  });
});
