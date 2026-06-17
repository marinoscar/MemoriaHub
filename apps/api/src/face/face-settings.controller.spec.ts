/**
 * Unit tests for FaceSettingsController.
 *
 * Verifies that each handler delegates correctly to FaceSettingsService.
 * No real HTTP, no database — pure delegation tests.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { FaceSettingsController } from './face-settings.controller';
import { FaceSettingsService } from './face-settings.service';

// ---------------------------------------------------------------------------
// Mock FaceSettingsService
// ---------------------------------------------------------------------------

const mockFaceSettingsService = {
  getSettings: jest.fn(),
  upsertCredential: jest.fn(),
  deleteCredential: jest.fn(),
  testProvider: jest.fn(),
  listModels: jest.fn(),
  setDetectionFeature: jest.fn(),
};

describe('FaceSettingsController', () => {
  let controller: FaceSettingsController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FaceSettingsController],
      providers: [
        { provide: FaceSettingsService, useValue: mockFaceSettingsService },
      ],
    })
      // Override guards to allow testing without auth infrastructure
      .overrideGuard(require('../auth/guards/jwt-auth.guard').JwtAuthGuard ?? Object)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<FaceSettingsController>(FaceSettingsController);
  });

  // -------------------------------------------------------------------------
  // GET face/settings
  // -------------------------------------------------------------------------
  describe('getSettings', () => {
    it('delegates to faceSettingsService.getSettings()', async () => {
      const mockResult = {
        providers: [],
        knownProviders: [],
        features: { detection: { provider: null, model: null } },
      };
      mockFaceSettingsService.getSettings.mockResolvedValue(mockResult);

      const result = await controller.getSettings();

      expect(mockFaceSettingsService.getSettings).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockResult);
    });
  });

  // -------------------------------------------------------------------------
  // PUT face/credentials/:provider
  // -------------------------------------------------------------------------
  describe('upsertCredentials', () => {
    it('delegates to faceSettingsService.upsertCredential with correct args', async () => {
      const mockResult = {
        provider: 'compreface',
        configured: true,
        enabled: true,
        last4: 'abcd',
        baseUrl: 'http://cf:8000',
        region: null,
      };
      mockFaceSettingsService.upsertCredential.mockResolvedValue(mockResult);

      const dto = { apiKey: 'key-abcd', baseUrl: 'http://cf:8000', enabled: true };
      const result = await controller.upsertCredentials('compreface', dto as any, 'user-1');

      expect(mockFaceSettingsService.upsertCredential).toHaveBeenCalledWith(
        'compreface',
        dto,
        'user-1',
      );
      expect(result).toEqual(mockResult);
    });

    it('passes region to upsertCredential', async () => {
      mockFaceSettingsService.upsertCredential.mockResolvedValue({
        provider: 'rekognition',
        configured: true,
        enabled: true,
        last4: '',
        baseUrl: null,
        region: 'us-west-2',
      });

      const dto = { region: 'us-west-2', enabled: true };
      await controller.upsertCredentials('rekognition', dto as any, 'user-1');

      expect(mockFaceSettingsService.upsertCredential).toHaveBeenCalledWith(
        'rekognition',
        dto,
        'user-1',
      );
    });
  });

  // -------------------------------------------------------------------------
  // DELETE face/credentials/:provider
  // -------------------------------------------------------------------------
  describe('deleteCredentials', () => {
    it('delegates to faceSettingsService.deleteCredential and returns {deleted:true, provider}', async () => {
      mockFaceSettingsService.deleteCredential.mockResolvedValue(undefined);

      const result = await controller.deleteCredentials('compreface', 'user-1');

      expect(mockFaceSettingsService.deleteCredential).toHaveBeenCalledWith('compreface', 'user-1');
      expect(result).toEqual({ deleted: true, provider: 'compreface' });
    });
  });

  // -------------------------------------------------------------------------
  // POST face/test
  // -------------------------------------------------------------------------
  describe('testProvider', () => {
    it('delegates to faceSettingsService.testProvider and returns result', async () => {
      const testResult = { ok: true };
      mockFaceSettingsService.testProvider.mockResolvedValue(testResult);

      const dto = { provider: 'compreface' };
      const result = await controller.testProvider(dto as any);

      expect(mockFaceSettingsService.testProvider).toHaveBeenCalledWith(dto);
      expect(result).toEqual(testResult);
    });

    it('returns ok:false result from testProvider', async () => {
      const testResult = { ok: false, error: 'Connection refused' };
      mockFaceSettingsService.testProvider.mockResolvedValue(testResult);

      const dto = { provider: 'compreface' };
      const result = await controller.testProvider(dto as any);

      expect(result).toEqual(testResult);
    });
  });

  // -------------------------------------------------------------------------
  // GET face/models
  // -------------------------------------------------------------------------
  describe('listModels', () => {
    it('delegates to faceSettingsService.listModels with provider query param', async () => {
      const models = ['arcface-r100-v1'];
      mockFaceSettingsService.listModels.mockResolvedValue(models);

      const result = await controller.listModels('compreface');

      expect(mockFaceSettingsService.listModels).toHaveBeenCalledWith('compreface');
      expect(result).toEqual(models);
    });
  });

  // -------------------------------------------------------------------------
  // PUT face/features/detection
  // -------------------------------------------------------------------------
  describe('setDetectionFeature', () => {
    it('delegates to faceSettingsService.setDetectionFeature and returns result', async () => {
      const featureResult = { provider: 'compreface', model: 'arcface-r100-v1' };
      mockFaceSettingsService.setDetectionFeature.mockResolvedValue(featureResult);

      const dto = { provider: 'compreface', model: 'arcface-r100-v1' };
      const result = await controller.setDetectionFeature(dto as any, 'user-1');

      expect(mockFaceSettingsService.setDetectionFeature).toHaveBeenCalledWith(dto, 'user-1');
      expect(result).toEqual(featureResult);
    });
  });
});
