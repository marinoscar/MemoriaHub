/**
 * Unit tests for UserAvatarService (issue #354, profile picture management).
 *
 * Mocking strategy (mirrors picture-enhancement.handler.spec.ts /
 * media-orientation-edit.service.spec.ts):
 *   - `../storage/processing/image-orientation.util` is module-mocked so
 *     `prepareImageForProcessing` never touches sharp/libvips by default — it
 *     resolves a deterministic "prepared" buffer + dimensions. Individual tests
 *     override the resolved value with a REAL sharp-encoded buffer whenever the
 *     downstream code (renderAvatarJpeg, buildFaceCropThumbnail, sharp.extract)
 *     needs to actually decode/crop/resize real bytes.
 *   - PrismaService is the deep jest-mock-extended mock used across this repo.
 *   - StorageProviderResolver, CircleMembershipService, and UserSettingsService
 *     are plain hand-rolled jest mocks (their surface used by this service is
 *     small and well-defined).
 *
 * Covers:
 *   - resolveAvatarUrl(): the full source x URL table, including the two
 *     "no broken image" null cases
 *   - assertPersonLinkable() via updateProfile(): member success, non-member
 *     404-not-403 (enumeration resistance), soft-deleted person 404, missing
 *     person 404
 *   - resetAvatar(): keeps linkedPersonId untouched in the write payload
 *   - updateProfile({ linkedPersonId: null }): unlink never touches avatar
 *     columns
 *   - updateProfile({ displayName }): never touches avatar state, delegates to
 *     UserSettingsService
 *   - updateProfile({ linkedPersonId, avatarSource }): explicit avatarSource
 *     wins over the implicit "linking re-renders" behavior
 *   - renderPersonAvatar's crop-source fallback ladder: explicit profile crop,
 *     malformed crop falling through, out-of-bounds crop clamping, cover-face
 *     fallback, and the terminal 400 when nothing is usable
 *   - carryLinkedUsersOnMerge()
 *   - EXIF/GPS stripping + the 512x512 output contract (real sharp round-trip)
 */

jest.mock('../storage/processing/image-orientation.util', () => ({
  prepareImageForProcessing: jest.fn().mockResolvedValue({
    buffer: Buffer.from('prepared-jpeg-bytes'),
    width: 800,
    height: 600,
  }),
}));

import { Readable } from 'stream';
import sharp from 'sharp';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CircleRole, Prisma, UserAvatarSource } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { UserSettingsService } from '../settings/user-settings/user-settings.service';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';
import { UserAvatarService } from './user-avatar.service';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-1';
const PERSON_ID = 'person-1';
const CIRCLE_ID = 'circle-1';

function requestUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: USER_ID,
    email: 'user@example.com',
    roles: ['Viewer'],
    permissions: [],
    isActive: true,
    ...overrides,
  };
}

/** Shape of the AVATAR_COLUMNS select, plus the extra fields getProfile() reads. */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    avatarSource: UserAvatarSource.oauth,
    avatarStorageKey: null as string | null,
    avatarVersion: null as string | null,
    linkedPersonId: null as string | null,
    providerProfileImageUrl: 'https://provider.example/photo.jpg',
    email: 'user@example.com',
    displayName: null as string | null,
    providerDisplayName: 'User Name',
    profileImageUrl: null as string | null,
    ...overrides,
  };
}

function personRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PERSON_ID,
    circleId: CIRCLE_ID,
    deletedAt: null as Date | null,
    coverFaceId: null as string | null,
    profileMediaItemId: null as string | null,
    profileCrop: null as unknown,
    name: 'Grandma',
    circle: { name: 'Family Circle' },
    ...overrides,
  };
}

/** A real sharp-encoded JPEG, for tests that need genuinely decodable bytes. */
async function realJpeg(
  width: number,
  height: number,
  opts: { withExifGps?: boolean } = {},
): Promise<Buffer> {
  let pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 80, b: 40 } },
  }).jpeg();

  if (opts.withExifGps) {
    pipeline = pipeline.withMetadata({
      exif: {
        IFD0: { Copyright: 'Test Owner' },
        IFD3: {
          GPSLatitude: '37/1 46/1 30/1',
          GPSLatitudeRef: 'N',
          GPSLongitude: '122/1 25/1 10/1',
          GPSLongitudeRef: 'W',
        },
      },
    } as unknown as Parameters<typeof pipeline.withMetadata>[0]);
  }

  return pipeline.toBuffer();
}

describe('UserAvatarService', () => {
  let service: UserAvatarService;
  let mockPrisma: MockPrismaService;
  let resolver: { getActiveProvider: jest.Mock; getProviderFor: jest.Mock };
  let provider: {
    upload: jest.Mock;
    download: jest.Mock;
    delete: jest.Mock;
    getBucket: jest.Mock;
  };
  let circleMembership: { assertCircleAccess: jest.Mock };
  let userSettings: { patchSettings: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    provider = {
      upload: jest.fn().mockResolvedValue({ location: 'unused' }),
      download: jest.fn().mockResolvedValue(Readable.from(Buffer.from('bytes'))),
      delete: jest.fn().mockResolvedValue(undefined),
      getBucket: jest.fn().mockReturnValue('bucket-1'),
    };

    resolver = {
      getActiveProvider: jest.fn().mockResolvedValue({ id: 's3', provider }),
      getProviderFor: jest.fn().mockResolvedValue(provider),
    };

    circleMembership = {
      assertCircleAccess: jest
        .fn()
        .mockResolvedValue({ role: CircleRole.viewer, isSuperAdmin: false }),
    };

    userSettings = {
      patchSettings: jest.fn().mockResolvedValue(undefined),
    };

    (prepareImageForProcessing as jest.Mock).mockClear();
    (prepareImageForProcessing as jest.Mock).mockResolvedValue({
      buffer: Buffer.from('prepared-jpeg-bytes'),
      width: 800,
      height: 600,
    });

    // Reasonable defaults so a happy-path getProfile() call at the end of an
    // update never explodes for lack of a mocked row. Individual tests
    // override with mockResolvedValueOnce / mockResolvedValue as needed.
    mockPrisma.user.findUnique.mockResolvedValue(userRow() as any);
    mockPrisma.user.update.mockImplementation(
      (args: any) => Promise.resolve({ ...userRow(), ...args.data }) as any,
    );
    mockPrisma.storageObject.create.mockResolvedValue({} as any);
    mockPrisma.storageObject.findUnique.mockResolvedValue({
      storageProvider: 's3',
      bucket: 'bucket-1',
    } as any);
    mockPrisma.storageObject.deleteMany.mockResolvedValue({ count: 1 } as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserAvatarService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageProviderResolver, useValue: resolver },
        { provide: CircleMembershipService, useValue: circleMembership },
        { provide: UserSettingsService, useValue: userSettings },
      ],
    }).compile();

    service = module.get<UserAvatarService>(UserAvatarService);
  });

  // ---------------------------------------------------------------------------
  // resolveAvatarUrl()
  // ---------------------------------------------------------------------------

  describe('resolveAvatarUrl', () => {
    it('upload source + storage key -> byte-proxy URL with version cache-buster', () => {
      const url = service.resolveAvatarUrl(
        userRow({
          avatarSource: UserAvatarSource.upload,
          avatarStorageKey: 'avatars/user-1/abc.jpg',
          avatarVersion: 'v123',
        }) as any,
      );
      expect(url).toBe(`/api/users/${USER_ID}/avatar?v=v123`);
    });

    it('person source + storage key -> the same byte-proxy URL shape', () => {
      const url = service.resolveAvatarUrl(
        userRow({
          avatarSource: UserAvatarSource.person,
          avatarStorageKey: 'avatars/user-1/def.jpg',
          avatarVersion: 'v456',
        }) as any,
      );
      expect(url).toBe(`/api/users/${USER_ID}/avatar?v=v456`);
    });

    it('a derived source with a storage key but NO avatarVersion omits the ?v= query', () => {
      const url = service.resolveAvatarUrl(
        userRow({
          avatarSource: UserAvatarSource.upload,
          avatarStorageKey: 'avatars/user-1/abc.jpg',
          avatarVersion: null,
        }) as any,
      );
      expect(url).toBe(`/api/users/${USER_ID}/avatar`);
    });

    it('oauth source + a provider URL -> the provider URL verbatim', () => {
      const url = service.resolveAvatarUrl(
        userRow({
          avatarSource: UserAvatarSource.oauth,
          providerProfileImageUrl: 'https://lh3.googleusercontent.com/a/photo.jpg',
        }) as any,
      );
      expect(url).toBe('https://lh3.googleusercontent.com/a/photo.jpg');
    });

    it('oauth source + NULL provider URL -> null (never a broken image)', () => {
      const url = service.resolveAvatarUrl(
        userRow({
          avatarSource: UserAvatarSource.oauth,
          providerProfileImageUrl: null,
        }) as any,
      );
      expect(url).toBeNull();
    });

    it('a derived source with NO stored key -> null rather than a 404-prone URL', () => {
      const url = service.resolveAvatarUrl(
        userRow({
          avatarSource: UserAvatarSource.person,
          avatarStorageKey: null,
          avatarVersion: null,
        }) as any,
      );
      expect(url).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Person-link authorization (assertPersonLinkable, via updateProfile)
  // ---------------------------------------------------------------------------

  describe('person-link authorization', () => {
    it('allows a member of the person circle to link', async () => {
      mockPrisma.person.findUnique.mockResolvedValue(personRow() as any);
      mockPrisma.user.findUnique.mockResolvedValue(
        userRow({ linkedPersonId: null }) as any,
      );

      await expect(
        service.updateProfile(requestUser(), {
          linkedPersonId: PERSON_ID,
          avatarSource: UserAvatarSource.oauth,
        } as any),
      ).resolves.toBeDefined();

      expect(circleMembership.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        [],
        CircleRole.viewer,
      );
    });

    it('a non-member gets 404, NOT 403 (enumeration-resistant)', async () => {
      mockPrisma.person.findUnique.mockResolvedValue(personRow() as any);
      circleMembership.assertCircleAccess.mockRejectedValueOnce(
        new ForbiddenException('You are not a member of this circle'),
      );

      const promise = service.updateProfile(requestUser(), {
        linkedPersonId: PERSON_ID,
      } as any);

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      await expect(promise).rejects.not.toBeInstanceOf(ForbiddenException);
    });

    it('a soft-deleted person -> 404 without ever checking circle access', async () => {
      mockPrisma.person.findUnique.mockResolvedValue(
        personRow({ deletedAt: new Date('2026-01-01T00:00:00Z') }) as any,
      );

      await expect(
        service.updateProfile(requestUser(), { linkedPersonId: PERSON_ID } as any),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(circleMembership.assertCircleAccess).not.toHaveBeenCalled();
    });

    it('a nonexistent person id -> 404 without ever checking circle access', async () => {
      mockPrisma.person.findUnique.mockResolvedValue(null);

      await expect(
        service.updateProfile(requestUser(), { linkedPersonId: 'no-such-person' } as any),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(circleMembership.assertCircleAccess).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // resetAvatar(): keeps the person link
  // ---------------------------------------------------------------------------

  describe('resetAvatar', () => {
    it('sets avatarSource=oauth and clears storage columns WITHOUT touching linkedPersonId', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        userRow({
          avatarSource: UserAvatarSource.upload,
          avatarStorageKey: 'avatars/user-1/old.jpg',
          avatarVersion: 'v-old',
          linkedPersonId: PERSON_ID,
        }) as any,
      );
      mockPrisma.person.findUnique.mockResolvedValue(personRow() as any);

      await service.resetAvatar(USER_ID);

      expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
      const writeArgs = mockPrisma.user.update.mock.calls[0][0] as any;

      expect(writeArgs.data).toMatchObject({
        avatarSource: UserAvatarSource.oauth,
        avatarStorageKey: null,
        avatarVersion: null,
      });
      // The load-bearing assertion: the write payload never includes
      // linkedPersonId at all, so the column is untouched by the update.
      expect(writeArgs.data).not.toHaveProperty('linkedPersonId');

      // The superseded object is reaped (best-effort).
      expect(provider.delete).toHaveBeenCalledWith('avatars/user-1/old.jpg');
      expect(mockPrisma.storageObject.deleteMany).toHaveBeenCalledWith({
        where: { storageKey: 'avatars/user-1/old.jpg' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // updateProfile({ linkedPersonId: null }): unlink never touches the picture
  // ---------------------------------------------------------------------------

  describe('updateProfile — unlink', () => {
    it('writes ONLY linkedPersonId (+ the recomputed profileImageUrl), never the avatar columns', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        userRow({
          avatarSource: UserAvatarSource.upload,
          avatarStorageKey: 'avatars/user-1/keep-me.jpg',
          avatarVersion: 'v1',
          linkedPersonId: PERSON_ID,
        }) as any,
      );

      await service.updateProfile(requestUser(), { linkedPersonId: null } as any);

      expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
      const writeArgs = mockPrisma.user.update.mock.calls[0][0] as any;

      expect(writeArgs.data.linkedPersonId).toBeNull();
      expect(writeArgs.data).not.toHaveProperty('avatarStorageKey');
      expect(writeArgs.data).not.toHaveProperty('avatarSource');
      expect(writeArgs.data).not.toHaveProperty('avatarVersion');

      // No render, no storage churn. (getProfile()'s trailing
      // describeLinkedPerson lookup is unrelated to this — it reads whatever
      // linkedPersonId the mocked findUnique still reports, a mock-fixture
      // artifact rather than a behavior of the code under test.)
      expect(provider.upload).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // updateProfile({ displayName }): never touches the avatar
  // ---------------------------------------------------------------------------

  describe('updateProfile — displayName only', () => {
    it('delegates to UserSettingsService and never writes avatar state', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(userRow() as any);

      await service.updateProfile(requestUser(), { displayName: 'New Name' } as any);

      expect(userSettings.patchSettings).toHaveBeenCalledWith(USER_ID, {
        profile: { displayName: 'New Name' },
      });
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.person.findUnique).not.toHaveBeenCalled();
      expect(provider.upload).not.toHaveBeenCalled();
    });

    it('a null displayName maps to an empty-string patch (clears the override)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(userRow() as any);

      await service.updateProfile(requestUser(), { displayName: null } as any);

      expect(userSettings.patchSettings).toHaveBeenCalledWith(USER_ID, {
        profile: { displayName: '' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Linking + an explicit avatarSource in the same request
  // ---------------------------------------------------------------------------

  describe('updateProfile — link + explicit avatarSource wins over implicit render', () => {
    it('applies the explicit avatarSource and never renders from the newly-linked person', async () => {
      mockPrisma.person.findUnique.mockResolvedValue(personRow() as any);
      mockPrisma.user.findUnique.mockResolvedValue(
        userRow({
          avatarSource: UserAvatarSource.upload,
          avatarStorageKey: 'avatars/user-1/old.jpg',
          avatarVersion: 'v-old',
        }) as any,
      );

      await service.updateProfile(requestUser(), {
        linkedPersonId: PERSON_ID,
        avatarSource: UserAvatarSource.oauth,
      } as any);

      // person.findUnique is called exactly once — by assertPersonLinkable.
      // A second call would mean renderPersonAvatar ran, i.e. a wasted render.
      expect(mockPrisma.person.findUnique).toHaveBeenCalledTimes(1);
      expect(provider.upload).not.toHaveBeenCalled();

      // The explicit avatarSource:'oauth' still took effect (reset path ran).
      const writeArgs = mockPrisma.user.update.mock.calls.find(
        (c: any[]) => c[0].data.avatarSource === UserAvatarSource.oauth,
      );
      expect(writeArgs).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // renderPersonAvatar's crop-source fallback ladder (via renderFromLinkedPerson)
  // ---------------------------------------------------------------------------

  describe('crop-source fallback ladder', () => {
    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue(
        userRow({ linkedPersonId: PERSON_ID }) as any,
      );
    });

    it('uses the explicit profile picture + crop when set', async () => {
      const source = await realJpeg(1000, 800);
      (prepareImageForProcessing as jest.Mock).mockResolvedValue({
        buffer: source,
        width: 1000,
        height: 800,
      });

      mockPrisma.person.findUnique.mockResolvedValue(
        personRow({
          profileMediaItemId: 'media-1',
          profileCrop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
        }) as any,
      );
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        type: 'photo',
        deletedAt: null,
        storageObject: {
          storageKey: 'objects/media-1.jpg',
          storageProvider: 's3',
          bucket: 'bucket-1',
          mimeType: 'image/jpeg',
        },
      } as any);

      await service.renderFromLinkedPerson(USER_ID);

      expect(provider.upload).toHaveBeenCalledTimes(1);
      const uploadedBuffer = await streamToBuffer(provider.upload.mock.calls[0][1]);
      const meta = await sharp(uploadedBuffer).metadata();
      expect(meta.width).toBe(512);
      expect(meta.height).toBe(512);

      // Only the explicit-crop path was consulted — no cover-face fallback.
      expect(mockPrisma.face.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.face.findFirst).not.toHaveBeenCalled();
    });

    it('clamps a crop that extends past the image bounds instead of throwing', async () => {
      const source = await realJpeg(1000, 800);
      (prepareImageForProcessing as jest.Mock).mockResolvedValue({
        buffer: source,
        width: 1000,
        height: 800,
      });

      mockPrisma.person.findUnique.mockResolvedValue(
        personRow({
          profileMediaItemId: 'media-1',
          // Extends past both the right and bottom edges.
          profileCrop: { x: 0.8, y: 0.8, w: 0.6, h: 0.6 },
        }) as any,
      );
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        type: 'photo',
        deletedAt: null,
        storageObject: {
          storageKey: 'objects/media-1.jpg',
          storageProvider: 's3',
          bucket: 'bucket-1',
          mimeType: 'image/jpeg',
        },
      } as any);

      await expect(service.renderFromLinkedPerson(USER_ID)).resolves.toBeDefined();
      expect(provider.upload).toHaveBeenCalledTimes(1);
    });

    it('a malformed profileCrop falls through to the cover face despite profileMediaItemId being set', async () => {
      const source = await realJpeg(1000, 800);
      (prepareImageForProcessing as jest.Mock).mockResolvedValue({
        buffer: source,
        width: 1000,
        height: 800,
      });

      mockPrisma.person.findUnique.mockResolvedValue(
        personRow({
          profileMediaItemId: 'media-1',
          // Missing w/h -> parseNormalizedCrop returns null.
          profileCrop: { x: 0.1, y: 0.1 },
          coverFaceId: 'face-1',
        }) as any,
      );
      mockPrisma.face.findUnique.mockResolvedValue({
        mediaItemId: 'media-2',
        boundingBox: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 },
        frameThumbnailKey: null,
      } as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        type: 'photo',
        deletedAt: null,
        storageObject: {
          storageKey: 'objects/media-2.jpg',
          storageProvider: 's3',
          bucket: 'bucket-1',
          mimeType: 'image/jpeg',
        },
      } as any);

      await service.renderFromLinkedPerson(USER_ID);

      // Fell through to the cover-face tier.
      expect(mockPrisma.face.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'face-1' } }),
      );
      expect(provider.upload).toHaveBeenCalledTimes(1);
    });

    it('falls back to the resolved cover face when no profile crop is set', async () => {
      const source = await realJpeg(900, 900);
      (prepareImageForProcessing as jest.Mock).mockResolvedValue({
        buffer: source,
        width: 900,
        height: 900,
      });

      mockPrisma.person.findUnique.mockResolvedValue(
        personRow({ profileMediaItemId: null, profileCrop: null, coverFaceId: null }) as any,
      );
      mockPrisma.face.findFirst.mockResolvedValue({
        mediaItemId: 'media-3',
        boundingBox: { x: 0.25, y: 0.25, w: 0.4, h: 0.4 },
        frameThumbnailKey: null,
      } as any);
      mockPrisma.mediaItem.findUnique.mockResolvedValue({
        type: 'photo',
        deletedAt: null,
        storageObject: {
          storageKey: 'objects/media-3.jpg',
          storageProvider: 's3',
          bucket: 'bucket-1',
          mimeType: 'image/jpeg',
        },
      } as any);

      await service.renderFromLinkedPerson(USER_ID);

      expect(mockPrisma.face.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { personId: PERSON_ID },
          orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
        }),
      );
      expect(provider.upload).toHaveBeenCalledTimes(1);
    });

    it('nothing usable -> 400 with an actionable message', async () => {
      mockPrisma.person.findUnique.mockResolvedValue(
        personRow({ profileMediaItemId: null, profileCrop: null, coverFaceId: null }) as any,
      );
      mockPrisma.face.findFirst.mockResolvedValue(null);

      await expect(service.renderFromLinkedPerson(USER_ID)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.renderFromLinkedPerson(USER_ID)).rejects.toThrow(
        /has no profile picture or detected face yet\. Set one on the People page first\./,
      );
      expect(provider.upload).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // carryLinkedUsersOnMerge()
  // ---------------------------------------------------------------------------

  describe('carryLinkedUsersOnMerge', () => {
    it('repoints every linked user from source to target', async () => {
      const tx = { user: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) } };

      const count = await service.carryLinkedUsersOnMerge(
        tx as unknown as Prisma.TransactionClient,
        'source-person',
        'target-person',
      );

      expect(count).toBe(2);
      expect(tx.user.updateMany).toHaveBeenCalledWith({
        where: { linkedPersonId: 'source-person' },
        data: { linkedPersonId: 'target-person' },
      });
    });
  });

  // ---------------------------------------------------------------------------
  // uploadAvatar(): output contract — 512x512, EXIF/GPS stripped
  // ---------------------------------------------------------------------------

  describe('uploadAvatar — output contract', () => {
    it('rejects an empty buffer without touching storage', async () => {
      await expect(
        service.uploadAvatar(USER_ID, { buffer: Buffer.alloc(0) }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(provider.upload).not.toHaveBeenCalled();
    });

    it('rejects an unsupported mimetype without touching storage', async () => {
      await expect(
        service.uploadAvatar(USER_ID, {
          buffer: Buffer.from('irrelevant'),
          mimetype: 'application/pdf',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(provider.upload).not.toHaveBeenCalled();
    });

    it('rejects bytes prepareImageForProcessing could not decode (width/height 0)', async () => {
      (prepareImageForProcessing as jest.Mock).mockResolvedValueOnce({
        buffer: Buffer.from('undecodable'),
        width: 0,
        height: 0,
      });

      await expect(
        service.uploadAvatar(USER_ID, {
          buffer: Buffer.from('garbage'),
          mimetype: 'image/jpeg',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(provider.upload).not.toHaveBeenCalled();
    });

    it('strips EXIF/GPS metadata and produces a 512x512 JPEG', async () => {
      const sourceWithExifGps = await realJpeg(800, 600, { withExifGps: true });
      const sourceMeta = await sharp(sourceWithExifGps).metadata();
      // Sanity: the fixture genuinely carries EXIF before it reaches the service.
      expect(sourceMeta.exif).toBeDefined();

      (prepareImageForProcessing as jest.Mock).mockResolvedValueOnce({
        buffer: sourceWithExifGps,
        width: 800,
        height: 600,
      });

      await service.uploadAvatar(USER_ID, {
        buffer: Buffer.from('original-bytes-irrelevant-since-prepare-is-mocked'),
        filename: 'photo.jpg',
        mimetype: 'image/jpeg',
      });

      expect(provider.upload).toHaveBeenCalledTimes(1);
      const uploadedBuffer = await streamToBuffer(provider.upload.mock.calls[0][1]);
      const meta = await sharp(uploadedBuffer).metadata();

      expect(meta.width).toBe(512);
      expect(meta.height).toBe(512);
      expect(meta.format).toBe('jpeg');
      expect(meta.exif).toBeUndefined();

      // Also sets avatarSource: 'upload' on the write.
      const writeArgs = mockPrisma.user.update.mock.calls.find(
        (c: any[]) => c[0].data.avatarSource === UserAvatarSource.upload,
      );
      expect(writeArgs).toBeDefined();
      expect(writeArgs![0].data.avatarStorageKey).toEqual(expect.any(String));
      expect(writeArgs![0].data.avatarVersion).toEqual(expect.any(String));
    });
  });
});
