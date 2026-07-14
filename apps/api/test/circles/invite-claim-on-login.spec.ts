import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { CircleRole } from '@prisma/client';

import { AuthService } from '../../src/auth/auth.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AdminBootstrapService } from '../../src/common/services/admin-bootstrap.service';
import { AllowlistService } from '../../src/allowlist/allowlist.service';
import { EmailService } from '../../src/email/email.service';
import { createMockPrismaService, MockPrismaService } from '../mocks/prisma.mock';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// A minimal Google profile that satisfies GoogleProfile
// ---------------------------------------------------------------------------
function makeGoogleProfile(overrides: Partial<any> = {}): any {
  return {
    id: 'google-sub-001',
    email: 'alice@example.com',
    displayName: 'Alice',
    picture: 'https://lh3.googleusercontent.com/alice.jpg',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A minimal User with userRoles (needed by generateFullTokens)
// ---------------------------------------------------------------------------
function makeUser(overrides: Partial<any> = {}) {
  return {
    id: randomUUID(),
    email: 'alice@example.com',
    displayName: null,
    providerDisplayName: 'Alice',
    providerProfileImageUrl: 'https://lh3.googleusercontent.com/alice.jpg',
    profileImageUrl: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    userRoles: [
      { role: { name: 'viewer', rolePermissions: [] } },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A CircleInvite row
// ---------------------------------------------------------------------------
function makeCircleInvite(overrides: Partial<any> = {}) {
  return {
    id: randomUUID(),
    circleId: 'circle-001',
    email: 'alice@example.com',
    role: 'viewer' as CircleRole,
    invitedById: 'admin-user',
    claimedAt: null,
    claimedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Invite Claim on Login (AuthService.handleGoogleLogin)', () => {
  let service: AuthService;
  let mockPrisma: MockPrismaService;
  let mockJwtService: jest.Mocked<JwtService>;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockAdminBootstrapService: { shouldGrantAdminRole: jest.Mock };
  let mockAllowlistService: { isEmailAllowed: jest.Mock; markEmailClaimed: jest.Mock };
  let mockEmailService: { sendEmail: jest.Mock; sendEmailAsync: jest.Mock };

  // Shared constants
  const CIRCLE_ID = 'circle-001';
  const EXISTING_USER_ID = 'user-existing-001';

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    mockJwtService = {
      sign: jest.fn().mockReturnValue('mock-access-token'),
      signAsync: jest.fn().mockResolvedValue('mock-access-token'),
    } as any;

    mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'jwt.accessTtlMinutes') return 15;
        if (key === 'jwt.refreshTtlDays') return 14;
        if (key === 'INITIAL_ADMIN_EMAIL') return undefined;
        return undefined;
      }),
    } as any;

    mockAdminBootstrapService = {
      shouldGrantAdminRole: jest.fn().mockResolvedValue(false),
    };

    mockAllowlistService = {
      isEmailAllowed: jest.fn().mockResolvedValue(true),
      markEmailClaimed: jest.fn().mockResolvedValue(undefined),
    };

    mockEmailService = {
      sendEmail: jest.fn().mockResolvedValue({ success: true, messageId: 'mock-message-id' }),
      sendEmailAsync: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AdminBootstrapService, useValue: mockAdminBootstrapService },
        { provide: AllowlistService, useValue: mockAllowlistService },
        { provide: EmailService, useValue: mockEmailService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Helpers — set up the "identity already exists" happy-path mocks so that
  // handleGoogleLogin gets to the claimPendingCircleInvites call.
  // ---------------------------------------------------------------------------

  function setupExistingUserIdentity(user = makeUser({ id: EXISTING_USER_ID })) {
    // Identity found → user exists
    mockPrisma.userIdentity.findUnique.mockResolvedValue({
      provider: 'google',
      providerSubject: 'google-sub-001',
      user,
    } as any);

    // Update provider profile info
    mockPrisma.user.update.mockResolvedValue(user as any);

    // Refresh token creation
    mockPrisma.refreshToken.create.mockResolvedValue({
      id: randomUUID(),
      userId: user.id,
      tokenHash: 'hashed',
      expiresAt: new Date(Date.now() + 86400000 * 14),
      revokedAt: null,
      createdAt: new Date(),
    } as any);
  }

  function setupTransactionToExecuteCallback() {
    // $transaction with a callback → immediately invoke it with the mock prisma client
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => {
      if (typeof fn === 'function') {
        return fn(mockPrisma);
      }
      return Promise.all(fn);
    });
  }

  // =========================================================================
  // Pending invite → CircleMember created + invite marked claimed
  // =========================================================================

  describe('Pending invite is claimed on login', () => {
    it('creates a CircleMember row with the invited role and marks invite as claimed', async () => {
      const user = makeUser({ id: EXISTING_USER_ID });
      setupExistingUserIdentity(user);

      const invite = makeCircleInvite({
        email: 'alice@example.com',
        circleId: CIRCLE_ID,
        role: 'collaborator' as CircleRole,
      });

      // findMany for pending invites → returns one invite
      mockPrisma.circleInvite.findMany.mockResolvedValue([invite] as any);
      setupTransactionToExecuteCallback();

      // Inside transaction: no existing member
      mockPrisma.circleMember.findUnique.mockResolvedValue(null);
      // Create member
      mockPrisma.circleMember.create.mockResolvedValue({
        circleId: CIRCLE_ID,
        userId: EXISTING_USER_ID,
        role: 'collaborator',
      } as any);
      // Mark invite claimed
      mockPrisma.circleInvite.update.mockResolvedValue({
        ...invite,
        claimedById: EXISTING_USER_ID,
        claimedAt: new Date(),
      } as any);

      const tokens = await service.handleGoogleLogin(makeGoogleProfile());

      expect(tokens.accessToken).toBe('mock-access-token');

      // circleInvite.findMany was called with email and claimedAt: null
      expect(mockPrisma.circleInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'alice@example.com', claimedAt: null },
        }),
      );

      // circleMember.create was called for the new member
      expect(mockPrisma.circleMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            circleId: CIRCLE_ID,
            userId: EXISTING_USER_ID,
            role: 'collaborator',
          }),
        }),
      );

      // circleInvite.update was called to mark it claimed
      expect(mockPrisma.circleInvite.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: invite.id },
          data: expect.objectContaining({
            claimedById: EXISTING_USER_ID,
            claimedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('does nothing when there are no pending invites for the user email', async () => {
      const user = makeUser({ id: EXISTING_USER_ID });
      setupExistingUserIdentity(user);

      mockPrisma.circleInvite.findMany.mockResolvedValue([] as any);

      const tokens = await service.handleGoogleLogin(makeGoogleProfile());

      expect(tokens.accessToken).toBe('mock-access-token');
      // No transactions should run for invite claim
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.circleMember.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Already a member — role upgrade logic
  // =========================================================================

  describe('Already a member — invite role upgrade', () => {
    it('upgrades role when invite rank is higher than existing rank', async () => {
      const user = makeUser({ id: EXISTING_USER_ID });
      setupExistingUserIdentity(user);

      // Invite with circle_admin role (rank 3), existing member is viewer (rank 1)
      const invite = makeCircleInvite({
        email: 'alice@example.com',
        circleId: CIRCLE_ID,
        role: 'circle_admin' as CircleRole,
      });
      mockPrisma.circleInvite.findMany.mockResolvedValue([invite] as any);
      setupTransactionToExecuteCallback();

      // Existing member has viewer role (rank 1)
      mockPrisma.circleMember.findUnique.mockResolvedValue({
        circleId: CIRCLE_ID,
        userId: EXISTING_USER_ID,
        role: 'viewer' as CircleRole,
      } as any);
      mockPrisma.circleMember.update.mockResolvedValue({
        circleId: CIRCLE_ID,
        userId: EXISTING_USER_ID,
        role: 'circle_admin',
      } as any);
      mockPrisma.circleInvite.update.mockResolvedValue({
        ...invite,
        claimedById: EXISTING_USER_ID,
        claimedAt: new Date(),
      } as any);

      await service.handleGoogleLogin(makeGoogleProfile());

      // Should upgrade via update, not create
      expect(mockPrisma.circleMember.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { circleId_userId: { circleId: CIRCLE_ID, userId: EXISTING_USER_ID } },
          data: { role: 'circle_admin' },
        }),
      );
      expect(mockPrisma.circleMember.create).not.toHaveBeenCalled();
    });

    it('does NOT downgrade role when existing rank is higher than invite rank', async () => {
      const user = makeUser({ id: EXISTING_USER_ID });
      setupExistingUserIdentity(user);

      // Invite with viewer role (rank 1), existing member is circle_admin (rank 3)
      const invite = makeCircleInvite({
        email: 'alice@example.com',
        circleId: CIRCLE_ID,
        role: 'viewer' as CircleRole,
      });
      mockPrisma.circleInvite.findMany.mockResolvedValue([invite] as any);
      setupTransactionToExecuteCallback();

      // Existing member has circle_admin role (rank 3 — higher than invite's viewer rank 1)
      mockPrisma.circleMember.findUnique.mockResolvedValue({
        circleId: CIRCLE_ID,
        userId: EXISTING_USER_ID,
        role: 'circle_admin' as CircleRole,
      } as any);
      mockPrisma.circleInvite.update.mockResolvedValue({
        ...invite,
        claimedById: EXISTING_USER_ID,
        claimedAt: new Date(),
      } as any);

      await service.handleGoogleLogin(makeGoogleProfile());

      // Role must NOT be changed — no update, no create
      expect(mockPrisma.circleMember.update).not.toHaveBeenCalled();
      expect(mockPrisma.circleMember.create).not.toHaveBeenCalled();

      // Invite is still marked claimed
      expect(mockPrisma.circleInvite.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: invite.id },
          data: expect.objectContaining({ claimedById: EXISTING_USER_ID }),
        }),
      );
    });

    it('does not upgrade when invite rank equals existing rank (no-op)', async () => {
      const user = makeUser({ id: EXISTING_USER_ID });
      setupExistingUserIdentity(user);

      // Both invite and existing are collaborator (rank 2)
      const invite = makeCircleInvite({
        email: 'alice@example.com',
        circleId: CIRCLE_ID,
        role: 'collaborator' as CircleRole,
      });
      mockPrisma.circleInvite.findMany.mockResolvedValue([invite] as any);
      setupTransactionToExecuteCallback();

      mockPrisma.circleMember.findUnique.mockResolvedValue({
        circleId: CIRCLE_ID,
        userId: EXISTING_USER_ID,
        role: 'collaborator' as CircleRole,
      } as any);
      mockPrisma.circleInvite.update.mockResolvedValue({
        ...invite,
        claimedById: EXISTING_USER_ID,
        claimedAt: new Date(),
      } as any);

      await service.handleGoogleLogin(makeGoogleProfile());

      // No role change (equal ranks → no upgrade needed)
      expect(mockPrisma.circleMember.update).not.toHaveBeenCalled();
      expect(mockPrisma.circleMember.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Email not in allowlist → login denied before invite processing
  // =========================================================================

  describe('Allowlist gate prevents invite claim when email is not allowed', () => {
    it('throws ForbiddenException before any invite processing when email not in allowlist', async () => {
      mockAllowlistService.isEmailAllowed.mockResolvedValue(false);
      mockConfigService.get.mockReturnValue(undefined); // no INITIAL_ADMIN_EMAIL

      await expect(
        service.handleGoogleLogin(makeGoogleProfile()),
      ).rejects.toThrow(ForbiddenException);

      // No invite lookup should occur
      expect(mockPrisma.circleInvite.findMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Multiple invites are all claimed
  // =========================================================================

  describe('Multiple pending invites are all claimed in one login', () => {
    it('processes all pending invites and creates a member row for each', async () => {
      const user = makeUser({ id: EXISTING_USER_ID });
      setupExistingUserIdentity(user);

      const CIRCLE_2 = 'circle-002';
      const invite1 = makeCircleInvite({ email: 'alice@example.com', circleId: CIRCLE_ID, role: 'viewer' as CircleRole });
      const invite2 = makeCircleInvite({ email: 'alice@example.com', circleId: CIRCLE_2, role: 'collaborator' as CircleRole });

      mockPrisma.circleInvite.findMany.mockResolvedValue([invite1, invite2] as any);
      setupTransactionToExecuteCallback();

      // Neither invite has an existing member
      mockPrisma.circleMember.findUnique.mockResolvedValue(null);
      mockPrisma.circleMember.create.mockResolvedValue({} as any);
      mockPrisma.circleInvite.update.mockResolvedValue({} as any);

      await service.handleGoogleLogin(makeGoogleProfile());

      // Two transactions should have run (one per invite)
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
      expect(mockPrisma.circleMember.create).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Email graceful degradation
  // =========================================================================

  describe('Email failures never block invite claim on login', () => {
    it('still claims the invite and completes login when EmailService.sendEmailAsync throws', async () => {
      const user = makeUser({ id: EXISTING_USER_ID });
      setupExistingUserIdentity(user);

      const invite = makeCircleInvite({
        email: 'alice@example.com',
        circleId: CIRCLE_ID,
        role: 'collaborator' as CircleRole,
      });
      mockPrisma.circleInvite.findMany.mockResolvedValue([invite] as any);
      setupTransactionToExecuteCallback();

      mockPrisma.circleMember.findUnique.mockResolvedValue(null);
      mockPrisma.circleMember.create.mockResolvedValue({
        circleId: CIRCLE_ID,
        userId: EXISTING_USER_ID,
        role: 'collaborator',
      } as any);
      mockPrisma.circleInvite.update.mockResolvedValue({
        ...invite,
        claimedById: EXISTING_USER_ID,
        claimedAt: new Date(),
      } as any);

      // The membership-confirmation email lookup succeeds, but the send itself throws.
      mockPrisma.circle.findUnique.mockResolvedValue({
        name: 'Test Circle',
        description: null,
      } as any);
      mockEmailService.sendEmailAsync.mockImplementation(() => {
        throw new Error('email provider exploded');
      });

      const tokens = await service.handleGoogleLogin(makeGoogleProfile());

      expect(tokens.accessToken).toBe('mock-access-token');
      expect(mockPrisma.circleInvite.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: invite.id },
          data: expect.objectContaining({ claimedById: EXISTING_USER_ID }),
        }),
      );
      expect(mockEmailService.sendEmailAsync).toHaveBeenCalled();
    });
  });
});
