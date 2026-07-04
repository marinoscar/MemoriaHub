/**
 * Unit tests for PeopleController — bulk hide / unhide / purge endpoints.
 *
 * Guards are overridden so we can test delegation without auth infrastructure.
 * No real HTTP, no database.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PeopleController } from './people.controller';
import { PeopleService } from './people.service';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';

// ---------------------------------------------------------------------------
// Mock PeopleService
// ---------------------------------------------------------------------------

const mockPeopleService = {
  listPeople: jest.fn(),
  listUnassignedFaces: jest.fn(),
  getPerson: jest.fn(),
  createPerson: jest.fn(),
  updatePerson: jest.fn(),
  assignFaces: jest.fn(),
  unassignFace: jest.fn(),
  clusterUnknowns: jest.fn(),
  mergePeople: jest.fn(),
  deletePerson: jest.fn(),
  hidePeople: jest.fn(),
  unhidePeople: jest.fn(),
  purgePeople: jest.fn(),
  hideFaces: jest.fn(),
  unhideFaces: jest.fn(),
  purgeFaces: jest.fn(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-1',
    email: 'user@example.com',
    roles: ['admin'],
    permissions: ['media:read', 'media:write', 'media:delete'],
    isActive: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PeopleController — bulk hide/unhide/purge', () => {
  let controller: PeopleController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PeopleController],
      providers: [
        { provide: PeopleService, useValue: mockPeopleService },
      ],
    })
      .overrideGuard(require('../auth/guards/jwt-auth.guard').JwtAuthGuard ?? Object)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PeopleController>(PeopleController);
  });

  // -------------------------------------------------------------------------
  // hidePeople
  // -------------------------------------------------------------------------

  describe('hidePeople', () => {
    it('delegates to peopleService.hidePeople with dto and user context', async () => {
      const dto = { circleId: 'circle-1', ids: ['person-1', 'person-2'] } as any;
      const user = makeUser();
      mockPeopleService.hidePeople.mockResolvedValue({ hidden: 2 });

      await controller.hidePeople(dto, user);

      expect(mockPeopleService.hidePeople).toHaveBeenCalledWith(dto, user.id, user.permissions);
    });

    it('returns the { hidden: count } result from the service', async () => {
      const dto = { circleId: 'circle-1', ids: ['person-1'] } as any;
      const user = makeUser();
      mockPeopleService.hidePeople.mockResolvedValue({ hidden: 1 });

      const result = await controller.hidePeople(dto, user);

      expect(result).toEqual({ hidden: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // unhidePeople
  // -------------------------------------------------------------------------

  describe('unhidePeople', () => {
    it('delegates to peopleService.unhidePeople with dto and user context', async () => {
      const dto = { circleId: 'circle-1', ids: ['person-1'] } as any;
      const user = makeUser();
      mockPeopleService.unhidePeople.mockResolvedValue({ unhidden: 1 });

      await controller.unhidePeople(dto, user);

      expect(mockPeopleService.unhidePeople).toHaveBeenCalledWith(dto, user.id, user.permissions);
    });

    it('returns the { unhidden: count } result from the service', async () => {
      const dto = { circleId: 'circle-1', ids: ['person-1', 'person-2'] } as any;
      const user = makeUser();
      mockPeopleService.unhidePeople.mockResolvedValue({ unhidden: 2 });

      const result = await controller.unhidePeople(dto, user);

      expect(result).toEqual({ unhidden: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // purgePeople
  // -------------------------------------------------------------------------

  describe('purgePeople', () => {
    it('delegates to peopleService.purgePeople with dto and user context', async () => {
      const dto = { circleId: 'circle-1', ids: ['person-1'] } as any;
      const user = makeUser();
      mockPeopleService.purgePeople.mockResolvedValue({ deleted: 1 });

      await controller.purgePeople(dto, user);

      expect(mockPeopleService.purgePeople).toHaveBeenCalledWith(dto, user.id, user.permissions);
    });

    it('returns the { deleted: count } result from the service', async () => {
      const dto = { circleId: 'circle-1', ids: ['person-1', 'person-2', 'person-3'] } as any;
      const user = makeUser();
      mockPeopleService.purgePeople.mockResolvedValue({ deleted: 3 });

      const result = await controller.purgePeople(dto, user);

      expect(result).toEqual({ deleted: 3 });
    });
  });

  // -------------------------------------------------------------------------
  // listPeople — hidden query flag
  // -------------------------------------------------------------------------

  describe('listPeople — hidden query', () => {
    it('delegates to peopleService.listPeople passing hidden:true in query', async () => {
      const query = { circleId: 'circle-1', hidden: true, page: 1, pageSize: 20 } as any;
      const user = makeUser();
      mockPeopleService.listPeople.mockResolvedValue({ items: [], meta: {} });

      await controller.listPeople(query, user);

      expect(mockPeopleService.listPeople).toHaveBeenCalledWith(query, user.id, user.permissions);
    });

    it('delegates to peopleService.listPeople passing hidden:false (default) when not set', async () => {
      const query = { circleId: 'circle-1', page: 1, pageSize: 20 } as any;
      const user = makeUser();
      mockPeopleService.listPeople.mockResolvedValue({ items: [], meta: {} });

      await controller.listPeople(query, user);

      expect(mockPeopleService.listPeople).toHaveBeenCalledWith(query, user.id, user.permissions);
    });

    it('returns the paginated people list from the service', async () => {
      const query = { circleId: 'circle-1', hidden: true, page: 1, pageSize: 20 } as any;
      const user = makeUser();
      const expected = {
        items: [{ id: 'person-1', name: 'Alice', hiddenAt: new Date().toISOString() }],
        meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
      };
      mockPeopleService.listPeople.mockResolvedValue(expected);

      const result = await controller.listPeople(query, user);

      expect(result).toEqual(expected);
    });
  });

  // -------------------------------------------------------------------------
  // hideFaces
  // -------------------------------------------------------------------------

  describe('hideFaces', () => {
    it('delegates to peopleService.hideFaces with dto and user context', async () => {
      const dto = { circleId: 'circle-1', ids: ['face-1', 'face-2'] } as any;
      const user = makeUser();
      mockPeopleService.hideFaces.mockResolvedValue({ hidden: 2 });

      await controller.hideFaces(dto, user);

      expect(mockPeopleService.hideFaces).toHaveBeenCalledWith(dto, user.id, user.permissions);
    });

    it('returns the { hidden: count } result from the service', async () => {
      const dto = { circleId: 'circle-1', ids: ['face-1'] } as any;
      const user = makeUser();
      mockPeopleService.hideFaces.mockResolvedValue({ hidden: 1 });

      const result = await controller.hideFaces(dto, user);

      expect(result).toEqual({ hidden: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // unhideFaces
  // -------------------------------------------------------------------------

  describe('unhideFaces', () => {
    it('delegates to peopleService.unhideFaces with dto and user context', async () => {
      const dto = { circleId: 'circle-1', ids: ['face-1'] } as any;
      const user = makeUser();
      mockPeopleService.unhideFaces.mockResolvedValue({ unhidden: 1 });

      await controller.unhideFaces(dto, user);

      expect(mockPeopleService.unhideFaces).toHaveBeenCalledWith(dto, user.id, user.permissions);
    });

    it('returns the { unhidden: count } result from the service', async () => {
      const dto = { circleId: 'circle-1', ids: ['face-1', 'face-2'] } as any;
      const user = makeUser();
      mockPeopleService.unhideFaces.mockResolvedValue({ unhidden: 2 });

      const result = await controller.unhideFaces(dto, user);

      expect(result).toEqual({ unhidden: 2 });
    });
  });

  // -------------------------------------------------------------------------
  // purgeFaces
  // -------------------------------------------------------------------------

  describe('purgeFaces', () => {
    it('delegates to peopleService.purgeFaces with dto and user context', async () => {
      const dto = { circleId: 'circle-1', ids: ['face-1'] } as any;
      const user = makeUser();
      mockPeopleService.purgeFaces.mockResolvedValue({ deleted: 1 });

      await controller.purgeFaces(dto, user);

      expect(mockPeopleService.purgeFaces).toHaveBeenCalledWith(dto, user.id, user.permissions);
    });

    it('returns the { deleted: count } result from the service', async () => {
      const dto = { circleId: 'circle-1', ids: ['face-1', 'face-2', 'face-3'] } as any;
      const user = makeUser();
      mockPeopleService.purgeFaces.mockResolvedValue({ deleted: 3 });

      const result = await controller.purgeFaces(dto, user);

      expect(result).toEqual({ deleted: 3 });
    });
  });

  // -------------------------------------------------------------------------
  // Route metadata: the three new face bulk routes exist, are wired to the
  // correct HTTP verb + permission guard, and are declared BEFORE the
  // `:id`-shaped routes (GET/PATCH/DELETE :id, POST :id/faces) so that
  // Fastify's literal-segment-first routing does not treat "faces" as an
  // :id param. See the controller's inline routing-order comments.
  // -------------------------------------------------------------------------

  describe('route wiring — faces/bulk/* endpoints', () => {
    const reflector = new Reflector();

    function routeMeta(handlerName: keyof PeopleController) {
      const handler = (PeopleController.prototype as any)[handlerName];
      return {
        path: reflector.get<string>(PATH_METADATA, handler),
        method: reflector.get<number>(METHOD_METADATA, handler),
        permissions: reflector.get<string[]>(PERMISSIONS_KEY, handler),
      };
    }

    it('PATCH /people/faces/bulk/hide requires media:write', () => {
      const meta = routeMeta('hideFaces');
      expect(meta.path).toBe('faces/bulk/hide');
      expect(meta.method).toBe(RequestMethod.PATCH);
      expect(meta.permissions).toEqual([PERMISSIONS.MEDIA_WRITE]);
    });

    it('PATCH /people/faces/bulk/unhide requires media:write', () => {
      const meta = routeMeta('unhideFaces');
      expect(meta.path).toBe('faces/bulk/unhide');
      expect(meta.method).toBe(RequestMethod.PATCH);
      expect(meta.permissions).toEqual([PERMISSIONS.MEDIA_WRITE]);
    });

    it('POST /people/faces/bulk/purge requires media:delete', () => {
      const meta = routeMeta('purgeFaces');
      expect(meta.path).toBe('faces/bulk/purge');
      expect(meta.method).toBe(RequestMethod.POST);
      expect(meta.permissions).toEqual([PERMISSIONS.MEDIA_DELETE]);
    });

    it('does not shadow GET /people/:id — path literal differs from a param pattern', () => {
      const getPersonMeta = routeMeta('getPerson');
      expect(getPersonMeta.path).toBe(':id');
      // Literal "faces" segment routes must not equal or begin matching as ":id"
      expect(routeMeta('hideFaces').path).not.toBe(':id');
      expect(routeMeta('unhideFaces').path).not.toBe(':id');
      expect(routeMeta('purgeFaces').path).not.toBe(':id');
    });

    it('faces/bulk/* handlers are declared before the :id-shaped handlers on the prototype ' +
      '(Fastify requires literal routes registered before param routes to avoid shadowing)', () => {
      const order = Object.getOwnPropertyNames(PeopleController.prototype);
      const idxHideFaces = order.indexOf('hideFaces');
      const idxUnhideFaces = order.indexOf('unhideFaces');
      const idxPurgeFaces = order.indexOf('purgeFaces');
      const idxGetPerson = order.indexOf('getPerson');
      const idxAssignFaces = order.indexOf('assignFaces'); // POST :id/faces

      expect(idxHideFaces).toBeGreaterThanOrEqual(0);
      expect(idxUnhideFaces).toBeGreaterThanOrEqual(0);
      expect(idxPurgeFaces).toBeGreaterThanOrEqual(0);
      expect(idxGetPerson).toBeGreaterThanOrEqual(0);
      expect(idxAssignFaces).toBeGreaterThanOrEqual(0);

      expect(idxHideFaces).toBeLessThan(idxGetPerson);
      expect(idxUnhideFaces).toBeLessThan(idxGetPerson);
      expect(idxPurgeFaces).toBeLessThan(idxGetPerson);
      expect(idxHideFaces).toBeLessThan(idxAssignFaces);
      expect(idxUnhideFaces).toBeLessThan(idxAssignFaces);
      expect(idxPurgeFaces).toBeLessThan(idxAssignFaces);
    });
  });
});
