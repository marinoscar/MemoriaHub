/**
 * Unit tests for PeopleController — bulk hide / unhide / purge endpoints.
 *
 * Guards are overridden so we can test delegation without auth infrastructure.
 * No real HTTP, no database.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PeopleController } from './people.controller';
import { PeopleService } from './people.service';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

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
});
