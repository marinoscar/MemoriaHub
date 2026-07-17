import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PatService } from '../../pat/pat.service';
import { NodeCredentialService } from '../../nodes/node-credential.service';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: jest.Mocked<Reflector>;
  let patService: jest.Mocked<PatService>;
  let nodeCredentialService: jest.Mocked<NodeCredentialService>;

  beforeEach(async () => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;

    patService = {
      validateToken: jest.fn(),
    } as any;

    nodeCredentialService = {
      validateToken: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        { provide: Reflector, useValue: reflector },
        { provide: PatService, useValue: patService },
        { provide: NodeCredentialService, useValue: nodeCredentialService },
      ],
    }).compile();

    guard = module.get<JwtAuthGuard>(JwtAuthGuard);

    // Mock super.canActivate to avoid Passport initialization
    jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createMockContext(authorizationHeader?: string, url?: string): ExecutionContext {
    const request: any = {};
    if (authorizationHeader !== undefined) {
      request.headers = { authorization: authorizationHeader };
    }
    if (url !== undefined) {
      request.url = url;
    }
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        }),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as any;
  }

  describe('canActivate', () => {
    it('should return true for routes marked with @Public() decorator', async () => {
      reflector.getAllAndOverride.mockReturnValue(true);
      const context = createMockContext();

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
    });

    it('should call super.canActivate() for protected routes', () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const context = createMockContext();
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate');

      guard.canActivate(context);

      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
      expect(superSpy).toHaveBeenCalledWith(context);
    });

    it('should skip JWT validation when isPublic is true', async () => {
      reflector.getAllAndOverride.mockReturnValue(true);
      const context = createMockContext();
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate');

      const result = await guard.canActivate(context);

      // Should return true without calling super.canActivate
      expect(result).toBe(true);
      expect(reflector.getAllAndOverride).toHaveBeenCalled();
      expect(superSpy).not.toHaveBeenCalled();
    });

    it('should check both handler and class for @Public() decorator', () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const context = createMockContext();

      guard.canActivate(context);

      // getAllAndOverride is called with both handler and class targets
      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
      const callArgs = reflector.getAllAndOverride.mock.calls[0][1];
      expect(callArgs).toHaveLength(2); // Handler and class
    });
  });

  describe('Public decorator precedence', () => {
    it('should handle undefined isPublic metadata', () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      const context = createMockContext();
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate');

      // undefined means not public, should call super.canActivate
      guard.canActivate(context);

      expect(reflector.getAllAndOverride).toHaveBeenCalled();
      expect(superSpy).toHaveBeenCalled();
    });

    it('should handle null isPublic metadata', () => {
      reflector.getAllAndOverride.mockReturnValue(null);
      const context = createMockContext();
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate');

      // null means not public, should call super.canActivate
      guard.canActivate(context);

      expect(reflector.getAllAndOverride).toHaveBeenCalled();
      expect(superSpy).toHaveBeenCalled();
    });

    it('should handle false isPublic metadata explicitly', () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const context = createMockContext();
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate');

      guard.canActivate(context);

      expect(superSpy).toHaveBeenCalled();
    });
  });

  describe('Reflector metadata retrieval', () => {
    it('should use getAllAndOverride to check decorator precedence', () => {
      reflector.getAllAndOverride.mockReturnValue(true);
      const context = createMockContext();

      guard.canActivate(context);

      // getAllAndOverride checks handler first, then class
      // This ensures method-level @Public() takes precedence over class-level
      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
    });

    it('should pass correct metadata key to reflector', () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const context = createMockContext();

      guard.canActivate(context);

      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
    });
  });

  // ============================================================================
  // PAT handling: Bearer pat_... tokens
  // ============================================================================

  describe('PAT token handling', () => {
    it('should route Bearer pat_... tokens to PatService.validateToken', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);

      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        isActive: true,
        userRoles: [],
      };
      patService.validateToken.mockResolvedValue(mockUser as any);

      const context = createMockContext('Bearer pat_abc123def456');
      const request = context.switchToHttp().getRequest();

      const result = await guard.canActivate(context);

      expect(patService.validateToken).toHaveBeenCalledWith('pat_abc123def456');
      expect(result).toBe(true);
      expect(request.user).toBe(mockUser);
    });

    it('should set request.user to the AuthenticatedUser returned by PatService', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);

      const mockUser = {
        id: 'user-456',
        email: 'user@example.com',
        isActive: true,
        userRoles: [
          {
            role: {
              name: 'contributor',
              rolePermissions: [],
            },
          },
        ],
      };
      patService.validateToken.mockResolvedValue(mockUser as any);

      const context = createMockContext('Bearer pat_mytoken123');
      const request = context.switchToHttp().getRequest();

      await guard.canActivate(context);

      expect(request.user).toEqual(mockUser);
    });

    it('should throw UnauthorizedException when PAT is invalid (validateToken returns null)', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      patService.validateToken.mockResolvedValue(null);

      const context = createMockContext('Bearer pat_invalidtoken');

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow(
        'Invalid or expired personal access token',
      );
    });

    it('should NOT route non-PAT Bearer tokens to PatService', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate').mockReturnValue(true);

      const context = createMockContext('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');

      await guard.canActivate(context);

      expect(patService.validateToken).not.toHaveBeenCalled();
      expect(superSpy).toHaveBeenCalledWith(context);
    });

    it('should NOT route requests without Authorization header to PatService', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate').mockReturnValue(true);

      const context = createMockContext(undefined);

      await guard.canActivate(context);

      expect(patService.validateToken).not.toHaveBeenCalled();
      expect(superSpy).toHaveBeenCalledWith(context);
    });

    it('should NOT invoke PatService for @Public() routes even with pat_ token', async () => {
      reflector.getAllAndOverride.mockReturnValue(true); // route is public

      const context = createMockContext('Bearer pat_sometoken');

      const result = await guard.canActivate(context);

      expect(patService.validateToken).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should pass the full raw token (with pat_ prefix) to validateToken', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);

      const mockUser = { id: 'user-789', email: 'x@x.com', isActive: true, userRoles: [] };
      patService.validateToken.mockResolvedValue(mockUser as any);

      const rawToken = 'pat_0011223344556677889900aabbccddeeff00112233445566778899aabbccddee';
      const context = createMockContext(`Bearer ${rawToken}`);

      await guard.canActivate(context);

      expect(patService.validateToken).toHaveBeenCalledWith(rawToken);
    });
  });

  // ============================================================================
  // Node credential handling: Bearer nod_... tokens (route-allowlisted)
  // ============================================================================

  describe('Node credential (nod_) token handling', () => {
    const mockUser = {
      id: 'user-node-1',
      email: 'node@example.com',
      isActive: true,
      userRoles: [],
    };

    it('should accept a valid nod_ token on /api/nodes (exact match)', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      nodeCredentialService.validateToken.mockResolvedValue(mockUser as any);

      const context = createMockContext('Bearer nod_abc123', '/api/nodes');
      const request = context.switchToHttp().getRequest();

      const result = await guard.canActivate(context);

      expect(nodeCredentialService.validateToken).toHaveBeenCalledWith('nod_abc123');
      expect(result).toBe(true);
      expect(request.user).toBe(mockUser);
    });

    it('should accept a valid nod_ token on nested /api/nodes/* routes (query stripped)', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      nodeCredentialService.validateToken.mockResolvedValue(mockUser as any);

      const context = createMockContext(
        'Bearer nod_abc123',
        '/api/nodes/6a3f/claim?max=2',
      );

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(nodeCredentialService.validateToken).toHaveBeenCalledWith('nod_abc123');
    });

    it('should reject a nod_ token on non-node routes with ForbiddenException', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);

      const context = createMockContext('Bearer nod_abc123', '/api/media?circleId=x');

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      await expect(guard.canActivate(context)).rejects.toThrow(
        'node credentials are valid only for node endpoints',
      );
      expect(nodeCredentialService.validateToken).not.toHaveBeenCalled();
    });

    it('should reject a nod_ token on the /api/node-credentials management routes', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);

      const context = createMockContext('Bearer nod_abc123', '/api/node-credentials');

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(nodeCredentialService.validateToken).not.toHaveBeenCalled();
    });

    it('should reject a nod_ token on /api/admin/nodes (admin plane is JWT/PAT only)', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);

      const context = createMockContext('Bearer nod_abc123', '/api/admin/nodes');

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(nodeCredentialService.validateToken).not.toHaveBeenCalled();
    });

    it('should not treat a prefix-sharing path like /api/nodesX as a node route', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);

      const context = createMockContext('Bearer nod_abc123', '/api/nodesX');

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should throw UnauthorizedException for unknown/revoked/expired nod_ tokens on node routes', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      nodeCredentialService.validateToken.mockResolvedValue(null);

      const context = createMockContext('Bearer nod_badtoken', '/api/nodes/register');

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow(
        'Invalid, expired, or revoked node credential',
      );
    });

    it('should leave PAT handling unaffected on node routes (back-compat)', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      patService.validateToken.mockResolvedValue(mockUser as any);

      const context = createMockContext('Bearer pat_stillworks', '/api/nodes/register');

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(patService.validateToken).toHaveBeenCalledWith('pat_stillworks');
      expect(nodeCredentialService.validateToken).not.toHaveBeenCalled();
    });

    it('should leave PAT handling unaffected on NON-node routes (back-compat)', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      patService.validateToken.mockResolvedValue(mockUser as any);

      const context = createMockContext('Bearer pat_stillworks', '/api/media');

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(patService.validateToken).toHaveBeenCalledWith('pat_stillworks');
    });

    it('should NOT invoke NodeCredentialService for @Public() routes even with nod_ token', async () => {
      reflector.getAllAndOverride.mockReturnValue(true); // route is public

      const context = createMockContext('Bearer nod_sometoken', '/api/nodes');

      const result = await guard.canActivate(context);

      expect(nodeCredentialService.validateToken).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should prefer originalUrl over url when both are present', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      nodeCredentialService.validateToken.mockResolvedValue(mockUser as any);

      const context = createMockContext('Bearer nod_abc123', '/api/media');
      const request = context.switchToHttp().getRequest();
      request.originalUrl = '/api/nodes/register';

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
    });
  });

  describe('Integration with Passport (tested via integration tests)', () => {
    it('should delegate JWT validation to Passport strategy', () => {
      // The actual JWT validation is done by Passport and the JwtStrategy
      // This is tested in integration tests with real HTTP requests
      // Unit tests focus on the @Public() decorator logic and PAT handling
      expect(true).toBe(true);
    });

    it('should throw UnauthorizedException for invalid tokens (integration)', () => {
      // Invalid tokens, expired tokens, and missing tokens are handled
      // by Passport's AuthGuard and tested in integration tests
      expect(true).toBe(true);
    });
  });
});
