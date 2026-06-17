/**
 * Unit tests for PeopleService.
 *
 * Covers: listPeople, getPerson, createPerson, updatePerson,
 * assignFaces, unassignFace, and clusterUnknowns.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PeopleService } from './people.service';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { FaceClusteringService } from './face-clustering.service';
import { FaceMatchingService } from './face-matching.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CIRCLE_ID = 'circle-uuid-0001';
const USER_ID = 'user-uuid-0001';
const PERSON_ID = 'person-uuid-0001';
const FACE_ID = 'face-uuid-0001';
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PeopleService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
        { provide: FaceClusteringService, useValue: mockClusteringService },
        { provide: FaceMatchingService, useValue: mockMatchingService },
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
      // assertFacesInCircle uses face.findMany
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([makeFace()]);
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
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([makeFace()]);
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
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([makeFace()]);
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
      (mockPrisma.face.findMany as jest.Mock).mockResolvedValue([]);

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
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ faceRecognitionEnabled: true });
      await service.clusterUnknowns(CIRCLE_ID, USER_ID, PERMS);

      expect(mockCircleMembershipService.assertCircleAccess).toHaveBeenCalledWith(
        USER_ID,
        CIRCLE_ID,
        PERMS,
        'circle_admin',
      );
    });

    it('delegates to clusteringService.clusterUnknownFaces', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ faceRecognitionEnabled: true });
      await service.clusterUnknowns(CIRCLE_ID, USER_ID, PERMS);

      expect(mockClusteringService.clusterUnknownFaces).toHaveBeenCalledWith(CIRCLE_ID, USER_ID);
    });

    it('returns the result from clusteringService', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ faceRecognitionEnabled: true });
      mockClusteringService.clusterUnknownFaces.mockResolvedValue({
        clustersCreated: 3,
        facesAssigned: 7,
      });

      const result = await service.clusterUnknowns(CIRCLE_ID, USER_ID, PERMS);

      expect(result).toEqual({ clustersCreated: 3, facesAssigned: 7 });
    });
  });

  // -------------------------------------------------------------------------
  // clusterUnknowns — Phase 4 opt-in gate
  // -------------------------------------------------------------------------

  describe('clusterUnknowns — Phase 4 opt-in gate', () => {
    it('throws BadRequestException when circle faceRecognitionEnabled is false', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ faceRecognitionEnabled: false });
      await expect(service.clusterUnknowns(CIRCLE_ID, USER_ID, PERMS)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when circle is null (not found)', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.clusterUnknowns(CIRCLE_ID, USER_ID, PERMS)).rejects.toThrow(BadRequestException);
    });

    it('calls clusteringService when circle faceRecognitionEnabled is true', async () => {
      (mockPrisma.circle.findUnique as jest.Mock).mockResolvedValue({ faceRecognitionEnabled: true });
      await service.clusterUnknowns(CIRCLE_ID, USER_ID, PERMS);
      expect(mockClusteringService.clusterUnknownFaces).toHaveBeenCalledWith(CIRCLE_ID, USER_ID);
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
});
