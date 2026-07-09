/**
 * Unit tests for PeopleService.
 *
 * Covers: listPeople, getPerson, createPerson, updatePerson,
 * assignFaces, unassignFace, clusterUnknowns, and profile picture.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PeopleService } from './people.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { FaceClusteringService } from './face-clustering.service';
import { FaceMatchingService } from './face-matching.service';
import { EnrichmentJobService } from '../enrichment/enrichment-job.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CIRCLE_ID = 'circle-uuid-0001';
const USER_ID = 'user-uuid-0001';
const PERSON_ID = 'person-uuid-0001';
const FACE_ID = 'face-uuid-0001';
const MEDIA_ID = 'media-uuid-0001';
const PERMS: string[] = ['circles:read'];

function makePerson(overrides: Partial<any> = {}) {
  return {
    id: PERSON_ID,
    circleId: CIRCLE_ID,
    addedById: USER_ID,
    name: 'Alice',
    coverFaceId: null,
    coverFace: null,
    mergedIntoId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeFace(overrides: Partial<any> = {}) {
  return {
    id: FACE_ID,
    personId: PERSON_ID,
    circleId: CIRCLE_ID,
    mediaItemId: 'media-uuid-0001',
    boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    confidence: 0.9,
    embedding: [],
    manuallyAssigned: false,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PeopleService', () => {
  let service: PeopleService;
  let mockPrisma: MockPrismaService;
  let mockCircleMembershipService: { assertCircleAccess: jest.Mock };
  let mockClusteringService: { clusterUnknownFaces: jest.Mock };
  let mockMatchingService: { computePersonCentroid: jest.Mock };
  let mockEnrichmentJobService: { enqueue: jest.Mock };
  let mockSystemSettings: { isFeatureEnabled: jest.Mock };
  let mockMediaThumbnailService: { signThumb: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockCircleMembershipService = {
      assertCircleAccess: jest.fn().mockResolvedValue(undefined),
    };
    mockClusteringService = {
      clusterUnknownFaces: jest.fn().mockResolvedValue({ clustersCreated: 2, facesAssigned: 5 }),
    };
    mockMatchingService = {
      computePersonCentroid: jest.fn().mockResolvedValue(undefined),
    };
    mockEnrichmentJobService = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };
    mockSystemSettings = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    };
    mockMediaThumbnailService = {
      signThumb: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PeopleService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
        { provide: FaceClusteringService, useValue: mockClusteringService },
        { provide: FaceMatchingService, useValue: mockMatchingService },
        { provide: EnrichmentJobService, useValue: mockEnrichmentJobService },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
        { provide: MediaThumbnailService, useValue: mockMediaThumbnailService },
      ],
    }).compile();

    service = module.get<PeopleService>(PeopleService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // listPeople
  // -------------------------------------------------------------------------

  describe('listPeople', () => {
    it('calls assertCircleAccess with viewer role', async () => {
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(0);

      await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: false, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'viewer',
      );
    });

    it('excludes unlabeled when includeUnlabeled is false (name: { not: null })', async () => {
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(0);

      await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: false, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      const findManyCall = (mockPrisma.person.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({ name: { not: null } });
    });

    it('includes unlabeled when includeUnlabeled is true (no name filter)', async () => {
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(0);

      await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: true, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      const findManyCall = (mockPrisma.person.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where.name).toBeUndefined();
    });

    it('returns paginated items with meta', async () => {
      const person = makePerson({ _count: { faces: 3 } });
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([person]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: false, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      expect(result.items).toHaveLength(1);
      expect(result.meta.totalItems).toBe(1);
      expect(result.meta.page).toBe(1);
    });

    it('always filters by deletedAt: null and mergedIntoId: null', async () => {
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(0);

      await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: true, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      const findManyCall = (mockPrisma.person.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({
        deletedAt: null,
        mergedIntoId: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // getPerson
  // -------------------------------------------------------------------------

  describe('getPerson', () => {
    it('throws NotFoundException when person not found', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getPerson('nonexistent', USER_ID, PERMS)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when person is soft-deleted', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(
        makePerson({ deletedAt: new Date() }),
      );

      await expect(service.getPerson(PERSON_ID, USER_ID, PERMS)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('calls assertCircleAccess with viewer role', async () => {
      const person = makePerson({ faces: [], coverFace: null });
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(person);

      await service.getPerson(PERSON_ID, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'viewer',
      );
    });

    it('returns person with faces on success', async () => {
      const face = makeFace();
      const person = makePerson({ faces: [face], coverFace: null });
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(person);

      const result = await service.getPerson(PERSON_ID, USER_ID, PERMS);

      expect(result.id).toBe(PERSON_ID);
      expect(result.faces).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // createPerson
  // -------------------------------------------------------------------------

  describe('createPerson', () => {
    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.person.create as jest.Mock).mockResolvedValue(makePerson());

      await service.createPerson(
        { circleId: CIRCLE_ID, name: 'Bob' } as any,
        USER_ID,
        PERMS,
      );

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'collaborator',
      );
    });

    it('creates person record with correct data', async () => {
      (mockPrisma.person.create as jest.Mock).mockResolvedValue(makePerson({ name: 'Bob' }));

      await service.createPerson(
        { circleId: CIRCLE_ID, name: 'Bob' } as any,
        USER_ID,
        PERMS,
      );

      expect(mockPrisma.person.create).toHaveBeenCalledWith({
        data: {
          circleId: CIRCLE_ID,
          addedById: USER_ID,
          name: 'Bob',
        },
      });
    });

    it('with faceIds: verifies faces in circle and sets manuallyAssigned: true', async () => {
      (mockPrisma.person.create as jest.Mock).mockResolvedValue(makePerson());
      // assertFacesInCircle call then fetchAffectedMediaItems call
      (mockPrisma.face.findMany as jest.Mock)
        .mockResolvedValueOnce([makeFace()])
        .mockResolvedValueOnce([]); // fetchAffectedMediaItems — no auto-tagging circles
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.createPerson(
        { circleId: CIRCLE_ID, name: 'Carol', faceIds: [FACE_ID] } as any,
        USER_ID,
        PERMS,
      );

      expect(mockPrisma.face.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [FACE_ID] }, circleId: CIRCLE_ID },
        data: { personId: PERSON_ID, manuallyAssigned: true },
      });
    });

    it('throws NotFoundException when faceId is not in the circle', async () => {
      (mockPrisma.person.create as jest.Mock).mockResolvedValue(makePerson());
      // assertFacesInCircle finds zero faces → length mismatch
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);

      await expect(
        service.createPerson(
          { circleId: CIRCLE_ID, name: 'Dave', faceIds: ['unknown-face-id'] } as any,
          USER_ID,
          PERMS,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // updatePerson
  // -------------------------------------------------------------------------

  describe('updatePerson', () => {
    it('throws NotFoundException when person not found', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.updatePerson(PERSON_ID, { name: 'Eve' } as any, USER_ID, PERMS),
      ).rejects.toThrow(NotFoundException);
    });

    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.person.update as jest.Mock).mockResolvedValue(makePerson({ name: 'Eve' }));

      await service.updatePerson(PERSON_ID, { name: 'Eve' } as any, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'collaborator',
      );
    });

    it('throws BadRequestException when coverFaceId does not belong to person', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      // face.findUnique returns a face belonging to a different person
      (mockPrisma.face.findUnique as jest.Mock).mockResolvedValue(
        makeFace({ personId: 'other-person' }),
      );

      await expect(
        service.updatePerson(
          PERSON_ID,
          { coverFaceId: FACE_ID } as any,
          USER_ID,
          PERMS,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('updates person name successfully', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.person.update as jest.Mock).mockResolvedValue(
        makePerson({ name: 'Updated Name' }),
      );

      const result = await service.updatePerson(
        PERSON_ID,
        { name: 'Updated Name' } as any,
        USER_ID,
        PERMS,
      );

      expect(mockPrisma.person.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PERSON_ID },
          data: expect.objectContaining({ name: 'Updated Name' }),
        }),
      );
      expect(result.name).toBe('Updated Name');
    });
  });

  // -------------------------------------------------------------------------
  // assignFaces
  // -------------------------------------------------------------------------

  describe('assignFaces', () => {
    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findMany as jest.Mock)
        .mockResolvedValueOnce([makeFace()])
        .mockResolvedValueOnce([]); // fetchAffectedMediaItems
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.assignFaces(PERSON_ID, { faceIds: [FACE_ID] } as any, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'collaborator',
      );
    });

    it('sets manuallyAssigned: true on all assigned faces', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findMany as jest.Mock)
        .mockResolvedValueOnce([makeFace()])
        .mockResolvedValueOnce([]); // fetchAffectedMediaItems
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.assignFaces(PERSON_ID, { faceIds: [FACE_ID] } as any, USER_ID, PERMS);

      expect(mockPrisma.face.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [FACE_ID] }, circleId: CIRCLE_ID },
        data: { personId: PERSON_ID, manuallyAssigned: true },
      });
    });

    it('throws NotFoundException when face is not in circle', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      // findMany returns empty → assertFacesInCircle throws
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValueOnce([]);

      await expect(
        service.assignFaces(PERSON_ID, { faceIds: ['missing-face'] } as any, USER_ID, PERMS),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when person not found', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.assignFaces(PERSON_ID, { faceIds: [FACE_ID] } as any, USER_ID, PERMS),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // unassignFace
  // -------------------------------------------------------------------------

  describe('unassignFace', () => {
    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findUnique as jest.Mock).mockResolvedValue(makeFace());
      (mockPrisma.face.update as jest.Mock).mockResolvedValue({});

      await service.unassignFace(PERSON_ID, FACE_ID, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'collaborator',
      );
    });

    it('sets personId: null and manuallyAssigned: false', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findUnique as jest.Mock).mockResolvedValue(makeFace());
      (mockPrisma.face.update as jest.Mock).mockResolvedValue({});

      await service.unassignFace(PERSON_ID, FACE_ID, USER_ID, PERMS);

      expect(mockPrisma.face.update).toHaveBeenCalledWith({
        where: { id: FACE_ID },
        data: { personId: null, manuallyAssigned: false },
      });
    });

    it('throws NotFoundException when face is not assigned to this person', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      // Face belongs to a different person
      (mockPrisma.face.findUnique as jest.Mock).mockResolvedValue(
        makeFace({ personId: 'other-person' }),
      );

      await expect(
        service.unassignFace(PERSON_ID, FACE_ID, USER_ID, PERMS),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when face not found', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.unassignFace(PERSON_ID, FACE_ID, USER_ID, PERMS),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when person not found', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.unassignFace(PERSON_ID, FACE_ID, USER_ID, PERMS),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // clusterUnknowns
  // -------------------------------------------------------------------------

  describe('clusterUnknowns', () => {
    it('calls assertCircleAccess with circle_admin role', async () => {
      await service.clusterUnknowns(CIRCLE_ID, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'circle_admin',
      );
    });

    it('delegates to clusteringService.clusterUnknownFaces', async () => {
      await service.clusterUnknowns(CIRCLE_ID, USER_ID, PERMS);

      expect(mockClusteringService.clusterUnknownFaces).toHaveBeenCalledWith(CIRCLE_ID, USER_ID);
    });

    it('returns the result from clusteringService', async () => {
      mockClusteringService.clusterUnknownFaces.mockResolvedValue({
        clustersCreated: 3,
        facesAssigned: 7,
      });

      const result = await service.clusterUnknowns(CIRCLE_ID, USER_ID, PERMS);

      expect(result).toEqual({ clustersCreated: 3, facesAssigned: 7 });
    });

    it('throws BadRequestException when face recognition is disabled globally', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(false);

      await expect(
        service.clusterUnknowns(CIRCLE_ID, USER_ID, PERMS),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // -------------------------------------------------------------------------
  // mergePeople
  // -------------------------------------------------------------------------

  describe('mergePeople', () => {
    const SOURCE_ID = 'source-uuid-0001';
    const TARGET_ID = 'target-uuid-0002';

    function makeSource(overrides: Partial<any> = {}) {
      return {
        id: SOURCE_ID,
        circleId: CIRCLE_ID,
        name: 'Alice (source)',
        coverFaceId: null,
        mergedIntoId: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      };
    }

    function makeTarget(overrides: Partial<any> = {}) {
      return {
        id: TARGET_ID,
        circleId: CIRCLE_ID,
        name: 'Alice',
        coverFaceId: null,
        mergedIntoId: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      };
    }

    it('throws NotFoundException when source not found', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeTarget());
      await expect(
        service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS)
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when target not found', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeSource())
        .mockResolvedValueOnce(null);
      await expect(
        service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS)
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when source is soft-deleted', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeSource({ deletedAt: new Date() }))
        .mockResolvedValueOnce(makeTarget());
      await expect(
        service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS)
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when source and target are in different circles', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeSource({ circleId: 'circle-A' }))
        .mockResolvedValueOnce(makeTarget({ circleId: 'circle-B' }));
      await expect(
        service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS)
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when source is already merged (mergedIntoId set)', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeSource({ mergedIntoId: 'some-other-person' }))
        .mockResolvedValueOnce(makeTarget());
      await expect(
        service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS)
      ).rejects.toThrow(BadRequestException);
    });

    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeSource())
        .mockResolvedValueOnce(makeTarget());
      // fetchAffectedMediaItemsByPersonId: source then target
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.person.update as jest.Mock)
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ id: TARGET_ID, name: 'Alice', circleId: CIRCLE_ID, coverFaceId: null, _count: { faces: 0 }, createdAt: new Date(), updatedAt: new Date() });
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS);
      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID, CIRCLE_ID, PERMS, 'collaborator'
      );
    });

    it('reassigns all source faces to target inside the transaction', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeSource())
        .mockResolvedValueOnce(makeTarget());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 3 });
        (mockPrisma.person.update as jest.Mock)
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ id: TARGET_ID, name: 'Alice', circleId: CIRCLE_ID, coverFaceId: null, _count: { faces: 3 }, createdAt: new Date(), updatedAt: new Date() });
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS);
      expect(mockPrisma.face.updateMany).toHaveBeenCalledWith({
        where: { personId: SOURCE_ID },
        data: { personId: TARGET_ID },
      });
    });

    it('soft-deletes the source with mergedIntoId=targetId and deletedAt set', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeSource())
        .mockResolvedValueOnce(makeTarget());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.person.update as jest.Mock)
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ id: TARGET_ID, name: 'Alice', circleId: CIRCLE_ID, coverFaceId: null, _count: { faces: 0 }, createdAt: new Date(), updatedAt: new Date() });
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS);
      const firstPersonUpdateCall = (mockPrisma.person.update as jest.Mock).mock.calls[0][0];
      expect(firstPersonUpdateCall.where).toEqual({ id: SOURCE_ID });
      expect(firstPersonUpdateCall.data).toMatchObject({
        mergedIntoId: TARGET_ID,
        coverFaceId: null,
      });
      expect(firstPersonUpdateCall.data.deletedAt).toBeInstanceOf(Date);
    });

    it('writes a person:merge audit event', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeSource())
        .mockResolvedValueOnce(makeTarget());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.person.update as jest.Mock)
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ id: TARGET_ID, name: 'Alice', circleId: CIRCLE_ID, coverFaceId: null, _count: { faces: 0 }, createdAt: new Date(), updatedAt: new Date() });
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS);
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'person:merge', targetId: TARGET_ID }),
        }),
      );
    });

    it('carries source coverFaceId to target when target has none', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeSource({ coverFaceId: 'face-cover-src' }))
        .mockResolvedValueOnce(makeTarget({ coverFaceId: null }));
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.person.update as jest.Mock)
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ id: TARGET_ID, name: 'Alice', circleId: CIRCLE_ID, coverFaceId: 'face-cover-src', _count: { faces: 0 }, createdAt: new Date(), updatedAt: new Date() });
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      const result = await service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS);
      const secondPersonUpdateCall = (mockPrisma.person.update as jest.Mock).mock.calls[1][0];
      expect(secondPersonUpdateCall.data).toMatchObject({ coverFaceId: 'face-cover-src' });
      expect(result.coverFaceId).toBe('face-cover-src');
    });

    it('does NOT override target coverFaceId when target already has one', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeSource({ coverFaceId: 'face-cover-src' }))
        .mockResolvedValueOnce(makeTarget({ coverFaceId: 'face-cover-tgt' }));
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.person.update as jest.Mock)
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ id: TARGET_ID, name: 'Alice', circleId: CIRCLE_ID, coverFaceId: 'face-cover-tgt', _count: { faces: 0 }, createdAt: new Date(), updatedAt: new Date() });
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS);
      const secondPersonUpdateCall = (mockPrisma.person.update as jest.Mock).mock.calls[1][0];
      expect(secondPersonUpdateCall.data.coverFaceId).toBeUndefined();
    });

    it('calls matchingService.computePersonCentroid for target after merge', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeSource())
        .mockResolvedValueOnce(makeTarget());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.person.update as jest.Mock)
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ id: TARGET_ID, name: 'Alice', circleId: CIRCLE_ID, coverFaceId: null, _count: { faces: 0 }, createdAt: new Date(), updatedAt: new Date() });
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS);
      expect(mockMatchingService.computePersonCentroid).toHaveBeenCalledWith(TARGET_ID);
    });

    it('returns merged result shape with mergedSourceId', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeSource())
        .mockResolvedValueOnce(makeTarget());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      const now = new Date();
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
        (mockPrisma.person.update as jest.Mock)
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ id: TARGET_ID, name: 'Alice', circleId: CIRCLE_ID, coverFaceId: null, _count: { faces: 2 }, createdAt: now, updatedAt: now });
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      const result = await service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS);
      expect(result).toMatchObject({
        id: TARGET_ID,
        name: 'Alice',
        circleId: CIRCLE_ID,
        faceCount: 2,
        mergedSourceId: SOURCE_ID,
      });
    });
  });

  // -------------------------------------------------------------------------
  // listUnassignedFaces
  // -------------------------------------------------------------------------

  describe('listUnassignedFaces', () => {
    function makeUnassignedFace(overrides: Partial<any> = {}) {
      return {
        id: 'face-uuid-unassigned',
        mediaItemId: 'media-uuid-0001',
        boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        confidence: 0.85,
        createdAt: new Date(),
        ...overrides,
      };
    }

    it('calls assertCircleAccess with viewer role', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.face.count as jest.Mock).mockResolvedValue(0);

      await service.listUnassignedFaces(USER_ID, PERMS, {
        circleId: CIRCLE_ID,
        page: 1,
        pageSize: 20,
      } as any);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'viewer',
      );
    });

    it('returns only personId=null faces for the circle', async () => {
      const face = makeUnassignedFace();
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([face]);
      (mockPrisma.face.count as jest.Mock).mockResolvedValue(1);

      await service.listUnassignedFaces(USER_ID, PERMS, {
        circleId: CIRCLE_ID,
        page: 1,
        pageSize: 20,
      } as any);

      const findManyCall = (mockPrisma.face.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({
        personId: null,
        circleId: CIRCLE_ID,
      });
    });

    it('excludes soft-deleted media items (mediaItem.deletedAt: null in where)', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.face.count as jest.Mock).mockResolvedValue(0);

      await service.listUnassignedFaces(USER_ID, PERMS, {
        circleId: CIRCLE_ID,
        page: 1,
        pageSize: 20,
      } as any);

      const findManyCall = (mockPrisma.face.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({
        mediaItem: { deletedAt: null },
      });
    });

    it('paginates correctly (skip/take)', async () => {
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.face.count as jest.Mock).mockResolvedValue(0);

      await service.listUnassignedFaces(USER_ID, PERMS, {
        circleId: CIRCLE_ID,
        page: 2,
        pageSize: 10,
      } as any);

      const findManyCall = (mockPrisma.face.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.skip).toBe(10);
      expect(findManyCall.take).toBe(10);
    });

    it('returns items with correct shape and meta', async () => {
      const face = makeUnassignedFace();
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([face]);
      (mockPrisma.face.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listUnassignedFaces(USER_ID, PERMS, {
        circleId: CIRCLE_ID,
        page: 1,
        pageSize: 20,
      } as any);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        faceId: face.id,
        mediaItemId: face.mediaItemId,
        boundingBox: face.boundingBox,
        confidence: face.confidence,
        createdAt: face.createdAt,
      });
      expect(result.meta.totalItems).toBe(1);
      expect(result.meta.page).toBe(1);
      expect(result.meta.pageSize).toBe(20);
      expect(result.meta.totalPages).toBe(1);
    });

    // -----------------------------------------------------------------------
    // archived filtering (face archive/purge feature)
    // -----------------------------------------------------------------------

    describe('archived filtering', () => {
      it('defaults to hiddenAt: null when archived is not provided (excludes archived faces)', async () => {
        (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.face.count as jest.Mock).mockResolvedValue(0);

        await service.listUnassignedFaces(USER_ID, PERMS, {
          circleId: CIRCLE_ID,
          page: 1,
          pageSize: 20,
        } as any);

        const findManyCall = (mockPrisma.face.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyCall.where.hiddenAt).toBeNull();
      });

      it('defaults to hiddenAt: null when archived is explicitly false', async () => {
        (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.face.count as jest.Mock).mockResolvedValue(0);

        await service.listUnassignedFaces(USER_ID, PERMS, {
          circleId: CIRCLE_ID,
          archived: false,
          page: 1,
          pageSize: 20,
        } as any);

        const findManyCall = (mockPrisma.face.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyCall.where.hiddenAt).toBeNull();
      });

      it('returns only hidden (archived) faces when archived=true (hiddenAt: { not: null })', async () => {
        const archivedFace = makeUnassignedFace({ id: 'face-archived-1' });
        (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([archivedFace]);
        (mockPrisma.face.count as jest.Mock).mockResolvedValue(1);

        const result = await service.listUnassignedFaces(USER_ID, PERMS, {
          circleId: CIRCLE_ID,
          archived: true,
          page: 1,
          pageSize: 20,
        } as any);

        const findManyCall = (mockPrisma.face.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyCall.where.hiddenAt).toEqual({ not: null });
        expect(result.items).toHaveLength(1);
      });

      it('still scopes archived query to personId: null and the circle', async () => {
        (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
        (mockPrisma.face.count as jest.Mock).mockResolvedValue(0);

        await service.listUnassignedFaces(USER_ID, PERMS, {
          circleId: CIRCLE_ID,
          archived: true,
          page: 1,
          pageSize: 20,
        } as any);

        const findManyCall = (mockPrisma.face.findMany as jest.Mock).mock.calls[0][0];
        expect(findManyCall.where).toMatchObject({
          personId: null,
          circleId: CIRCLE_ID,
          hiddenAt: { not: null },
        });
      });

      it('includes hiddenAt in the returned item shape', async () => {
        const hiddenAt = new Date();
        const archivedFace = makeUnassignedFace({ id: 'face-archived-2', hiddenAt });
        (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([archivedFace]);
        (mockPrisma.face.count as jest.Mock).mockResolvedValue(1);

        const result = await service.listUnassignedFaces(USER_ID, PERMS, {
          circleId: CIRCLE_ID,
          archived: true,
          page: 1,
          pageSize: 20,
        } as any);

        expect(result.items[0].hiddenAt).toEqual(hiddenAt);
      });

      it('live (non-archived) items report hiddenAt: null', async () => {
        const liveFace = makeUnassignedFace({ hiddenAt: null });
        (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([liveFace]);
        (mockPrisma.face.count as jest.Mock).mockResolvedValue(1);

        const result = await service.listUnassignedFaces(USER_ID, PERMS, {
          circleId: CIRCLE_ID,
          page: 1,
          pageSize: 20,
        } as any);

        expect(result.items[0].hiddenAt).toBeNull();
      });
    });
  });

  // -------------------------------------------------------------------------
  // deletePerson
  // -------------------------------------------------------------------------

  describe('deletePerson', () => {
    it('throws NotFoundException when person not found', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.deletePerson(PERSON_ID, USER_ID, PERMS)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when person is soft-deleted', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson({ deletedAt: new Date() }));
      await expect(service.deletePerson(PERSON_ID, USER_ID, PERMS)).rejects.toThrow(NotFoundException);
    });

    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.person.update as jest.Mock).mockResolvedValue({});
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await service.deletePerson(PERSON_ID, USER_ID, PERMS);
      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID, CIRCLE_ID, PERMS, 'collaborator'
      );
    });

    it('nulls faces\' personId and sets manuallyAssigned=false', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
        (mockPrisma.person.update as jest.Mock).mockResolvedValue({});
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await service.deletePerson(PERSON_ID, USER_ID, PERMS);
      expect(mockPrisma.face.updateMany).toHaveBeenCalledWith({
        where: { personId: PERSON_ID },
        data: { personId: null, manuallyAssigned: false },
      });
    });

    it('soft-deletes the person and clears coverFaceId', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.person.update as jest.Mock).mockResolvedValue({});
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await service.deletePerson(PERSON_ID, USER_ID, PERMS);
      expect(mockPrisma.person.update).toHaveBeenCalledWith({
        where: { id: PERSON_ID },
        data: expect.objectContaining({ coverFaceId: null }),
      });
      const updateCall = (mockPrisma.person.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.deletedAt).toBeInstanceOf(Date);
    });

    it('writes a person:delete audit event', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.person.update as jest.Mock).mockResolvedValue({});
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      await service.deletePerson(PERSON_ID, USER_ID, PERMS);
      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'person:delete', targetId: PERSON_ID }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Auto cover face — createPerson
  // -------------------------------------------------------------------------

  describe('createPerson — auto coverFaceId', () => {
    it('sets coverFaceId to the first faceId when coverFaceId is null after create', async () => {
      const person = makePerson({ coverFaceId: null });
      (mockPrisma.person.create as jest.Mock).mockResolvedValue(person);
      (mockPrisma.face.findMany as jest.Mock)
        .mockResolvedValueOnce([makeFace()])  // assertFacesInCircle
        .mockResolvedValueOnce([]);           // fetchAffectedMediaItems
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.person.update as jest.Mock).mockResolvedValue({
        ...person,
        coverFaceId: FACE_ID,
      });

      await service.createPerson(
        { circleId: CIRCLE_ID, name: 'Alice', faceIds: [FACE_ID] } as any,
        USER_ID,
        PERMS,
      );

      expect(mockPrisma.person.update).toHaveBeenCalledWith({
        where: { id: PERSON_ID },
        data: { coverFaceId: FACE_ID },
      });
    });

    it('does NOT call person.update for coverFaceId when no faceIds provided', async () => {
      (mockPrisma.person.create as jest.Mock).mockResolvedValue(makePerson({ coverFaceId: null }));

      await service.createPerson(
        { circleId: CIRCLE_ID, name: 'Bob' } as any,
        USER_ID,
        PERMS,
      );

      expect(mockPrisma.person.update).not.toHaveBeenCalled();
    });

    it('does NOT override coverFaceId when person already has one', async () => {
      const person = makePerson({ coverFaceId: 'existing-cover-face' });
      (mockPrisma.person.create as jest.Mock).mockResolvedValue(person);
      (mockPrisma.face.findMany as jest.Mock)
        .mockResolvedValueOnce([makeFace()])  // assertFacesInCircle
        .mockResolvedValueOnce([]);           // fetchAffectedMediaItems
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.createPerson(
        { circleId: CIRCLE_ID, name: 'Carol', faceIds: [FACE_ID] } as any,
        USER_ID,
        PERMS,
      );

      // person.update should NOT be called because coverFaceId was already set
      expect(mockPrisma.person.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Auto cover face — assignFaces
  // -------------------------------------------------------------------------

  describe('assignFaces — auto coverFaceId', () => {
    it('sets coverFaceId to the first faceId when person coverFaceId is null', async () => {
      const person = makePerson({ coverFaceId: null });
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(person);
      (mockPrisma.face.findMany as jest.Mock)
        .mockResolvedValueOnce([makeFace()])
        .mockResolvedValueOnce([]); // fetchAffectedMediaItems
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.person.update as jest.Mock).mockResolvedValue({
        ...person,
        coverFaceId: FACE_ID,
      });

      await service.assignFaces(PERSON_ID, { faceIds: [FACE_ID] } as any, USER_ID, PERMS);

      expect(mockPrisma.person.update).toHaveBeenCalledWith({
        where: { id: PERSON_ID },
        data: { coverFaceId: FACE_ID },
      });
    });

    it('does NOT call person.update for coverFaceId when person already has one', async () => {
      const person = makePerson({ coverFaceId: 'already-set' });
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(person);
      (mockPrisma.face.findMany as jest.Mock)
        .mockResolvedValueOnce([makeFace()])
        .mockResolvedValueOnce([]); // fetchAffectedMediaItems
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.assignFaces(PERSON_ID, { faceIds: [FACE_ID] } as any, USER_ID, PERMS);

      expect(mockPrisma.person.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Cover fallback — listPeople
  // -------------------------------------------------------------------------

  describe('listPeople — cover fallback', () => {
    it('returns coverFace from persisted coverFace relation when set', async () => {
      const coverFace = { id: 'cover-face-id', mediaItemId: MEDIA_ID, boundingBox: { x: 0, y: 0, w: 0.5, h: 0.5 } };
      const person = makePerson({
        coverFaceId: 'cover-face-id',
        coverFace,
        faces: [],
        _count: { faces: 1 },
        profileMediaItemId: null,
        profileCrop: null,
      });
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([person]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: false, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      expect(result.items[0].coverFace).toEqual({
        faceId: 'cover-face-id',
        mediaItemId: MEDIA_ID,
        boundingBox: coverFace.boundingBox,
        faceThumbnailUrl: null,
      });
    });

    it('falls back to first face when coverFace relation is null', async () => {
      const fallbackFace = { id: 'fallback-face', mediaItemId: MEDIA_ID, boundingBox: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, confidence: 0.8 };
      const person = makePerson({
        coverFaceId: null,
        coverFace: null,
        faces: [fallbackFace],
        _count: { faces: 1 },
        profileMediaItemId: null,
        profileCrop: null,
      });
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([person]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: false, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      expect(result.items[0].coverFace).toEqual({
        faceId: 'fallback-face',
        mediaItemId: MEDIA_ID,
        boundingBox: fallbackFace.boundingBox,
        faceThumbnailUrl: null,
      });
    });

    it('returns null coverFace when coverFace relation is null and no faces', async () => {
      const person = makePerson({
        coverFaceId: null,
        coverFace: null,
        faces: [],
        _count: { faces: 0 },
        profileMediaItemId: null,
        profileCrop: null,
      });
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([person]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: false, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      expect(result.items[0].coverFace).toBeNull();
    });

    it('includes profileMediaItemId and profileCrop in list response', async () => {
      const crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
      const person = makePerson({
        coverFace: null,
        faces: [],
        _count: { faces: 0 },
        profileMediaItemId: MEDIA_ID,
        profileCrop: crop,
      });
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([person]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: false, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      expect(result.items[0].profileMediaItemId).toBe(MEDIA_ID);
      expect(result.items[0].profileCrop).toEqual(crop);
    });
  });

  // -------------------------------------------------------------------------
  // Cover fallback — getPerson
  // -------------------------------------------------------------------------

  describe('getPerson — cover fallback', () => {
    it('returns coverFace from persisted coverFace relation when set', async () => {
      const coverFace = { id: 'cover-face-id', mediaItemId: MEDIA_ID, boundingBox: { x: 0, y: 0, w: 0.5, h: 0.5 } };
      const person = makePerson({
        coverFace,
        faces: [],
        profileMediaItemId: null,
        profileCrop: null,
      });
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(person);

      const result = await service.getPerson(PERSON_ID, USER_ID, PERMS);

      expect(result.coverFace).toEqual({
        faceId: 'cover-face-id',
        mediaItemId: MEDIA_ID,
        boundingBox: coverFace.boundingBox,
        faceThumbnailUrl: null,
      });
    });

    it('falls back to first face (sorted by confidence) when coverFace is null', async () => {
      const highConfFace = { id: 'high-conf', mediaItemId: MEDIA_ID, boundingBox: { x: 0, y: 0, w: 0.5, h: 0.5 }, confidence: 0.95, manuallyAssigned: false, createdAt: new Date() };
      const lowConfFace = { id: 'low-conf', mediaItemId: 'media-other', boundingBox: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, confidence: 0.4, manuallyAssigned: false, createdAt: new Date() };
      const person = makePerson({
        coverFace: null,
        // Faces come pre-sorted by confidence DESC from the DB query
        faces: [highConfFace, lowConfFace],
        profileMediaItemId: null,
        profileCrop: null,
      });
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(person);

      const result = await service.getPerson(PERSON_ID, USER_ID, PERMS);

      // Should pick the first (highest confidence) face
      expect(result.coverFace?.faceId).toBe('high-conf');
    });

    it('returns null coverFace when no coverFace and no faces', async () => {
      const person = makePerson({
        coverFace: null,
        faces: [],
        profileMediaItemId: null,
        profileCrop: null,
      });
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(person);

      const result = await service.getPerson(PERSON_ID, USER_ID, PERMS);

      expect(result.coverFace).toBeNull();
    });

    it('includes profileMediaItemId and profileCrop in detail response', async () => {
      const crop = { x: 0.0, y: 0.1, w: 0.9, h: 0.85 };
      const person = makePerson({
        coverFace: null,
        faces: [],
        profileMediaItemId: MEDIA_ID,
        profileCrop: crop,
      });
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(person);

      const result = await service.getPerson(PERSON_ID, USER_ID, PERMS);

      expect(result.profileMediaItemId).toBe(MEDIA_ID);
      expect(result.profileCrop).toEqual(crop);
    });
  });

  // -------------------------------------------------------------------------
  // updatePerson — favorite field
  // -------------------------------------------------------------------------

  describe('updatePerson — favorite', () => {
    it('persists favorite:true when provided', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.person.update as jest.Mock).mockResolvedValue(
        makePerson({ favorite: true }),
      );

      const result = await service.updatePerson(
        PERSON_ID,
        { favorite: true } as any,
        USER_ID,
        PERMS,
      );

      expect(mockPrisma.person.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ favorite: true }),
        }),
      );
      expect(result.favorite).toBe(true);
    });

    it('persists favorite:false when provided', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.person.update as jest.Mock).mockResolvedValue(
        makePerson({ favorite: false }),
      );

      await service.updatePerson(
        PERSON_ID,
        { favorite: false } as any,
        USER_ID,
        PERMS,
      );

      expect(mockPrisma.person.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ favorite: false }),
        }),
      );
    });

    it('does NOT include favorite in updateData when not provided', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.person.update as jest.Mock).mockResolvedValue(makePerson({ name: 'Bob' }));

      await service.updatePerson(
        PERSON_ID,
        { name: 'Bob' } as any,
        USER_ID,
        PERMS,
      );

      const updateCall = (mockPrisma.person.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.favorite).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // listPeople — ordering and favorite in response
  // -------------------------------------------------------------------------

  describe('listPeople — orderBy and favorite field', () => {
    it('orders by favorite desc then name asc', async () => {
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(0);

      await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: false, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      const findManyCall = (mockPrisma.person.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.orderBy).toEqual([{ favorite: 'desc' }, { name: 'asc' }]);
    });

    it('includes favorite in list item response', async () => {
      const person = makePerson({
        favorite: true,
        coverFace: null,
        faces: [],
        _count: { faces: 0 },
        profileMediaItemId: null,
        profileCrop: null,
      });
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([person]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: false, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      expect(result.items[0].favorite).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getPerson — favorite in response
  // -------------------------------------------------------------------------

  describe('getPerson — favorite field', () => {
    it('includes favorite in single-person response', async () => {
      const person = makePerson({
        favorite: true,
        coverFace: null,
        faces: [],
        profileMediaItemId: null,
        profileCrop: null,
      });
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(person);

      const result = await service.getPerson(PERSON_ID, USER_ID, PERMS);

      expect(result.favorite).toBe(true);
    });

    it('returns favorite:false when person is not favorited', async () => {
      const person = makePerson({
        favorite: false,
        coverFace: null,
        faces: [],
        profileMediaItemId: null,
        profileCrop: null,
      });
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(person);

      const result = await service.getPerson(PERSON_ID, USER_ID, PERMS);

      expect(result.favorite).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // updatePerson — profile picture handling
  // -------------------------------------------------------------------------

  describe('updatePerson — profile picture', () => {
    function makeMediaItem(overrides: Partial<any> = {}) {
      return {
        id: MEDIA_ID,
        circleId: CIRCLE_ID,
        deletedAt: null,
        ...overrides,
      };
    }

    it('sets profileMediaItemId and profileCrop when mediaItem is valid and person appears in it', async () => {
      const crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findFirst as jest.Mock).mockResolvedValue(makeFace({ mediaItemId: MEDIA_ID, personId: PERSON_ID }));
      (mockPrisma.person.update as jest.Mock).mockResolvedValue({
        ...makePerson(),
        profileMediaItemId: MEDIA_ID,
        profileCrop: crop,
      });

      const result = await service.updatePerson(
        PERSON_ID,
        { profileMediaItemId: MEDIA_ID, profileCrop: crop } as any,
        USER_ID,
        PERMS,
      );

      expect(result.profileMediaItemId).toBe(MEDIA_ID);
      expect(result.profileCrop).toEqual(crop);
    });

    it('clears profileMediaItemId and profileCrop when set to null', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.person.update as jest.Mock).mockResolvedValue({
        ...makePerson(),
        profileMediaItemId: null,
        profileCrop: null,
      });

      const result = await service.updatePerson(
        PERSON_ID,
        { profileMediaItemId: null, profileCrop: null } as any,
        USER_ID,
        PERMS,
      );

      expect(result.profileMediaItemId).toBeNull();
      expect(result.profileCrop).toBeNull();
    });

    it('throws BadRequestException when mediaItem not found', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.updatePerson(
          PERSON_ID,
          { profileMediaItemId: MEDIA_ID, profileCrop: { x: 0, y: 0, w: 1, h: 1 } } as any,
          USER_ID,
          PERMS,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when mediaItem belongs to a different circle', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(
        makeMediaItem({ circleId: 'other-circle' }),
      );

      await expect(
        service.updatePerson(
          PERSON_ID,
          { profileMediaItemId: MEDIA_ID, profileCrop: { x: 0, y: 0, w: 1, h: 1 } } as any,
          USER_ID,
          PERMS,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when person has no face in that media item', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.updatePerson(
          PERSON_ID,
          { profileMediaItemId: MEDIA_ID, profileCrop: { x: 0, y: 0, w: 1, h: 1 } } as any,
          USER_ID,
          PERMS,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns profileMediaItemId and profileCrop in update response', async () => {
      const crop = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(makeMediaItem());
      (mockPrisma.face.findFirst as jest.Mock).mockResolvedValue(makeFace({ mediaItemId: MEDIA_ID }));
      (mockPrisma.person.update as jest.Mock).mockResolvedValue({
        ...makePerson(),
        profileMediaItemId: MEDIA_ID,
        profileCrop: crop,
      });

      const result = await service.updatePerson(
        PERSON_ID,
        { profileMediaItemId: MEDIA_ID, profileCrop: crop } as any,
        USER_ID,
        PERMS,
      );

      expect(result).toMatchObject({
        id: PERSON_ID,
        profileMediaItemId: MEDIA_ID,
        profileCrop: crop,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Auto-tagging re-enqueue: assignFaces
  // -------------------------------------------------------------------------

  describe('assignFaces — auto-tagging re-enqueue', () => {
    function setupAssignFacesHappy() {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findMany as jest.Mock)
        // assertFacesInCircle call
        .mockResolvedValueOnce([makeFace()])
        // fetchAffectedMediaItems call
        .mockResolvedValueOnce([
          {
            mediaItemId: MEDIA_ID,
            mediaItem: {
              circleId: CIRCLE_ID,
            },
          },
        ]);
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    }

    it('enqueues auto_tagging rerun for affected media items', async () => {
      setupAssignFacesHappy();

      await service.assignFaces(PERSON_ID, { faceIds: [FACE_ID] } as any, USER_ID, PERMS);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auto_tagging',
          mediaItemId: MEDIA_ID,
          circleId: CIRCLE_ID,
          reason: 'rerun',
          priority: 0,
        }),
      );
    });

    it('does not propagate enqueue errors — assign still succeeds', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findMany as jest.Mock)
        .mockResolvedValueOnce([makeFace()])
        .mockResolvedValueOnce([
          {
            mediaItemId: MEDIA_ID,
            mediaItem: {
              circleId: CIRCLE_ID,
            },
          },
        ]);
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      mockEnrichmentJobService.enqueue.mockRejectedValue(new Error('Queue full'));

      // Must not throw
      await expect(
        service.assignFaces(PERSON_ID, { faceIds: [FACE_ID] } as any, USER_ID, PERMS),
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Auto-tagging re-enqueue: unassignFace
  // -------------------------------------------------------------------------

  describe('unassignFace — auto-tagging re-enqueue', () => {
    it('enqueues auto_tagging rerun for the affected media item', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findUnique as jest.Mock).mockResolvedValue(
        makeFace({ mediaItemId: MEDIA_ID }),
      );
      (mockPrisma.face.update as jest.Mock).mockResolvedValue({});

      await service.unassignFace(PERSON_ID, FACE_ID, USER_ID, PERMS);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auto_tagging',
          mediaItemId: MEDIA_ID,
          circleId: CIRCLE_ID,
          reason: 'rerun',
          priority: 0,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Auto-tagging re-enqueue: createPerson (with faceIds)
  // -------------------------------------------------------------------------

  describe('createPerson — auto-tagging re-enqueue', () => {
    it('enqueues auto_tagging when faceIds are provided', async () => {
      (mockPrisma.person.create as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findMany as jest.Mock)
        // assertFacesInCircle
        .mockResolvedValueOnce([makeFace()])
        // fetchAffectedMediaItems
        .mockResolvedValueOnce([
          {
            mediaItemId: MEDIA_ID,
            mediaItem: {
              circleId: CIRCLE_ID,
            },
          },
        ]);
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.createPerson(
        { circleId: CIRCLE_ID, name: 'Alice', faceIds: [FACE_ID] } as any,
        USER_ID,
        PERMS,
      );

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auto_tagging',
          mediaItemId: MEDIA_ID,
          circleId: CIRCLE_ID,
          reason: 'rerun',
          priority: 0,
        }),
      );
    });

    it('does NOT call enqueue when no faceIds are provided', async () => {
      (mockPrisma.person.create as jest.Mock).mockResolvedValue(makePerson());

      await service.createPerson(
        { circleId: CIRCLE_ID, name: 'Bob' } as any,
        USER_ID,
        PERMS,
      );

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Auto-tagging re-enqueue: mergePeople
  // -------------------------------------------------------------------------

  describe('mergePeople — auto-tagging re-enqueue', () => {
    const SOURCE_ID = 'source-merge-uuid';
    const TARGET_ID = 'target-merge-uuid';

    function makeSource() {
      return {
        id: SOURCE_ID,
        circleId: CIRCLE_ID,
        name: 'Alice (source)',
        coverFaceId: null,
        mergedIntoId: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    function makeTarget() {
      return {
        id: TARGET_ID,
        circleId: CIRCLE_ID,
        name: 'Alice',
        coverFaceId: null,
        mergedIntoId: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    it('enqueues auto_tagging for media items affected by the merge', async () => {
      (mockPrisma.person.findUnique as jest.Mock)
        .mockResolvedValueOnce(makeSource())
        .mockResolvedValueOnce(makeTarget());

      // fetchAffectedMediaItemsByPersonId for source (first face.findMany)
      (mockPrisma.face.findMany as jest.Mock)
        .mockResolvedValueOnce([
          {
            mediaItemId: MEDIA_ID,
            mediaItem: {
              circleId: CIRCLE_ID,
            },
          },
        ])
        // fetchAffectedMediaItemsByPersonId for target (second face.findMany)
        .mockResolvedValueOnce([]);

      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.person.update as jest.Mock)
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({
            id: TARGET_ID,
            name: 'Alice',
            circleId: CIRCLE_ID,
            coverFaceId: null,
            _count: { faces: 0 },
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });

      await service.mergePeople({ sourceId: SOURCE_ID, targetId: TARGET_ID }, USER_ID, PERMS);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auto_tagging',
          mediaItemId: MEDIA_ID,
          circleId: CIRCLE_ID,
          reason: 'rerun',
          priority: 0,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Auto-tagging re-enqueue: deletePerson
  // -------------------------------------------------------------------------

  describe('deletePerson — auto-tagging re-enqueue', () => {
    it('enqueues auto_tagging for media items that lost a person', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());

      // fetchAffectedMediaItemsByPersonId
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        {
          mediaItemId: MEDIA_ID,
          mediaItem: {
            circleId: CIRCLE_ID,
          },
        },
      ]);

      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
        (mockPrisma.person.update as jest.Mock).mockResolvedValue({});
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });

      await service.deletePerson(PERSON_ID, USER_ID, PERMS);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auto_tagging',
          mediaItemId: MEDIA_ID,
          circleId: CIRCLE_ID,
          reason: 'rerun',
          priority: 0,
        }),
      );
    });

    it('does not propagate enqueue errors — delete still succeeds', async () => {
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(makePerson());
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([
        {
          mediaItemId: MEDIA_ID,
          mediaItem: {
            circleId: CIRCLE_ID,
          },
        },
      ]);
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.person.update as jest.Mock).mockResolvedValue({});
        (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});
        return cb(mockPrisma);
      });
      mockEnrichmentJobService.enqueue.mockRejectedValue(new Error('Enqueue failed'));

      await expect(service.deletePerson(PERSON_ID, USER_ID, PERMS)).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // addPersonToMedia
  // -------------------------------------------------------------------------

  describe('addPersonToMedia', () => {
    const MEDIA_ITEM = {
      id: MEDIA_ID,
      circleId: CIRCLE_ID,
      deletedAt: null,
    };
    const CREATED_FACE_ID = 'face-uuid-manual-0001';

    function setupMediaItem(overrides: Partial<typeof MEDIA_ITEM> = {}) {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        ...MEDIA_ITEM,
        ...overrides,
      });
    }

    function setupNoExistingFace() {
      (mockPrisma.face.findFirst as jest.Mock).mockResolvedValue(null);
    }

    function setupCreatedFace(id = CREATED_FACE_ID) {
      (mockPrisma.face.create as jest.Mock).mockResolvedValue({
        id,
        mediaItemId: MEDIA_ID,
        circleId: CIRCLE_ID,
        personId: PERSON_ID,
        providerKey: 'manual',
        modelVersion: 'manual',
        embedding: [],
        boundingBox: { x: 0, y: 0, w: 0, h: 0 },
        confidence: null,
        manuallyAssigned: true,
        createdAt: new Date(),
      });
    }

    it('creates a manual Face row with exact convention values when called with personId', async () => {
      setupMediaItem();
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(
        makePerson({ id: PERSON_ID, name: 'Alice', circleId: CIRCLE_ID, deletedAt: null }),
      );
      setupNoExistingFace();
      setupCreatedFace();

      const result = await service.addPersonToMedia(MEDIA_ID, USER_ID, PERMS, { personId: PERSON_ID });

      expect(mockPrisma.face.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          mediaItemId: MEDIA_ID,
          circleId: CIRCLE_ID,
          personId: PERSON_ID,
          providerKey: 'manual',
          modelVersion: 'manual',
          embedding: [],
          boundingBox: { x: 0, y: 0, w: 0, h: 0 },
          confidence: null,
          manuallyAssigned: true,
        }),
      });
      expect(result).toMatchObject({
        personId: PERSON_ID,
        personName: 'Alice',
        faceId: CREATED_FACE_ID,
        mediaItemId: MEDIA_ID,
      });
    });

    it('asserts collaborator access before creating the face', async () => {
      setupMediaItem();
      (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(
        makePerson({ id: PERSON_ID, circleId: CIRCLE_ID, deletedAt: null }),
      );
      setupNoExistingFace();
      setupCreatedFace();

      await service.addPersonToMedia(MEDIA_ID, USER_ID, PERMS, { personId: PERSON_ID });

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'collaborator',
      );
    });

    it('denies access when assertCircleAccess throws (ForbiddenException propagates)', async () => {
      setupMediaItem();
      const { ForbiddenException } = await import('@nestjs/common');
      mockCircleMembershipService.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('Forbidden'),
      );

      await expect(
        service.addPersonToMedia(MEDIA_ID, USER_ID, PERMS, { personId: PERSON_ID }),
      ).rejects.toThrow(ForbiddenException);
    });

    describe('find-or-create by name', () => {
      it('reuses an existing person when the name matches case-insensitively', async () => {
        setupMediaItem();
        // findFirst returns an existing person (case-insensitive match)
        (mockPrisma.person.findFirst as jest.Mock).mockResolvedValue(
          { id: PERSON_ID, name: 'alice' },
        );
        setupNoExistingFace();
        setupCreatedFace();

        const result = await service.addPersonToMedia(MEDIA_ID, USER_ID, PERMS, { name: 'Alice' });

        // No new person created
        expect(mockPrisma.person.create).not.toHaveBeenCalled();
        expect(result.personId).toBe(PERSON_ID);
      });

      it('creates a new person when no name match exists', async () => {
        const NEW_PERSON_ID = 'person-uuid-new';
        setupMediaItem();
        // findFirst returns null → must create
        (mockPrisma.person.findFirst as jest.Mock).mockResolvedValue(null);
        (mockPrisma.person.create as jest.Mock).mockResolvedValue(
          { id: NEW_PERSON_ID, name: 'New Person' },
        );
        setupNoExistingFace();
        setupCreatedFace();

        const result = await service.addPersonToMedia(MEDIA_ID, USER_ID, PERMS, { name: 'New Person' });

        expect(mockPrisma.person.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            circleId: CIRCLE_ID,
            addedById: USER_ID,
            name: 'New Person',
          }),
          select: expect.any(Object),
        });
        expect(result.personId).toBe(NEW_PERSON_ID);
      });
    });

    describe('idempotency', () => {
      it('returns the existing face without creating a new one when the person already has a face on the item', async () => {
        const EXISTING_FACE_ID = 'face-uuid-existing';
        setupMediaItem();
        (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(
          makePerson({ id: PERSON_ID, name: 'Alice', circleId: CIRCLE_ID, deletedAt: null }),
        );
        // Idempotency: existing face found
        (mockPrisma.face.findFirst as jest.Mock).mockResolvedValue(
          makeFace({ id: EXISTING_FACE_ID, personId: PERSON_ID, mediaItemId: MEDIA_ID }),
        );

        const result = await service.addPersonToMedia(MEDIA_ID, USER_ID, PERMS, { personId: PERSON_ID });

        expect(mockPrisma.face.create).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          personId: PERSON_ID,
          faceId: EXISTING_FACE_ID,
          mediaItemId: MEDIA_ID,
        });
      });
    });

    describe('auto-tagging re-enqueue', () => {
      it('enqueues auto_tagging after associating a person', async () => {
        setupMediaItem();
        (mockPrisma.person.findUnique as jest.Mock).mockResolvedValue(
          makePerson({ id: PERSON_ID, name: 'Alice', circleId: CIRCLE_ID, deletedAt: null }),
        );
        setupNoExistingFace();
        setupCreatedFace();

        await service.addPersonToMedia(MEDIA_ID, USER_ID, PERMS, { personId: PERSON_ID });

        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'auto_tagging',
            mediaItemId: MEDIA_ID,
            circleId: CIRCLE_ID,
            reason: 'rerun',
            priority: 0,
          }),
        );
      });
    });

    it('throws NotFoundException when media item is not found', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.addPersonToMedia(MEDIA_ID, USER_ID, PERMS, { personId: PERSON_ID }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when media item is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        id: MEDIA_ID,
        circleId: CIRCLE_ID,
        deletedAt: new Date(),
      });

      await expect(
        service.addPersonToMedia(MEDIA_ID, USER_ID, PERMS, { personId: PERSON_ID }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // removePersonFromMedia
  // -------------------------------------------------------------------------

  describe('removePersonFromMedia', () => {
    const MEDIA_ITEM = {
      id: MEDIA_ID,
      circleId: CIRCLE_ID,
      deletedAt: null,
    };

    function setupMediaItem(overrides: Partial<typeof MEDIA_ITEM> = {}) {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        ...MEDIA_ITEM,
        ...overrides,
      });
    }

    function setupDeleteMany(count: number) {
      (mockPrisma.face.deleteMany as jest.Mock).mockResolvedValue({ count });
    }

    it('deletes only providerKey="manual" Face rows for the (mediaItem, person) pair', async () => {
      setupMediaItem();
      setupDeleteMany(1);

      await service.removePersonFromMedia(MEDIA_ID, PERSON_ID, USER_ID, PERMS);

      expect(mockPrisma.face.deleteMany).toHaveBeenCalledWith({
        where: { mediaItemId: MEDIA_ID, personId: PERSON_ID, providerKey: 'manual' },
      });
    });

    it('asserts collaborator access before deleting', async () => {
      setupMediaItem();
      setupDeleteMany(1);

      await service.removePersonFromMedia(MEDIA_ID, PERSON_ID, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'collaborator',
      );
    });

    it('throws NotFoundException when no manual face exists for this (mediaItem, person) pair', async () => {
      setupMediaItem();
      setupDeleteMany(0);

      await expect(
        service.removePersonFromMedia(MEDIA_ID, PERSON_ID, USER_ID, PERMS),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when media item is not found', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.removePersonFromMedia(MEDIA_ID, PERSON_ID, USER_ID, PERMS),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when media item is soft-deleted', async () => {
      (mockPrisma.mediaItem.findUnique as jest.Mock).mockResolvedValue({
        id: MEDIA_ID,
        circleId: CIRCLE_ID,
        deletedAt: new Date(),
      });

      await expect(
        service.removePersonFromMedia(MEDIA_ID, PERSON_ID, USER_ID, PERMS),
      ).rejects.toThrow(NotFoundException);
    });

    describe('auto-tagging re-enqueue', () => {
      it('enqueues auto_tagging after removing a person association', async () => {
        setupMediaItem();
        setupDeleteMany(1);

        await service.removePersonFromMedia(MEDIA_ID, PERSON_ID, USER_ID, PERMS);

        expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'auto_tagging',
            mediaItemId: MEDIA_ID,
            circleId: CIRCLE_ID,
            reason: 'rerun',
            priority: 0,
          }),
        );
      });
    });

    it('returns the deleted count', async () => {
      setupMediaItem();
      setupDeleteMany(2);

      const result = await service.removePersonFromMedia(MEDIA_ID, PERSON_ID, USER_ID, PERMS);

      expect(result).toEqual({ deleted: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // listPeople — hidden flag
  // -------------------------------------------------------------------------

  describe('listPeople — hidden flag', () => {
    it('applies hiddenAt: null filter when hidden is false (default)', async () => {
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(0);

      await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: false, hidden: false, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      const findManyCall = (mockPrisma.person.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where).toMatchObject({ hiddenAt: null });
      expect(findManyCall.where.hiddenAt).toBeNull();
    });

    it('applies hiddenAt: { not: null } filter when hidden is true', async () => {
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(0);

      await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: false, hidden: true, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      const findManyCall = (mockPrisma.person.findMany as jest.Mock).mock.calls[0][0];
      expect(findManyCall.where.hiddenAt).toEqual({ not: null });
    });

    it('response items include hiddenAt field', async () => {
      const hiddenAt = new Date();
      const person = makePerson({
        hiddenAt,
        _count: { faces: 1 },
        coverFace: null,
        faces: [],
        profileMediaItemId: null,
        profileCrop: null,
        favorite: false,
      });
      (mockPrisma.person.findMany as jest.Mock).mockResolvedValue([person]);
      (mockPrisma.person.count as jest.Mock).mockResolvedValue(1);

      const result = await service.listPeople(
        { circleId: CIRCLE_ID, includeUnlabeled: false, hidden: true, page: 1, pageSize: 20 } as any,
        USER_ID,
        PERMS,
      );

      expect(result.items[0].hiddenAt).toEqual(hiddenAt);
    });
  });

  // -------------------------------------------------------------------------
  // hidePeople
  // -------------------------------------------------------------------------

  describe('hidePeople', () => {
    const dto = { circleId: CIRCLE_ID, ids: [PERSON_ID] } as any;

    beforeEach(() => {
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({ id: 'audit-1' });
    });

    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.person.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.hidePeople(dto, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'collaborator',
      );
    });

    it('calls person.updateMany with hiddenAt set and correct where clause', async () => {
      (mockPrisma.person.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.hidePeople(dto, USER_ID, PERMS);

      const call = (mockPrisma.person.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.where).toMatchObject({
        id: { in: [PERSON_ID] },
        circleId: CIRCLE_ID,
        deletedAt: null,
        hiddenAt: null,
      });
      expect(call.data.hiddenAt).toBeInstanceOf(Date);
    });

    it('where clause includes deletedAt: null and hiddenAt: null', async () => {
      (mockPrisma.person.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await service.hidePeople(dto, USER_ID, PERMS);

      const call = (mockPrisma.person.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.where.deletedAt).toBeNull();
      expect(call.where.hiddenAt).toBeNull();
    });

    it('returns { hidden: count }', async () => {
      (mockPrisma.person.updateMany as jest.Mock).mockResolvedValue({ count: 3 });

      const result = await service.hidePeople(dto, USER_ID, PERMS);

      expect(result).toEqual({ hidden: 3 });
    });

    it('scopes update to the provided circleId only', async () => {
      (mockPrisma.person.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.hidePeople({ circleId: CIRCLE_ID, ids: ['p1', 'p2'] } as any, USER_ID, PERMS);

      const call = (mockPrisma.person.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.where.circleId).toBe(CIRCLE_ID);
      expect(call.where.id).toEqual({ in: ['p1', 'p2'] });
    });

    it('writes a person:hide audit event with correct fields', async () => {
      (mockPrisma.person.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.hidePeople(dto, USER_ID, PERMS);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'person:hide',
            targetType: 'person',
            targetId: PERSON_ID,
            meta: expect.objectContaining({ circleId: CIRCLE_ID, ids: [PERSON_ID], count: 2 }),
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // unhidePeople
  // -------------------------------------------------------------------------

  describe('unhidePeople', () => {
    const dto = { circleId: CIRCLE_ID, ids: [PERSON_ID] } as any;

    beforeEach(() => {
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({ id: 'audit-1' });
    });

    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.person.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.unhidePeople(dto, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'collaborator',
      );
    });

    it('calls person.updateMany clearing hiddenAt with hiddenAt: { not: null } filter', async () => {
      (mockPrisma.person.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.unhidePeople(dto, USER_ID, PERMS);

      const call = (mockPrisma.person.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.where).toMatchObject({
        id: { in: [PERSON_ID] },
        circleId: CIRCLE_ID,
        deletedAt: null,
        hiddenAt: { not: null },
      });
      expect(call.data.hiddenAt).toBeNull();
    });

    it('returns { unhidden: count }', async () => {
      (mockPrisma.person.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      const result = await service.unhidePeople(dto, USER_ID, PERMS);

      expect(result).toEqual({ unhidden: 2 });
    });

    it('writes a person:unhide audit event with correct fields', async () => {
      (mockPrisma.person.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.unhidePeople(dto, USER_ID, PERMS);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'person:unhide',
            targetType: 'person',
            targetId: PERSON_ID,
            meta: expect.objectContaining({ circleId: CIRCLE_ID, ids: [PERSON_ID], count: 2 }),
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // purgePeople
  // -------------------------------------------------------------------------

  describe('purgePeople', () => {
    const dto = { circleId: CIRCLE_ID, ids: [PERSON_ID] } as any;

    function setupPurgeMocks(deletedCount = 1, affectedFaces: any[] = []) {
      // face.findMany for affected media items lookup
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue(affectedFaces);
      // $transaction runs the callback immediately (mockPrismaTransaction pattern)
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
        return cb(mockPrisma);
      });
      (mockPrisma.face.deleteMany as jest.Mock).mockResolvedValue({ count: affectedFaces.length });
      (mockPrisma.person.deleteMany as jest.Mock).mockResolvedValue({ count: deletedCount });
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({ id: 'audit-1' });
    }

    it('calls assertCircleAccess with collaborator role', async () => {
      setupPurgeMocks();

      await service.purgePeople(dto, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'collaborator',
      );
    });

    it('deletes Face rows for the person ids first (face.deleteMany inside transaction)', async () => {
      setupPurgeMocks();

      await service.purgePeople(dto, USER_ID, PERMS);

      expect(mockPrisma.face.deleteMany).toHaveBeenCalledWith({
        where: { personId: { in: [PERSON_ID] }, circleId: CIRCLE_ID },
      });
    });

    it('hard-deletes Person rows (person.deleteMany inside transaction)', async () => {
      setupPurgeMocks();

      await service.purgePeople(dto, USER_ID, PERMS);

      expect(mockPrisma.person.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [PERSON_ID] }, circleId: CIRCLE_ID },
      });
    });

    it('writes a person:purge audit event inside the transaction', async () => {
      setupPurgeMocks();

      await service.purgePeople(dto, USER_ID, PERMS);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'person:purge',
            actorUserId: USER_ID,
          }),
        }),
      );
    });

    it('does NOT call mediaItem.deleteMany (photos are preserved)', async () => {
      setupPurgeMocks();

      await service.purgePeople(dto, USER_ID, PERMS);

      expect(mockPrisma.mediaItem.deleteMany).not.toHaveBeenCalled();
    });

    it('re-enqueues auto_tagging for affected media items after purge', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(true);
      setupPurgeMocks(1, [
        {
          mediaItemId: MEDIA_ID,
          mediaItem: { circleId: CIRCLE_ID },
        },
      ]);

      await service.purgePeople(dto, USER_ID, PERMS);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auto_tagging',
          mediaItemId: MEDIA_ID,
          circleId: CIRCLE_ID,
        }),
      );
    });

    it('does not enqueue auto_tagging when there are no affected media items', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(true);
      setupPurgeMocks(1, []);

      await service.purgePeople(dto, USER_ID, PERMS);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('returns { deleted: count }', async () => {
      setupPurgeMocks(2);

      const result = await service.purgePeople(dto, USER_ID, PERMS);

      expect(result).toEqual({ deleted: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // hideFaces  (archive individual unassigned faces)
  // -------------------------------------------------------------------------

  describe('hideFaces', () => {
    const dto = { circleId: CIRCLE_ID, ids: [FACE_ID] } as any;

    beforeEach(() => {
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({ id: 'audit-1' });
    });

    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.hideFaces(dto, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'collaborator',
      );
    });

    it('calls face.updateMany with hiddenAt set and correct where clause (scoped to personId: null)', async () => {
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.hideFaces(dto, USER_ID, PERMS);

      const call = (mockPrisma.face.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.where).toMatchObject({
        id: { in: [FACE_ID] },
        circleId: CIRCLE_ID,
        personId: null,
        hiddenAt: null,
      });
      expect(call.data.hiddenAt).toBeInstanceOf(Date);
    });

    it('an assigned face id (personId set) is NOT hidden — where clause excludes it via personId: null', async () => {
      // updateMany's where requires personId: null; Prisma would return count: 0
      // for a face whose personId is non-null even though its id was requested.
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      const result = await service.hideFaces(
        { circleId: CIRCLE_ID, ids: [FACE_ID] } as any,
        USER_ID,
        PERMS,
      );

      const call = (mockPrisma.face.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.where.personId).toBeNull();
      expect(result).toEqual({ hidden: 0 });
    });

    it('returns { hidden: count }', async () => {
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 3 });

      const result = await service.hideFaces(dto, USER_ID, PERMS);

      expect(result).toEqual({ hidden: 3 });
    });

    it('scopes update to the provided circleId only', async () => {
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.hideFaces({ circleId: CIRCLE_ID, ids: ['f1', 'f2'] } as any, USER_ID, PERMS);

      const call = (mockPrisma.face.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.where.circleId).toBe(CIRCLE_ID);
      expect(call.where.id).toEqual({ in: ['f1', 'f2'] });
    });

    it('writes a face:hide audit event with correct fields', async () => {
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.hideFaces(dto, USER_ID, PERMS);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'face:hide',
            targetType: 'face',
            targetId: FACE_ID,
            meta: expect.objectContaining({ circleId: CIRCLE_ID, ids: [FACE_ID], count: 2 }),
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // unhideFaces  (unarchive individual unassigned faces)
  // -------------------------------------------------------------------------

  describe('unhideFaces', () => {
    const dto = { circleId: CIRCLE_ID, ids: [FACE_ID] } as any;

    beforeEach(() => {
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({ id: 'audit-1' });
    });

    it('calls assertCircleAccess with collaborator role', async () => {
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.unhideFaces(dto, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'collaborator',
      );
    });

    it('calls face.updateMany clearing hiddenAt, scoped to personId: null and hiddenAt: { not: null }', async () => {
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.unhideFaces(dto, USER_ID, PERMS);

      const call = (mockPrisma.face.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.where).toMatchObject({
        id: { in: [FACE_ID] },
        circleId: CIRCLE_ID,
        personId: null,
        hiddenAt: { not: null },
      });
      expect(call.data.hiddenAt).toBeNull();
    });

    it('an assigned face id (personId set) is NOT unhidden — where clause excludes it via personId: null', async () => {
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      const result = await service.unhideFaces(
        { circleId: CIRCLE_ID, ids: [FACE_ID] } as any,
        USER_ID,
        PERMS,
      );

      const call = (mockPrisma.face.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.where.personId).toBeNull();
      expect(result).toEqual({ unhidden: 0 });
    });

    it('returns { unhidden: count }', async () => {
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      const result = await service.unhideFaces(dto, USER_ID, PERMS);

      expect(result).toEqual({ unhidden: 2 });
    });

    it('writes a face:unhide audit event with correct fields', async () => {
      (mockPrisma.face.updateMany as jest.Mock).mockResolvedValue({ count: 2 });

      await service.unhideFaces(dto, USER_ID, PERMS);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'face:unhide',
            targetType: 'face',
            targetId: FACE_ID,
            meta: expect.objectContaining({ circleId: CIRCLE_ID, ids: [FACE_ID], count: 2 }),
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // purgeFaces  (permanently delete individual faces)
  // -------------------------------------------------------------------------

  describe('purgeFaces', () => {
    const dto = { circleId: CIRCLE_ID, ids: [FACE_ID] } as any;

    function setupPurgeFacesMocks(deletedCount = 1, affectedFaces: any[] = []) {
      // face.findMany for affected media items lookup (BEFORE the transaction)
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue(affectedFaces);
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
        return cb(mockPrisma);
      });
      (mockPrisma.face.deleteMany as jest.Mock).mockResolvedValue({ count: deletedCount });
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({ id: 'audit-1' });
    }

    it('calls assertCircleAccess with collaborator role', async () => {
      setupPurgeFacesMocks();

      await service.purgeFaces(dto, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'collaborator',
      );
    });

    it('hard-deletes Face rows scoped to id-in-list and circleId (NOT scoped to personId: null)', async () => {
      setupPurgeFacesMocks();

      await service.purgeFaces(dto, USER_ID, PERMS);

      expect(mockPrisma.face.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [FACE_ID] }, circleId: CIRCLE_ID },
      });
      const call = (mockPrisma.face.deleteMany as jest.Mock).mock.calls[0][0];
      expect(call.where.personId).toBeUndefined();
    });

    it('writes a face:purge audit event inside the transaction', async () => {
      setupPurgeFacesMocks();

      await service.purgeFaces(dto, USER_ID, PERMS);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'face:purge',
            actorUserId: USER_ID,
            targetType: 'face',
            targetId: FACE_ID,
          }),
        }),
      );
    });

    it('does NOT call mediaItem.deleteMany (photos are preserved)', async () => {
      setupPurgeFacesMocks();

      await service.purgeFaces(dto, USER_ID, PERMS);

      expect(mockPrisma.mediaItem.deleteMany).not.toHaveBeenCalled();
    });

    it('re-enqueues auto_tagging for affected media items after purge', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(true);
      setupPurgeFacesMocks(1, [
        {
          mediaItemId: MEDIA_ID,
          mediaItem: { circleId: CIRCLE_ID },
        },
      ]);

      await service.purgeFaces(dto, USER_ID, PERMS);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auto_tagging',
          mediaItemId: MEDIA_ID,
          circleId: CIRCLE_ID,
        }),
      );
    });

    it('does not enqueue auto_tagging when there are no affected media items', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(true);
      setupPurgeFacesMocks(1, []);

      await service.purgeFaces(dto, USER_ID, PERMS);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('returns { deleted: count }', async () => {
      setupPurgeFacesMocks(2);

      const result = await service.purgeFaces(dto, USER_ID, PERMS);

      expect(result).toEqual({ deleted: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // purgeArchivedFaces  (permanently delete ALL archived unassigned faces in a circle)
  // -------------------------------------------------------------------------

  describe('purgeArchivedFaces', () => {
    const dto = { circleId: CIRCLE_ID } as any;

    function setupPurgeArchivedFacesMocks(deletedCount = 1, affectedFaces: any[] = []) {
      // face.findMany for affected media items lookup (BEFORE the transaction)
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue(affectedFaces);
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
        return cb(mockPrisma);
      });
      (mockPrisma.face.deleteMany as jest.Mock).mockResolvedValue({ count: deletedCount });
      (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({ id: 'audit-1' });
    }

    it('calls assertCircleAccess with collaborator role', async () => {
      setupPurgeArchivedFacesMocks();

      await service.purgeArchivedFaces(dto, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'collaborator',
      );
    });

    it('hard-deletes archived unassigned Face rows scoped to circleId, personId:null, hiddenAt:not-null (no mediaItem sub-filter)', async () => {
      setupPurgeArchivedFacesMocks();

      await service.purgeArchivedFaces(dto, USER_ID, PERMS);

      expect(mockPrisma.face.deleteMany).toHaveBeenCalledWith({
        where: { circleId: CIRCLE_ID, personId: null, hiddenAt: { not: null } },
      });
    });

    it('captures affected media items via face.findMany using the same where clause plus distinct: [mediaItemId]', async () => {
      setupPurgeArchivedFacesMocks();

      await service.purgeArchivedFaces(dto, USER_ID, PERMS);

      expect(mockPrisma.face.findMany).toHaveBeenCalledWith({
        where: { circleId: CIRCLE_ID, personId: null, hiddenAt: { not: null } },
        select: {
          mediaItemId: true,
          mediaItem: { select: { circleId: true } },
        },
        distinct: ['mediaItemId'],
      });
    });

    it('writes a face:purge_archived audit event inside the transaction with targetType circle and targetId=circleId', async () => {
      setupPurgeArchivedFacesMocks(1);

      await service.purgeArchivedFaces(dto, USER_ID, PERMS);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'face:purge_archived',
            actorUserId: USER_ID,
            targetType: 'circle',
            targetId: CIRCLE_ID,
            meta: expect.objectContaining({ circleId: CIRCLE_ID, count: 1 }),
          }),
        }),
      );
    });

    it('re-enqueues auto_tagging for affected media items after purge', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(true);
      setupPurgeArchivedFacesMocks(1, [
        {
          mediaItemId: MEDIA_ID,
          mediaItem: { circleId: CIRCLE_ID },
        },
      ]);

      await service.purgeArchivedFaces(dto, USER_ID, PERMS);

      expect(mockEnrichmentJobService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'auto_tagging',
          mediaItemId: MEDIA_ID,
          circleId: CIRCLE_ID,
        }),
      );
    });

    it('does not enqueue auto_tagging when there are no affected media items', async () => {
      mockSystemSettings.isFeatureEnabled.mockResolvedValue(true);
      setupPurgeArchivedFacesMocks(1, []);

      await service.purgeArchivedFaces(dto, USER_ID, PERMS);

      expect(mockEnrichmentJobService.enqueue).not.toHaveBeenCalled();
    });

    it('returns { deleted: count }', async () => {
      setupPurgeArchivedFacesMocks(2);

      const result = await service.purgeArchivedFaces(dto, USER_ID, PERMS);

      expect(result).toEqual({ deleted: 2 });
    });

    it('propagates ForbiddenException when assertCircleAccess denies access', async () => {
      const { ForbiddenException } = await import('@nestjs/common');
      mockCircleMembershipService.assertCircleAccess.mockRejectedValue(
        new ForbiddenException('Forbidden'),
      );

      await expect(
        service.purgeArchivedFaces(dto, USER_ID, PERMS),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
