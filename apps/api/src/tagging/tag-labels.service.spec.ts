/**
 * Unit tests for TagLabelsService.
 *
 * Covers CRUD operations and error mapping:
 *   - create: success and P2002 → ConflictException
 *   - getAll: returns ordered list
 *   - update: success, P2025 → NotFoundException, P2002 → ConflictException
 *   - remove: success, P2025 → NotFoundException
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TagLabelsService } from './tag-labels.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTagLabel(overrides: Partial<{
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  createdAt: Date;
}> = {}) {
  return {
    id: 'label-1',
    name: 'Beach',
    description: null,
    enabled: true,
    createdAt: new Date(),
    ...overrides,
  };
}

// Simulate Prisma error codes
function makePrismaError(code: string) {
  const err = new Error(`Prisma error ${code}`) as any;
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TagLabelsService', () => {
  let service: TagLabelsService;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TagLabelsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TagLabelsService>(TagLabelsService);
  });

  // -------------------------------------------------------------------------
  // getAll
  // -------------------------------------------------------------------------

  describe('getAll', () => {
    it('returns all tag labels ordered by name ascending', async () => {
      const labels = [
        makeTagLabel({ id: 'label-1', name: 'Beach' }),
        makeTagLabel({ id: 'label-2', name: 'Sunset' }),
      ];
      (mockPrisma.tagLabel.findMany as jest.Mock).mockResolvedValue(labels);

      const result = await service.getAll();

      expect(result).toEqual(labels);
      expect(mockPrisma.tagLabel.findMany).toHaveBeenCalledWith({
        orderBy: { name: 'asc' },
      });
    });

    it('returns an empty array when no labels exist', async () => {
      (mockPrisma.tagLabel.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.getAll();

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe('create', () => {
    it('creates and returns the new tag label', async () => {
      const newLabel = makeTagLabel({ name: 'Beach', description: 'Sandy shores' });
      (mockPrisma.tagLabel.create as jest.Mock).mockResolvedValue(newLabel);

      const result = await service.create({
        name: 'Beach',
        description: 'Sandy shores',
      });

      expect(result).toEqual(newLabel);
      expect(mockPrisma.tagLabel.create).toHaveBeenCalledWith({
        data: { name: 'Beach', description: 'Sandy shores' },
      });
    });

    it('creates without description when description is omitted', async () => {
      const newLabel = makeTagLabel({ name: 'Mountain', description: undefined });
      (mockPrisma.tagLabel.create as jest.Mock).mockResolvedValue(newLabel);

      await service.create({ name: 'Mountain' });

      expect(mockPrisma.tagLabel.create).toHaveBeenCalledWith({
        data: { name: 'Mountain', description: undefined },
      });
    });

    it('throws ConflictException on P2002 (duplicate name)', async () => {
      (mockPrisma.tagLabel.create as jest.Mock).mockRejectedValue(
        makePrismaError('P2002'),
      );

      await expect(service.create({ name: 'Beach' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('includes the duplicate label name in the ConflictException message', async () => {
      (mockPrisma.tagLabel.create as jest.Mock).mockRejectedValue(
        makePrismaError('P2002'),
      );

      await expect(service.create({ name: 'Beach' })).rejects.toThrow(
        /Beach/,
      );
    });

    it('rethrows non-Prisma errors as-is', async () => {
      const genericError = new Error('Unexpected DB failure');
      (mockPrisma.tagLabel.create as jest.Mock).mockRejectedValue(genericError);

      await expect(service.create({ name: 'Beach' })).rejects.toThrow(
        'Unexpected DB failure',
      );
    });
  });

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  describe('update', () => {
    it('updates and returns the tag label', async () => {
      const updated = makeTagLabel({ name: 'Sunrise', enabled: false });
      (mockPrisma.tagLabel.update as jest.Mock).mockResolvedValue(updated);

      const result = await service.update('label-1', {
        name: 'Sunrise',
        enabled: false,
      });

      expect(result).toEqual(updated);
    });

    it('updates only supplied fields (partial update)', async () => {
      const updated = makeTagLabel({ enabled: false });
      (mockPrisma.tagLabel.update as jest.Mock).mockResolvedValue(updated);

      await service.update('label-1', { enabled: false });

      expect(mockPrisma.tagLabel.update).toHaveBeenCalledWith({
        where: { id: 'label-1' },
        data: { enabled: false },
      });
    });

    it('throws NotFoundException on P2025 (record not found)', async () => {
      (mockPrisma.tagLabel.update as jest.Mock).mockRejectedValue(
        makePrismaError('P2025'),
      );

      await expect(service.update('missing-id', { name: 'X' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ConflictException on P2002 (name conflict on rename)', async () => {
      (mockPrisma.tagLabel.update as jest.Mock).mockRejectedValue(
        makePrismaError('P2002'),
      );

      await expect(
        service.update('label-1', { name: 'Beach' }),
      ).rejects.toThrow(ConflictException);
    });

    it('rethrows non-Prisma errors as-is', async () => {
      const genericError = new Error('Network error');
      (mockPrisma.tagLabel.update as jest.Mock).mockRejectedValue(genericError);

      await expect(service.update('label-1', { name: 'X' })).rejects.toThrow(
        'Network error',
      );
    });
  });

  // -------------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------------

  describe('remove', () => {
    it('deletes the tag label without returning a value', async () => {
      (mockPrisma.tagLabel.delete as jest.Mock).mockResolvedValue(
        makeTagLabel(),
      );

      await expect(service.remove('label-1')).resolves.toBeUndefined();

      expect(mockPrisma.tagLabel.delete).toHaveBeenCalledWith({
        where: { id: 'label-1' },
      });
    });

    it('throws NotFoundException on P2025 (record not found)', async () => {
      (mockPrisma.tagLabel.delete as jest.Mock).mockRejectedValue(
        makePrismaError('P2025'),
      );

      await expect(service.remove('missing-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rethrows non-Prisma errors as-is', async () => {
      const genericError = new Error('FK violation');
      (mockPrisma.tagLabel.delete as jest.Mock).mockRejectedValue(genericError);

      await expect(service.remove('label-1')).rejects.toThrow('FK violation');
    });
  });
});
