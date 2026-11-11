/**
 * Unit tests for AdminLocationInferenceController.
 *
 * The feature-gate check (400 when locationInference is disabled globally)
 * lives IN the controller itself, so this suite exercises that real logic in
 * addition to the pure delegation to LocationInferenceBackfillService.
 */

import { BadRequestException } from '@nestjs/common';
import { AdminLocationInferenceController, type LocationInferenceBackfillService } from '../../src/location/index.js';
import { settingsPortFrom } from '../helpers/settings-port.js';

describe('AdminLocationInferenceController', () => {
  let controller: AdminLocationInferenceController;
  let mockBackfillService: { backfillAllCircles: jest.Mock };
  let features: Record<string, boolean>;
  let settings: ReturnType<typeof settingsPortFrom>;

  beforeEach(() => {
    mockBackfillService = { backfillAllCircles: jest.fn() };
    features = {};
    settings = settingsPortFrom(() => ({ features }));

    controller = new AdminLocationInferenceController(
      mockBackfillService as unknown as LocationInferenceBackfillService,
      settings as never,
    );
  });

  it('throws BadRequestException and never calls backfillAllCircles when locationInference is disabled', async () => {
    features['locationInference'] = false;

    await expect(
      controller.backfillAllCircles({ from: undefined, to: undefined, force: false } as any),
    ).rejects.toThrow(BadRequestException);

    expect(settings.readSystem).toHaveBeenCalledWith('features');
    expect(mockBackfillService.backfillAllCircles).not.toHaveBeenCalled();
  });

  it('calls backfillAllCircles with {from,to,force} from the dto and returns {data:result} when enabled', async () => {
    features['locationInference'] = true;
    const backfillResult = { enqueued: 2, circles: 2, estimatedItems: 40 };
    mockBackfillService.backfillAllCircles.mockResolvedValue(backfillResult);

    const dto = {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      force: true,
    };

    const result = await controller.backfillAllCircles(dto as any);

    expect(mockBackfillService.backfillAllCircles).toHaveBeenCalledWith({
      from: dto.from,
      to: dto.to,
      force: dto.force,
    });
    expect(result).toEqual({ data: backfillResult });
  });
});
