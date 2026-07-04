/**
 * Unit tests — OneDriveController.
 *
 * Mock strategy mirrors the established convention in this codebase for
 * permission-gated controllers (see enrichment-admin.controller.spec.ts and
 * media-reprocess.controller.spec.ts): collaborator services are replaced
 * with jest mocks, the three auth guards (JwtAuthGuard/RolesGuard/
 * PermissionsGuard) are overridden to allow=true so delegation can be tested
 * without bootstrapping the full JWT/DB-backed RBAC pipeline, and RBAC wiring
 * itself is verified by asserting the @Auth-applied decorator metadata
 * (PERMISSIONS_KEY) rather than by driving real HTTP requests through the guards.
 *
 * NOTE on why this is a controller unit test rather than a full app.listen()
 * + supertest RBAC integration test: the shared test fixture
 * (test/fixtures/test-data.factory.ts, used by createMockContributorUser /
 * createMockViewerUser / createMockAdminUser across the existing integration
 * suite) does not define the `onedrive:connect` permission for ANY mock role
 * — it predates this feature. Extending that shared, widely-used fixture is
 * out of scope for adding tests to a new feature. This codebase's own
 * precedent for exactly this situation — a controller whose permission is
 * not present in the shared fixture (see EnrichmentAdminController, gated by
 * jobs:read/jobs:write, also absent from the fixture) — is this same
 * guard-override + metadata-assertion pattern, with the comment "Guard/RBAC
 * enforcement is tested in integration tests" pointing at the generic,
 * fixture-independent `permissions.guard.spec.ts` suite rather than a
 * per-controller HTTP-level RBAC test. Behavioral RBAC (403 without
 * collaborator, 400 disabled feature, 409 active run) is covered at the
 * service layer in onedrive-import.service.spec.ts, which the controller
 * delegates to untouched.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OneDriveController } from './onedrive.controller';
import { MicrosoftGraphClient } from './microsoft-graph.client';
import { OneDriveConnectionService } from './onedrive-connection.service';
import { OneDriveImportService } from './onedrive-import.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { OneDriveConnectionExpiredError, OneDriveNotConnectedError } from './onedrive.errors';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { encodeConnectState } from '../auth/utils/oauth-state.util';

const allowAllGuard = { canActivate: () => true };
const JWT_SECRET = 'test-jwt-secret-at-least-32-characters-long';
const APP_URL = 'https://app.example.com';

function makeRequestUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'user@example.com',
    roles: ['contributor'],
    permissions: ['onedrive:connect'],
    isActive: true,
    ...overrides,
  };
}

function makeFakeReply() {
  const reply: any = {};
  reply.status = jest.fn().mockReturnValue(reply);
  reply.redirect = jest.fn().mockReturnValue(reply);
  return reply;
}

describe('OneDriveController', () => {
  let controller: OneDriveController;
  let mockGraphClient: {
    buildAuthorizeUrl: jest.Mock;
    exchangeCodeForTokens: jest.Mock;
    getUserProfile: jest.Mock;
    listChildren: jest.Mock;
  };
  let mockConnectionService: {
    getStatus: jest.Mock;
    disconnect: jest.Mock;
    getFreshAccessToken: jest.Mock;
    upsertFromCallback: jest.Mock;
  };
  let mockImportService: {
    startImport: jest.Mock;
    listRuns: jest.Mock;
    getRun: jest.Mock;
    cancelRun: jest.Mock;
  };
  let mockSystemSettings: { isFeatureEnabled: jest.Mock };

  beforeEach(async () => {
    mockGraphClient = {
      buildAuthorizeUrl: jest.fn().mockReturnValue('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?mock=1'),
      exchangeCodeForTokens: jest.fn(),
      getUserProfile: jest.fn(),
      listChildren: jest.fn(),
    };
    mockConnectionService = {
      getStatus: jest.fn(),
      disconnect: jest.fn(),
      getFreshAccessToken: jest.fn(),
      upsertFromCallback: jest.fn(),
    };
    mockImportService = {
      startImport: jest.fn(),
      listRuns: jest.fn(),
      getRun: jest.fn(),
      cancelRun: jest.fn(),
    };
    mockSystemSettings = { isFeatureEnabled: jest.fn().mockResolvedValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OneDriveController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'jwt.secret') return JWT_SECRET;
              if (key === 'appUrl') return APP_URL;
              return undefined;
            },
          },
        },
        { provide: MicrosoftGraphClient, useValue: mockGraphClient },
        { provide: OneDriveConnectionService, useValue: mockConnectionService },
        { provide: OneDriveImportService, useValue: mockImportService },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
      ],
    })
      .overrideGuard(JwtAuthGuard).useValue(allowAllGuard)
      .overrideGuard(RolesGuard).useValue(allowAllGuard)
      .overrideGuard(PermissionsGuard).useValue(allowAllGuard)
      .compile();

    controller = module.get<OneDriveController>(OneDriveController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // GET /onedrive/connection, DELETE /onedrive/connection
  // =========================================================================

  describe('getConnection', () => {
    it('delegates to connectionService.getStatus(user.id)', async () => {
      mockConnectionService.getStatus.mockResolvedValue({
        connected: true,
        microsoftEmail: 'user@outlook.com',
        connectedAt: new Date('2026-01-01T00:00:00Z'),
      });

      const result = await controller.getConnection(makeRequestUser() as any);

      expect(mockConnectionService.getStatus).toHaveBeenCalledWith('user-1');
      expect(result).toEqual(
        expect.objectContaining({ connected: true, microsoftEmail: 'user@outlook.com' }),
      );
    });
  });

  describe('deleteConnection', () => {
    it('delegates to connectionService.disconnect(user.id)', async () => {
      await controller.deleteConnection(makeRequestUser() as any);

      expect(mockConnectionService.disconnect).toHaveBeenCalledWith('user-1');
    });
  });

  // =========================================================================
  // GET /onedrive/folders
  // =========================================================================

  describe('listFolders', () => {
    it('lists folders via a fresh access token and maps to {id, name, path}', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(true);
      mockConnectionService.getFreshAccessToken.mockResolvedValue('fresh-token');
      mockGraphClient.listChildren.mockResolvedValue([
        { id: 'folder-1', name: 'Photos', path: '/Photos', size: 0, isFolder: true, mimeType: null },
      ]);

      const result = await controller.listFolders(makeRequestUser() as any, { path: undefined } as any);

      expect(mockGraphClient.listChildren).toHaveBeenCalledWith('fresh-token', null, { foldersOnly: true });
      expect(result).toEqual([{ id: 'folder-1', name: 'Photos', path: '/Photos' }]);
    });

    it('throws BadRequestException when the feature is disabled', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(false);

      await expect(
        controller.listFolders(makeRequestUser() as any, {} as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('maps OneDriveNotConnectedError to BadRequestException', async () => {
      mockConnectionService.getFreshAccessToken.mockRejectedValue(new OneDriveNotConnectedError());

      await expect(
        controller.listFolders(makeRequestUser() as any, {} as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('maps OneDriveConnectionExpiredError to BadRequestException', async () => {
      mockConnectionService.getFreshAccessToken.mockRejectedValue(
        new OneDriveConnectionExpiredError(),
      );

      await expect(
        controller.listFolders(makeRequestUser() as any, {} as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // POST /onedrive/import, GET /onedrive/import/runs[/:id], POST .../cancel
  // =========================================================================

  describe('startImport', () => {
    it('delegates to importService.startImport with the mapped body', async () => {
      mockImportService.startImport.mockResolvedValue({ runId: 'run-1', totalCount: 3 });

      const result = await controller.startImport(makeRequestUser() as any, {
        circleId: 'circle-1',
        remoteFolderPath: '/Photos',
        recursive: true,
      } as any);

      expect(mockImportService.startImport).toHaveBeenCalledWith('user-1', ['onedrive:connect'], {
        circleId: 'circle-1',
        remoteFolderPath: '/Photos',
        recursive: true,
      });
      expect(result).toEqual({ runId: 'run-1', totalCount: 3 });
    });

    it('propagates errors thrown by importService.startImport untouched (400/403/409 originate at the service layer)', async () => {
      mockImportService.startImport.mockRejectedValue(new BadRequestException('OneDrive Data Import is disabled'));

      await expect(
        controller.startImport(makeRequestUser() as any, { circleId: 'circle-1' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('listImportRuns', () => {
    it('delegates to importService.listRuns with user id and query params', async () => {
      mockImportService.listRuns.mockResolvedValue({ items: [], meta: {} });

      await controller.listImportRuns(makeRequestUser() as any, { page: 2, pageSize: 10 } as any);

      expect(mockImportService.listRuns).toHaveBeenCalledWith('user-1', 2, 10);
    });
  });

  describe('getImportRun', () => {
    it('delegates to importService.getRun with user id and run id', async () => {
      mockImportService.getRun.mockResolvedValue({ id: 'run-1' });

      const result = await controller.getImportRun(makeRequestUser() as any, 'run-1');

      expect(mockImportService.getRun).toHaveBeenCalledWith('user-1', 'run-1');
      expect(result).toEqual({ id: 'run-1' });
    });
  });

  describe('cancelImportRun', () => {
    it('delegates to importService.cancelRun with user id and run id', async () => {
      mockImportService.cancelRun.mockResolvedValue({ id: 'run-1', status: 'cancelled' });

      const result = await controller.cancelImportRun(makeRequestUser() as any, 'run-1');

      expect(mockImportService.cancelRun).toHaveBeenCalledWith('user-1', 'run-1');
      expect(result).toEqual({ id: 'run-1', status: 'cancelled' });
    });
  });

  // =========================================================================
  // GET /onedrive/auth/start
  // =========================================================================

  describe('authStart', () => {
    it('redirects (302) to the Microsoft authorize URL when the feature is enabled', async () => {
      const reply = makeFakeReply();

      await controller.authStart(makeRequestUser() as any, reply, undefined);

      expect(mockGraphClient.buildAuthorizeUrl).toHaveBeenCalledTimes(1);
      expect(reply.status).toHaveBeenCalledWith(302);
      expect(reply.redirect).toHaveBeenCalledWith(
        'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?mock=1',
      );
    });

    it('throws BadRequestException (fails closed) when the feature is disabled, without building a URL', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(false);
      const reply = makeFakeReply();

      await expect(
        controller.authStart(makeRequestUser() as any, reply, undefined),
      ).rejects.toThrow(BadRequestException);
      expect(mockGraphClient.buildAuthorizeUrl).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GET /onedrive/auth/callback (Public)
  // =========================================================================

  describe('authCallback', () => {
    it('redirects with error=feature_disabled when the feature is disabled', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(false);
      const reply = makeFakeReply();

      await controller.authCallback(reply, 'auth-code', 'irrelevant-state', undefined);

      const redirectUrl = new URL(reply.redirect.mock.calls[0][0]);
      expect(redirectUrl.searchParams.get('error')).toBe('feature_disabled');
    });

    it('redirects with error=access_denied when Microsoft reports an OAuth error', async () => {
      const reply = makeFakeReply();

      await controller.authCallback(reply, undefined, undefined, 'access_denied');

      const redirectUrl = new URL(reply.redirect.mock.calls[0][0]);
      expect(redirectUrl.searchParams.get('error')).toBe('access_denied');
      expect(mockGraphClient.exchangeCodeForTokens).not.toHaveBeenCalled();
    });

    it('redirects with error=missing_code when no code is present', async () => {
      const reply = makeFakeReply();
      const state = encodeConnectState({ userId: 'user-1' }, JWT_SECRET);

      await controller.authCallback(reply, undefined, state, undefined);

      const redirectUrl = new URL(reply.redirect.mock.calls[0][0]);
      expect(redirectUrl.searchParams.get('error')).toBe('missing_code');
    });

    it('redirects with error=invalid_state when the signed state does not verify', async () => {
      const reply = makeFakeReply();

      await controller.authCallback(reply, 'auth-code', 'tampered.state', undefined);

      const redirectUrl = new URL(reply.redirect.mock.calls[0][0]);
      expect(redirectUrl.searchParams.get('error')).toBe('invalid_state');
      expect(mockGraphClient.exchangeCodeForTokens).not.toHaveBeenCalled();
    });

    it('happy path: exchanges the code, fetches the profile, upserts the connection, and redirects with connected=1', async () => {
      const reply = makeFakeReply();
      const state = encodeConnectState({ userId: 'user-1' }, JWT_SECRET);
      const tokens = { accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, scopes: 'offline_access Files.Read User.Read' };
      mockGraphClient.exchangeCodeForTokens.mockResolvedValue(tokens);
      mockGraphClient.getUserProfile.mockResolvedValue({ id: 'ms-1', email: 'user@outlook.com' });

      await controller.authCallback(reply, 'auth-code', state, undefined);

      expect(mockGraphClient.exchangeCodeForTokens).toHaveBeenCalledWith('auth-code');
      expect(mockGraphClient.getUserProfile).toHaveBeenCalledWith('at');
      expect(mockConnectionService.upsertFromCallback).toHaveBeenCalledWith(
        'user-1',
        tokens,
        { id: 'ms-1', email: 'user@outlook.com' },
      );

      const redirectUrl = new URL(reply.redirect.mock.calls[0][0]);
      expect(redirectUrl.searchParams.get('connected')).toBe('1');
    });

    it('redirects with error=connect_failed when the token exchange throws', async () => {
      const reply = makeFakeReply();
      const state = encodeConnectState({ userId: 'user-1' }, JWT_SECRET);
      mockGraphClient.exchangeCodeForTokens.mockRejectedValue(new Error('Microsoft token request failed'));

      await controller.authCallback(reply, 'auth-code', state, undefined);

      const redirectUrl = new URL(reply.redirect.mock.calls[0][0]);
      expect(redirectUrl.searchParams.get('error')).toBe('connect_failed');
    });
  });

  // =========================================================================
  // @Auth metadata wiring — every endpoint requires onedrive:connect
  // =========================================================================

  describe('@Auth metadata wiring — PERMISSIONS.ONEDRIVE_CONNECT required', () => {
    const cases: Array<[string, keyof OneDriveController]> = [
      ['authStart', 'authStart'],
      ['getConnection', 'getConnection'],
      ['deleteConnection', 'deleteConnection'],
      ['listFolders', 'listFolders'],
      ['startImport', 'startImport'],
      ['listImportRuns', 'listImportRuns'],
      ['getImportRun', 'getImportRun'],
      ['cancelImportRun', 'cancelImportRun'],
    ];

    it.each(cases)('%s requires PERMISSIONS.ONEDRIVE_CONNECT', (_label, methodName) => {
      const permissions: string[] = Reflect.getMetadata(
        PERMISSIONS_KEY,
        (controller as any)[methodName],
      );
      expect(permissions).toContain(PERMISSIONS.ONEDRIVE_CONNECT);
    });

    it('authCallback is NOT gated by PERMISSIONS_KEY metadata (it is @Public() — no app JWT exists yet)', () => {
      const permissions: string[] | undefined = Reflect.getMetadata(
        PERMISSIONS_KEY,
        controller.authCallback,
      );
      expect(permissions).toBeUndefined();
    });
  });
});
