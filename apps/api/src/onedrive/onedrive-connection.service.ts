import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { encryptSecret, decryptSecret } from '../common/crypto/secret-cipher';
import {
  MicrosoftGraphClient,
  OneDriveTokens,
  OneDriveUserProfile,
} from './microsoft-graph.client';
import { OneDriveNotConnectedError } from './onedrive.errors';

/** Public, token-free view of a user's OneDrive connection. */
export interface OneDriveConnectionStatus {
  connected: boolean;
  microsoftEmail?: string;
  connectedAt?: Date;
}

/**
 * Manages the per-user OneDrive token vault. The OAuth refresh token is stored
 * AES-256-GCM encrypted (same cipher/key as every other provider credential);
 * access tokens are never persisted — they are minted on demand from the
 * refresh token immediately before each Graph call. See
 * docs/specs/onedrive-import.md §2, §9.
 */
@Injectable()
export class OneDriveConnectionService {
  private readonly logger = new Logger(OneDriveConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graphClient: MicrosoftGraphClient,
  ) {}

  /** Return the caller's connection status. Never returns tokens. */
  async getStatus(userId: string): Promise<OneDriveConnectionStatus> {
    const connection = await this.prisma.oneDriveConnection.findUnique({
      where: { userId },
      select: { microsoftEmail: true, connectedAt: true },
    });
    if (!connection) return { connected: false };
    return {
      connected: true,
      microsoftEmail: connection.microsoftEmail,
      connectedAt: connection.connectedAt,
    };
  }

  /**
   * Upsert the connection after a successful OAuth callback. Encrypts and stores
   * the refresh token; one connection per user (unique on userId), so connecting
   * a new Microsoft account replaces the prior row.
   */
  async upsertFromCallback(
    userId: string,
    tokens: OneDriveTokens,
    profile: OneDriveUserProfile,
  ): Promise<void> {
    if (!tokens.refreshToken) {
      // offline_access should always yield a refresh token on a code exchange.
      throw new Error('Microsoft did not return a refresh token — is offline_access granted?');
    }
    const encryptedRefreshToken = encryptSecret(tokens.refreshToken);

    await this.prisma.oneDriveConnection.upsert({
      where: { userId },
      create: {
        userId,
        microsoftAccountId: profile.id,
        microsoftEmail: profile.email,
        encryptedRefreshToken,
        scopes: tokens.scopes,
      },
      update: {
        microsoftAccountId: profile.id,
        microsoftEmail: profile.email,
        encryptedRefreshToken,
        scopes: tokens.scopes,
      },
    });
  }

  /**
   * Mint a fresh access token for the user. Loads the connection, decrypts the
   * refresh token, refreshes it against Microsoft, and — if the refresh token
   * was rotated — re-encrypts and persists the new value. Throws
   * {@link OneDriveNotConnectedError} when no connection exists;
   * {@link OneDriveConnectionExpiredError} (from the Graph client) on invalid_grant.
   */
  async getFreshAccessToken(userId: string): Promise<string> {
    const connection = await this.prisma.oneDriveConnection.findUnique({
      where: { userId },
      select: { encryptedRefreshToken: true },
    });
    if (!connection) {
      throw new OneDriveNotConnectedError();
    }

    const refreshToken = decryptSecret(connection.encryptedRefreshToken);
    const tokens = await this.graphClient.refreshAccessToken(refreshToken);

    // Persist a rotated refresh token so the next refresh uses the current one.
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
      await this.prisma.oneDriveConnection.update({
        where: { userId },
        data: {
          encryptedRefreshToken: encryptSecret(tokens.refreshToken),
          scopes: tokens.scopes,
        },
      });
    }

    return tokens.accessToken;
  }

  /** Disconnect: delete the connection row. Does not affect imported media. */
  async disconnect(userId: string): Promise<void> {
    await this.prisma.oneDriveConnection.deleteMany({ where: { userId } });
  }
}
