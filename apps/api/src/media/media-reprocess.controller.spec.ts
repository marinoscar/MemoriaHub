/**
 * Unit tests — MediaReprocessController
 *
 * Mock strategy: MediaReprocessService is replaced with a jest mock.
 * Auth guards (JwtAuthGuard, RolesGuard, PermissionsGuard) are overridden to
 * allow=true so we can test method delegation without auth infrastructure.
 * HTTP-level auth enforcement is tested in integration tests, not here.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { MediaReprocessController, ReprocessBodyDto } from './media-reprocess.controller';
import { MediaReprocessService } from './media-reprocess.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';

const allowAllGuard = { canActivate: () => true };

describe('MediaReprocessController', () => {
  let controller: MediaReprocessController;
  let mockReprocessCircle: jest.Mock;

  beforeEach(async () => {
    mockReprocessCircle = jest.fn().mockResolvedValue({ reprocessed: 3, failed: 0 });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MediaReprocessController],
      providers: [
        {
          provide: MediaReprocessService,
          useValue: {
            reprocessCircle: mockReprocessCircle,
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard).useValue(allowAllGuard)
      .overrideGuard(RolesGuard).useValue(allowAllGuard)
      .overrideGuard(PermissionsGuard).useValue(allowAllGuard)
      .compile();

    controller = module.get<MediaReprocessController>(MediaReprocessController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // reprocess — delegation to service
  // -------------------------------------------------------------------------

  describe('reprocess', () => {
    it('should call reprocessCircle with undefined when body has no circleId', async () => {
      const body = {} as ReprocessBodyDto;

      await controller.reprocess(body);

      expect(mockReprocessCircle).toHaveBeenCalledWith(undefined);
    });

    it('should call reprocessCircle with the provided circleId', async () => {
      const body = { circleId: 'abc123-uuid' } as ReprocessBodyDto;

      await controller.reprocess(body);

      expect(mockReprocessCircle).toHaveBeenCalledWith('abc123-uuid');
    });

    it('should return the service result directly', async () => {
      mockReprocessCircle.mockResolvedValue({ reprocessed: 5, failed: 2 });
      const body = {} as ReprocessBodyDto;

      const result = await controller.reprocess(body);

      expect(result).toEqual({ reprocessed: 5, failed: 2 });
    });

    it('should return { reprocessed: 0, failed: 0 } when service returns zeros', async () => {
      mockReprocessCircle.mockResolvedValue({ reprocessed: 0, failed: 0 });
      const body = {} as ReprocessBodyDto;

      const result = await controller.reprocess(body);

      expect(result).toEqual({ reprocessed: 0, failed: 0 });
    });
  });
});
