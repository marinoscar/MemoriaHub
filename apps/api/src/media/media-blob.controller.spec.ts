import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { FastifyReply } from 'fastify';

jest.mock('../storage/streaming/media-stream.util', () => ({
  streamStorageObject: jest.fn(async () => undefined),
}));
import { streamStorageObject } from '../storage/streaming/media-stream.util';

import { MediaBlobController } from './media-blob.controller';

describe('MediaBlobController', () => {
  let controller: MediaBlobController;
  let prisma: { storageObject: { findUnique: jest.Mock } };
  let resolver: { getProviderFor: jest.Mock };
  let config: { get: jest.Mock };
  let signer: { verify: jest.Mock; ttlSeconds: number };
  const res = {} as unknown as FastifyReply;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = { storageObject: { findUnique: jest.fn() } };
    resolver = { getProviderFor: jest.fn().mockResolvedValue({ id: 'provider' }) };
    config = { get: jest.fn().mockReturnValue('s3') };
    signer = { verify: jest.fn().mockReturnValue(true), ttlSeconds: 3600 };
    controller = new MediaBlobController(
      prisma as any,
      resolver as any,
      config as any,
      signer as any,
    );
  });

  it('rejects with 403 when signature params are missing', async () => {
    await expect(
      controller.serveBlob(undefined, undefined, undefined, res),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(signer.verify).not.toHaveBeenCalled();
  });

  it('rejects with 403 when the signature is invalid', async () => {
    signer.verify.mockReturnValue(false);
    await expect(
      controller.serveBlob('k/x.jpg', '123', 'deadbeef', res),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.storageObject.findUnique).not.toHaveBeenCalled();
  });

  it('ignores extra injected query params — only k/exp/sig are read', async () => {
    // Simulated by the framework: the method signature only binds the three
    // named params, so an injected _sm_nck never reaches verify().
    prisma.storageObject.findUnique.mockResolvedValue({
      storageProvider: 'r2',
      bucket: 'b',
      mimeType: 'image/jpeg',
    });
    await controller.serveBlob('k/x.jpg', '99999999999', 'a'.repeat(64), res);
    expect(signer.verify).toHaveBeenCalledWith('k/x.jpg', 99999999999, 'a'.repeat(64));
  });

  it('resolves provider from the StorageObject row and streams with its mime', async () => {
    prisma.storageObject.findUnique.mockResolvedValue({
      storageProvider: 'r2',
      bucket: 'my-bucket',
      mimeType: 'video/mp4',
    });
    await controller.serveBlob('k/vid.mp4', '99999999999', 'a'.repeat(64), res);
    expect(resolver.getProviderFor).toHaveBeenCalledWith('r2', 'my-bucket');
    expect(streamStorageObject).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: 'k/vid.mp4',
        mimeType: 'video/mp4',
        cacheControl: 'private, max-age=3600',
      }),
    );
  });

  it('falls back to static provider + inferred mime when no row exists', async () => {
    prisma.storageObject.findUnique.mockResolvedValue(null);
    await controller.serveBlob('k/thumb.jpg', '99999999999', 'a'.repeat(64), res);
    expect(config.get).toHaveBeenCalledWith('storage.provider', 's3');
    expect(resolver.getProviderFor).toHaveBeenCalledWith('s3', undefined);
    expect(streamStorageObject).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/jpeg' }),
    );
  });

  it('returns 404 when the provider cannot be resolved', async () => {
    prisma.storageObject.findUnique.mockResolvedValue(null);
    resolver.getProviderFor.mockRejectedValue(new Error('no creds'));
    await expect(
      controller.serveBlob('k/x.jpg', '99999999999', 'a'.repeat(64), res),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
