/**
 * Unit tests for OneDriveConnectionService.
 *
 * IMPORTANT: SECRETS_ENCRYPTION_KEY must be set for encrypt/decrypt to work
 * (same convention as storage-settings.service.spec.ts). Set in beforeAll,
 * restored in afterAll.
 *
 * Tests cover:
 *  - upsertFromCallback(): encrypts the refresh token (stored value is NOT the
 *    plaintext; round-trips via decryptSecret), stores email/account/scopes,
 *    throws when Microsoft did not return a refreshToken
 *  - getFreshAccessToken(): happy path (decrypts, calls graphClient.refreshAccessToken,
 *    returns access token); persists a rotated refresh token when Graph returns a
 *    new one; does NOT persist when Graph returns the same token; propagates
 *    OneDriveConnectionExpiredError from the Graph client untouched; throws
 *    OneDriveNotConnectedError when no connection exists
 *  - getStatus(): returns connected/email/connectedAt and never leaks tokens;
 *    returns connected:false when no row exists
 *  - disconnect(): deletes the row
 */

import { Test, TestingModule } from '@nestjs/testing';
import { OneDriveConnectionService } from './onedrive-connection.service';
import { PrismaService } from '../prisma/prisma.service';
import { MicrosoftGraphClient } from './microsoft-graph.client';
import { OneDriveNotConnectedError, OneDriveConnectionExpiredError } from './onedrive.errors';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { encryptSecret, decryptSecret } from '../common/crypto/secret-cipher';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';
const USER_ID = 'user-1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConnectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    userId: USER_ID,
    microsoftAccountId: 'ms-account-1',
    microsoftEmail: 'user@outlook.com',
    encryptedRefreshToken: encryptSecret('original-refresh-token'),
    scopes: 'offline_access Files.Read User.Read',
    connectedAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OneDriveConnectionService', () => {
  let service: OneDriveConnectionService;
  let mockPrisma: MockPrismaService;
  let mockGraphClient: { refreshAccessToken: jest.Mock };
  let originalKey: string | undefined;

  beforeAll(() => {
    originalKey = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = VALID_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.SECRETS_ENCRYPTION_KEY;
    } else {
      process.env.SECRETS_ENCRYPTION_KEY = originalKey;
    }
  });

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockGraphClient = {
      refreshAccessToken: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OneDriveConnectionService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MicrosoftGraphClient, useValue: mockGraphClient },
      ],
    }).compile();

    service = module.get<OneDriveConnectionService>(OneDriveConnectionService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // upsertFromCallback
  // =========================================================================

  describe('upsertFromCallback', () => {
    it('encrypts the refresh token — stored value is NOT the plaintext and round-trips via decryptSecret', async () => {
      (mockPrisma.oneDriveConnection.upsert as jest.Mock).mockResolvedValue(makeConnectionRow());

      await service.upsertFromCallback(
        USER_ID,
        {
          accessToken: 'access-token-abc',
          refreshToken: 'plaintext-refresh-token-xyz',
          expiresIn: 3600,
          scopes: 'offline_access Files.Read User.Read',
        },
        { id: 'ms-account-1', email: 'user@outlook.com' },
      );

      const upsertCall = (mockPrisma.oneDriveConnection.upsert as jest.Mock).mock.calls[0][0];
      const storedCiphertext = upsertCall.create.encryptedRefreshToken;

      expect(storedCiphertext).not.toBe('plaintext-refresh-token-xyz');
      expect(typeof storedCiphertext).toBe('string');
      expect(storedCiphertext.length).toBeGreaterThan(0);
      // Round-trips back to the original plaintext
      expect(decryptSecret(storedCiphertext)).toBe('plaintext-refresh-token-xyz');

      // update branch must carry the identical ciphertext
      expect(upsertCall.update.encryptedRefreshToken).toBe(storedCiphertext);
    });

    it('stores microsoftAccountId, microsoftEmail, and scopes from profile/tokens', async () => {
      (mockPrisma.oneDriveConnection.upsert as jest.Mock).mockResolvedValue(makeConnectionRow());

      await service.upsertFromCallback(
        USER_ID,
        {
          accessToken: 'access-token-abc',
          refreshToken: 'refresh-token-xyz',
          expiresIn: 3600,
          scopes: 'offline_access Files.Read User.Read',
        },
        { id: 'ms-account-42', email: 'someone@example.com' },
      );

      const upsertCall = (mockPrisma.oneDriveConnection.upsert as jest.Mock).mock.calls[0][0];
      expect(upsertCall.where).toEqual({ userId: USER_ID });
      expect(upsertCall.create).toMatchObject({
        userId: USER_ID,
        microsoftAccountId: 'ms-account-42',
        microsoftEmail: 'someone@example.com',
        scopes: 'offline_access Files.Read User.Read',
      });
      expect(upsertCall.update).toMatchObject({
        microsoftAccountId: 'ms-account-42',
        microsoftEmail: 'someone@example.com',
        scopes: 'offline_access Files.Read User.Read',
      });
    });

    it('throws when Microsoft did not return a refresh token', async () => {
      await expect(
        service.upsertFromCallback(
          USER_ID,
          { accessToken: 'access-token-abc', expiresIn: 3600, scopes: 'offline_access Files.Read User.Read' },
          { id: 'ms-account-1', email: 'user@outlook.com' },
        ),
      ).rejects.toThrow(/refresh token/i);

      expect(mockPrisma.oneDriveConnection.upsert).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getFreshAccessToken
  // =========================================================================

  describe('getFreshAccessToken', () => {
    it('happy path: decrypts the stored refresh token, calls graphClient.refreshAccessToken, and returns the access token', async () => {
      const row = makeConnectionRow({ encryptedRefreshToken: encryptSecret('stored-refresh-token') });
      (mockPrisma.oneDriveConnection.findUnique as jest.Mock).mockResolvedValue(row);
      mockGraphClient.refreshAccessToken.mockResolvedValue({
        accessToken: 'fresh-access-token',
        expiresIn: 3600,
        scopes: 'offline_access Files.Read User.Read',
        // No refreshToken in the response => not rotated
      });

      const token = await service.getFreshAccessToken(USER_ID);

      expect(mockGraphClient.refreshAccessToken).toHaveBeenCalledWith('stored-refresh-token');
      expect(token).toBe('fresh-access-token');
      // Not rotated => no update call
      expect(mockPrisma.oneDriveConnection.update).not.toHaveBeenCalled();
    });

    it('persists a rotated refresh token when Graph returns a new one', async () => {
      const row = makeConnectionRow({ encryptedRefreshToken: encryptSecret('old-refresh-token') });
      (mockPrisma.oneDriveConnection.findUnique as jest.Mock).mockResolvedValue(row);
      mockGraphClient.refreshAccessToken.mockResolvedValue({
        accessToken: 'fresh-access-token',
        refreshToken: 'rotated-refresh-token',
        expiresIn: 3600,
        scopes: 'offline_access Files.Read User.Read',
      });
      (mockPrisma.oneDriveConnection.update as jest.Mock).mockResolvedValue(row);

      const token = await service.getFreshAccessToken(USER_ID);

      expect(token).toBe('fresh-access-token');
      expect(mockPrisma.oneDriveConnection.update).toHaveBeenCalledTimes(1);
      const updateCall = (mockPrisma.oneDriveConnection.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.where).toEqual({ userId: USER_ID });
      // The persisted ciphertext must decrypt back to the rotated plaintext, not the old one
      expect(decryptSecret(updateCall.data.encryptedRefreshToken)).toBe('rotated-refresh-token');
      expect(updateCall.data.scopes).toBe('offline_access Files.Read User.Read');
    });

    it('does NOT persist when Graph returns the identical refresh token (no rotation)', async () => {
      const row = makeConnectionRow({ encryptedRefreshToken: encryptSecret('same-refresh-token') });
      (mockPrisma.oneDriveConnection.findUnique as jest.Mock).mockResolvedValue(row);
      mockGraphClient.refreshAccessToken.mockResolvedValue({
        accessToken: 'fresh-access-token',
        refreshToken: 'same-refresh-token',
        expiresIn: 3600,
        scopes: 'offline_access Files.Read User.Read',
      });

      await service.getFreshAccessToken(USER_ID);

      expect(mockPrisma.oneDriveConnection.update).not.toHaveBeenCalled();
    });

    it('propagates OneDriveConnectionExpiredError from the Graph client (invalid_grant)', async () => {
      const row = makeConnectionRow();
      (mockPrisma.oneDriveConnection.findUnique as jest.Mock).mockResolvedValue(row);
      mockGraphClient.refreshAccessToken.mockRejectedValue(
        new OneDriveConnectionExpiredError('OneDrive connection expired — please reconnect'),
      );

      await expect(service.getFreshAccessToken(USER_ID)).rejects.toBeInstanceOf(
        OneDriveConnectionExpiredError,
      );
      expect(mockPrisma.oneDriveConnection.update).not.toHaveBeenCalled();
    });

    it('throws OneDriveNotConnectedError when no connection exists for the user', async () => {
      (mockPrisma.oneDriveConnection.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getFreshAccessToken(USER_ID)).rejects.toBeInstanceOf(
        OneDriveNotConnectedError,
      );
      expect(mockGraphClient.refreshAccessToken).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getStatus
  // =========================================================================

  describe('getStatus', () => {
    it('returns connected:true with email and connectedAt, and never leaks tokens', async () => {
      const row = makeConnectionRow();
      (mockPrisma.oneDriveConnection.findUnique as jest.Mock).mockResolvedValue({
        microsoftEmail: row.microsoftEmail,
        connectedAt: row.connectedAt,
      });

      const status = await service.getStatus(USER_ID);

      expect(status).toEqual({
        connected: true,
        microsoftEmail: 'user@outlook.com',
        connectedAt: row.connectedAt,
      });
      expect(JSON.stringify(status)).not.toContain('encryptedRefreshToken');
      expect(JSON.stringify(status)).not.toMatch(/refresh/i);

      // Verify the query itself never selects the refresh token column
      const findArgs = (mockPrisma.oneDriveConnection.findUnique as jest.Mock).mock.calls[0][0];
      expect(findArgs.select).toEqual({ microsoftEmail: true, connectedAt: true });
    });

    it('returns connected:false when no connection row exists', async () => {
      (mockPrisma.oneDriveConnection.findUnique as jest.Mock).mockResolvedValue(null);

      const status = await service.getStatus(USER_ID);

      expect(status).toEqual({ connected: false });
    });
  });

  // =========================================================================
  // disconnect
  // =========================================================================

  describe('disconnect', () => {
    it('deletes the connection row for the user', async () => {
      (mockPrisma.oneDriveConnection.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.disconnect(USER_ID);

      expect(mockPrisma.oneDriveConnection.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
      });
    });
  });
});
