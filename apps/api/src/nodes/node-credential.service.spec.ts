import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { NodeCredentialService } from './node-credential.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { CreateNodeCredentialDto } from './dto/create-node-credential.dto';
import { createHash } from 'crypto';

describe('NodeCredentialService', () => {
  let service: NodeCredentialService;
  let mockPrisma: MockPrismaService;

  const mockUserId = 'user-123';

  const mockCredentialRecord = {
    id: 'cred-id-123',
    userId: mockUserId,
    name: 'Garage worker',
    tokenHash: 'stored-hash',
    tokenPrefix: 'nod_abcd',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(),
  };

  const mockUserWithRelations = {
    id: mockUserId,
    email: 'test@example.com',
    isActive: true,
    displayName: null,
    userRoles: [
      {
        userId: mockUserId,
        roleId: 'role-1',
        role: {
          id: 'role-1',
          name: 'admin',
          rolePermissions: [
            {
              roleId: 'role-1',
              permissionId: 'perm-1',
              permission: { id: 'perm-1', name: 'jobs:write', description: null },
            },
          ],
        },
      },
    ],
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NodeCredentialService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<NodeCredentialService>(NodeCredentialService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // createCredential
  // ============================================================================

  describe('createCredential', () => {
    it('should return raw token starting with nod_', async () => {
      const dto: CreateNodeCredentialDto = { name: 'Garage worker' };

      mockPrisma.nodeCredential.create.mockResolvedValue(mockCredentialRecord as any);

      const result = await service.createCredential(mockUserId, dto);

      expect(result.token).toMatch(/^nod_/);
      expect(result.token).toHaveLength(4 + 64); // "nod_" + 64 hex chars
    });

    it('should store the SHA256 hash of the token (not the raw token)', async () => {
      const dto: CreateNodeCredentialDto = { name: 'Secure' };

      mockPrisma.nodeCredential.create.mockResolvedValue(mockCredentialRecord as any);

      const result = await service.createCredential(mockUserId, dto);

      const callArg = (mockPrisma.nodeCredential.create as jest.Mock).mock.calls[0][0];
      const storedHash = callArg.data.tokenHash;

      expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
      // The stored hash matches the SHA256 of the returned raw token
      const expectedHash = createHash('sha256').update(result.token).digest('hex');
      expect(storedHash).toBe(expectedHash);
    });

    it('should set tokenPrefix to nod_ + first 4 hex chars', async () => {
      const dto: CreateNodeCredentialDto = { name: 'Prefix' };

      mockPrisma.nodeCredential.create.mockResolvedValue(mockCredentialRecord as any);

      const result = await service.createCredential(mockUserId, dto);

      const hexPart = result.token.slice(4); // Remove "nod_"
      const expectedPrefix = `nod_${hexPart.slice(0, 4)}`;

      const callArg = (mockPrisma.nodeCredential.create as jest.Mock).mock.calls[0][0];
      expect(callArg.data.tokenPrefix).toBe(expectedPrefix);
    });

    it('should store NULL expiresAt when omitted (never expires)', async () => {
      const dto: CreateNodeCredentialDto = { name: 'Forever' };

      mockPrisma.nodeCredential.create.mockResolvedValue(mockCredentialRecord as any);

      const result = await service.createCredential(mockUserId, dto);

      const callArg = (mockPrisma.nodeCredential.create as jest.Mock).mock.calls[0][0];
      expect(callArg.data.expiresAt).toBeNull();
      expect(result.expiresAt).toBeNull();
    });

    it('should store the parsed Date when expiresAt is provided', async () => {
      const iso = '2027-01-01T00:00:00.000Z';
      const dto: CreateNodeCredentialDto = { name: 'Expiring', expiresAt: iso };

      mockPrisma.nodeCredential.create.mockResolvedValue({
        ...mockCredentialRecord,
        expiresAt: new Date(iso),
      } as any);

      const result = await service.createCredential(mockUserId, dto);

      const callArg = (mockPrisma.nodeCredential.create as jest.Mock).mock.calls[0][0];
      expect(callArg.data.expiresAt).toEqual(new Date(iso));
      expect(result.expiresAt).toBe(iso);
    });

    it('should pass correct userId and name to Prisma create and return the shape', async () => {
      const dto: CreateNodeCredentialDto = { name: 'Named' };

      mockPrisma.nodeCredential.create.mockResolvedValue(mockCredentialRecord as any);

      const result = await service.createCredential(mockUserId, dto);

      expect(mockPrisma.nodeCredential.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: mockUserId, name: 'Named' }),
      });
      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('id', mockCredentialRecord.id);
      expect(result).toHaveProperty('name', mockCredentialRecord.name);
      expect(result).toHaveProperty('tokenPrefix', mockCredentialRecord.tokenPrefix);
      expect(typeof result.createdAt).toBe('string'); // ISO string
    });
  });

  // ============================================================================
  // listForUser
  // ============================================================================

  describe('listForUser', () => {
    it('should call findMany owner-scoped, newest first, without the hash', async () => {
      mockPrisma.nodeCredential.findMany.mockResolvedValue([mockCredentialRecord] as any);

      const result = await service.listForUser(mockUserId);

      expect(mockPrisma.nodeCredential.findMany).toHaveBeenCalledWith({
        where: { userId: mockUserId },
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
      expect(result).toHaveLength(1);
    });

    it('should return empty array when user has no credentials', async () => {
      mockPrisma.nodeCredential.findMany.mockResolvedValue([]);

      const result = await service.listForUser(mockUserId);

      expect(result).toEqual([]);
    });
  });

  // ============================================================================
  // revoke (owner-scoped)
  // ============================================================================

  describe('revoke', () => {
    it('should set revokedAt on the credential (ownership-checked lookup)', async () => {
      mockPrisma.nodeCredential.findFirst.mockResolvedValue(mockCredentialRecord as any);
      mockPrisma.nodeCredential.update.mockResolvedValue({
        ...mockCredentialRecord,
        revokedAt: new Date(),
      } as any);

      await service.revoke(mockUserId, mockCredentialRecord.id);

      expect(mockPrisma.nodeCredential.findFirst).toHaveBeenCalledWith({
        where: { id: mockCredentialRecord.id, userId: mockUserId },
      });
      expect(mockPrisma.nodeCredential.update).toHaveBeenCalledWith({
        where: { id: mockCredentialRecord.id },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('should throw NotFoundException when credential not found (or not owned)', async () => {
      mockPrisma.nodeCredential.findFirst.mockResolvedValue(null);

      await expect(service.revoke(mockUserId, 'nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException when credential is already revoked', async () => {
      mockPrisma.nodeCredential.findFirst.mockResolvedValue({
        ...mockCredentialRecord,
        revokedAt: new Date(Date.now() - 3600000),
      } as any);

      await expect(service.revoke(mockUserId, mockCredentialRecord.id)).rejects.toThrow(
        'Credential already revoked',
      );
      expect(mockPrisma.nodeCredential.update).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // listAll / revokeAny (admin)
  // ============================================================================

  describe('listAll', () => {
    it('should return all credentials annotated with owner email/display name', async () => {
      mockPrisma.nodeCredential.findMany.mockResolvedValue([
        {
          ...mockCredentialRecord,
          user: { email: 'owner@example.com', displayName: 'Owner' },
        },
      ] as any);

      const result = await service.listAll();

      expect(result).toEqual([
        expect.objectContaining({
          id: mockCredentialRecord.id,
          userId: mockUserId,
          ownerEmail: 'owner@example.com',
          ownerDisplayName: 'Owner',
        }),
      ]);
      // The flattened rows never carry the hash
      expect(result[0]).not.toHaveProperty('tokenHash');
    });
  });

  describe('revokeAny', () => {
    it('should revoke regardless of owner', async () => {
      mockPrisma.nodeCredential.findUnique.mockResolvedValue(mockCredentialRecord as any);
      mockPrisma.nodeCredential.update.mockResolvedValue({
        ...mockCredentialRecord,
        revokedAt: new Date(),
      } as any);

      await service.revokeAny(mockCredentialRecord.id);

      expect(mockPrisma.nodeCredential.findUnique).toHaveBeenCalledWith({
        where: { id: mockCredentialRecord.id },
      });
      expect(mockPrisma.nodeCredential.update).toHaveBeenCalledWith({
        where: { id: mockCredentialRecord.id },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('should throw NotFoundException for unknown or already-revoked credentials', async () => {
      mockPrisma.nodeCredential.findUnique.mockResolvedValue(null);
      await expect(service.revokeAny('nope')).rejects.toThrow(NotFoundException);

      mockPrisma.nodeCredential.findUnique.mockResolvedValue({
        ...mockCredentialRecord,
        revokedAt: new Date(),
      } as any);
      await expect(service.revokeAny(mockCredentialRecord.id)).rejects.toThrow(
        'Credential already revoked',
      );
    });
  });

  // ============================================================================
  // validateToken
  // ============================================================================

  describe('validateToken', () => {
    it('should return user for a valid credential with NULL expiresAt (never expires)', async () => {
      const rawToken = 'nod_' + 'a'.repeat(64);

      mockPrisma.nodeCredential.findUnique.mockResolvedValue({
        ...mockCredentialRecord,
        expiresAt: null,
        user: mockUserWithRelations,
      } as any);
      mockPrisma.nodeCredential.update.mockResolvedValue(mockCredentialRecord as any);

      const result = await service.validateToken(rawToken);

      expect(result).not.toBeNull();
      expect(result).toMatchObject({ id: mockUserId, email: 'test@example.com' });
    });

    it('should compute SHA256 hash of the raw token before lookup', async () => {
      const rawToken = 'nod_' + 'b'.repeat(64);
      const expectedHash = createHash('sha256').update(rawToken).digest('hex');

      mockPrisma.nodeCredential.findUnique.mockResolvedValue(null);

      await service.validateToken(rawToken);

      expect(mockPrisma.nodeCredential.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: expectedHash } }),
      );
    });

    it('should return null for unknown tokens', async () => {
      mockPrisma.nodeCredential.findUnique.mockResolvedValue(null);

      expect(await service.validateToken('nod_unknown')).toBeNull();
    });

    it('should return null when the credential is expired (non-null past expiresAt)', async () => {
      mockPrisma.nodeCredential.findUnique.mockResolvedValue({
        ...mockCredentialRecord,
        expiresAt: new Date(Date.now() - 86400000),
        user: mockUserWithRelations,
      } as any);

      expect(await service.validateToken('nod_expired')).toBeNull();
    });

    it('should accept a credential with a future expiresAt', async () => {
      mockPrisma.nodeCredential.findUnique.mockResolvedValue({
        ...mockCredentialRecord,
        expiresAt: new Date(Date.now() + 86400000),
        user: mockUserWithRelations,
      } as any);
      mockPrisma.nodeCredential.update.mockResolvedValue(mockCredentialRecord as any);

      expect(await service.validateToken('nod_future')).not.toBeNull();
    });

    it('should return null when the credential is revoked', async () => {
      mockPrisma.nodeCredential.findUnique.mockResolvedValue({
        ...mockCredentialRecord,
        revokedAt: new Date(Date.now() - 3600000),
        user: mockUserWithRelations,
      } as any);

      expect(await service.validateToken('nod_revoked')).toBeNull();
    });

    it('should return null when the owning user is inactive', async () => {
      mockPrisma.nodeCredential.findUnique.mockResolvedValue({
        ...mockCredentialRecord,
        user: { ...mockUserWithRelations, isActive: false },
      } as any);

      expect(await service.validateToken('nod_inactive')).toBeNull();
    });

    it('should eager-load user roles/permissions for RBAC in the findUnique query', async () => {
      mockPrisma.nodeCredential.findUnique.mockResolvedValue(null);

      await service.validateToken('nod_x');

      expect(mockPrisma.nodeCredential.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
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
        }),
      );
    });

    it('should best-effort update lastUsedAt on successful validation', async () => {
      mockPrisma.nodeCredential.findUnique.mockResolvedValue({
        ...mockCredentialRecord,
        user: mockUserWithRelations,
      } as any);
      mockPrisma.nodeCredential.update.mockResolvedValue(mockCredentialRecord as any);

      await service.validateToken('nod_used');

      expect(mockPrisma.nodeCredential.update).toHaveBeenCalledWith({
        where: { id: mockCredentialRecord.id },
        data: { lastUsedAt: expect.any(Date) },
      });
    });
  });
});
