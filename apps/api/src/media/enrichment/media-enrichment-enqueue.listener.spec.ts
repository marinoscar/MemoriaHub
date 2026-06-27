import { Test, TestingModule } from '@nestjs/testing';
import { MediaEnrichmentEnqueueListener } from './media-enrichment-enqueue.listener';
import { MediaEnrichmentService } from './media-enrichment.service';
import { ObjectProcessedEvent } from '../../storage/processing/events/object-processed.event';

describe('MediaEnrichmentEnqueueListener', () => {
  let listener: MediaEnrichmentEnqueueListener;
  let mockSvc: { enqueueForStorageObject: jest.Mock };

  beforeEach(async () => {
    mockSvc = {
      enqueueForStorageObject: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaEnrichmentEnqueueListener,
        { provide: MediaEnrichmentService, useValue: mockSvc },
      ],
    }).compile();

    listener = module.get<MediaEnrichmentEnqueueListener>(
      MediaEnrichmentEnqueueListener,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handle', () => {
    it('calls enqueueForStorageObject with the storageObjectId from the event', async () => {
      const event = new ObjectProcessedEvent('storage-obj-99');

      await listener.handle(event);

      expect(mockSvc.enqueueForStorageObject).toHaveBeenCalledWith(
        'storage-obj-99',
      );
      expect(mockSvc.enqueueForStorageObject).toHaveBeenCalledTimes(1);
    });

    it('resolves without rethrowing when enqueueForStorageObject rejects', async () => {
      mockSvc.enqueueForStorageObject.mockRejectedValueOnce(
        new Error('Service unavailable'),
      );

      const event = new ObjectProcessedEvent('storage-obj-error');

      await expect(listener.handle(event)).resolves.toBeUndefined();
    });
  });
});
