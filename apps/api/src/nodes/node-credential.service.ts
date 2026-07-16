// =============================================================================
// Node Credential Service
// =============================================================================
//
// Durable, least-privilege, individually-revocable worker-node credentials.
// A node credential is a `nod_`-prefixed bearer token that authenticates
// exactly like a PAT (sha256-hashed at rest, raw value shown once) but:
//   - is only accepted on /api/nodes/* routes (enforced by JwtAuthGuard's
//     route allowlist, not here),
//   - may never expire (`expiresAt` NULL = never), since worker nodes are
//     long-lived daemons rather than short-lived CLI sessions.
//
// Closely mirrors PatService — keep the two in sync when touching either.
// =============================================================================

import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createHash, randomBytes } from 'crypto';
import { CreateNodeCredentialDto } from './dto/create-node-credential.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

@Injectable()
export class NodeCredentialService {
  private readonly logger = new Logger(NodeCredentialService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new node credential for a user.
   * Returns the raw token exactly once — it is never stored or shown again.
   */
  async createCredential(userId: string, dto: CreateNodeCredentialDto) {
    // Generate raw token: nod_ + 32 random bytes as hex (64 hex chars)
    const hexPart = randomBytes(32).toString('hex');
    const rawToken = `nod_${hexPart}`;

    // Hash the token for storage
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    // tokenPrefix: "nod_" + first 4 hex chars of hexPart = 8 chars total display prefix
    const tokenPrefix = `nod_${hexPart.slice(0, 4)}`;

    // Nullable expiry: omitted/null = never expires
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    const credential = await this.prisma.nodeCredential.create({
      data: {
        userId,
        name: dto.name,
        tokenHash,
        tokenPrefix,
        expiresAt,
      },
    });

    this.logger.log(`Created node credential "${dto.name}" for user: ${userId}`);

    return {
      token: rawToken,
      id: credential.id,
      name: credential.name,
      tokenPrefix: credential.tokenPrefix,
      expiresAt: credential.expiresAt ? credential.expiresAt.toISOString() : null,
      createdAt: credential.createdAt.toISOString(),
    };
  }

  /**
   * List all node credentials for a user (without token hashes)
   */
  async listForUser(userId: string) {
    const credentials = await this.prisma.nodeCredential.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
      },
    });

    return credentials;
  }

  /**
   * Revoke a node credential by ID (ownership-checked)
   */
  async revoke(userId: string, credentialId: string): Promise<void> {
    const credential = await this.prisma.nodeCredential.findFirst({
      where: { id: credentialId, userId },
    });

    if (!credential) {
      throw new NotFoundException('Credential not found');
    }

    if (credential.revokedAt !== null) {
      throw new NotFoundException('Credential already revoked');
    }

    await this.prisma.nodeCredential.update({
      where: { id: credential.id },
      data: { revokedAt: new Date() },
    });

    this.logger.log(`Revoked node credential "${credential.name}" (${credential.id}) for user: ${userId}`);
  }

  /**
   * Admin: list ALL node credentials across users, annotated with the owning
   * user's email/display name (never the hash or raw token).
   */
  async listAll() {
    const credentials = await this.prisma.nodeCredential.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        name: true,
        tokenPrefix: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
        revokedAt: true,
        user: {
          select: { email: true, displayName: true },
        },
      },
    });

    return credentials.map((c) => ({
      id: c.id,
      userId: c.userId,
      name: c.name,
      tokenPrefix: c.tokenPrefix,
      expiresAt: c.expiresAt,
      lastUsedAt: c.lastUsedAt,
      createdAt: c.createdAt,
      revokedAt: c.revokedAt,
      ownerEmail: c.user.email,
      ownerDisplayName: c.user.displayName,
    }));
  }

  /**
   * Admin: revoke ANY node credential regardless of owner (soft revoke).
   */
  async revokeAny(credentialId: string): Promise<void> {
    const credential = await this.prisma.nodeCredential.findUnique({
      where: { id: credentialId },
    });

    if (!credential) {
      throw new NotFoundException('Credential not found');
    }

    if (credential.revokedAt !== null) {
      throw new NotFoundException('Credential already revoked');
    }

    await this.prisma.nodeCredential.update({
      where: { id: credential.id },
      data: { revokedAt: new Date() },
    });

    this.logger.log(`Admin revoked node credential "${credential.name}" (${credential.id})`);
  }

  /**
   * Validate a raw node credential and return the associated user if valid.
   * A NULL expiresAt never expires. The route allowlist (nodes-only) is the
   * caller's (JwtAuthGuard's) responsibility, not this method's.
   */
  async validateToken(rawToken: string): Promise<AuthenticatedUser | null> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    const credential = await this.prisma.nodeCredential.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            userRoles: {
              include: {
                role: {
                  include: {
                    rolePermissions: {
                      include: { permission: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!credential) {
      return null;
    }

    // Check revoked
    if (credential.revokedAt !== null) {
      return null;
    }

    // Check expired (NULL = never expires)
    if (credential.expiresAt !== null && credential.expiresAt <= new Date()) {
      return null;
    }

    // Check user active
    if (!credential.user.isActive) {
      return null;
    }

    // Fire-and-forget update of lastUsedAt
    this.prisma.nodeCredential
      .update({ where: { id: credential.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return credential.user as AuthenticatedUser;
  }
}
