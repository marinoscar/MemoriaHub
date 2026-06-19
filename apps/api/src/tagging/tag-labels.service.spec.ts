/**
 * Unit tests for TagLabelsService.
 *
 * Covers CRUD operations and error mapping:
 *   - create: success and P2002 → ConflictException
 *   - getAll: returns ordered list
 *   - update: success, P2025 → NotFoundException, P2002 → ConflictException
 *   - remove: success, P2025 → NotFoundException
 *   - exportToCsv: returns CSV string with header id,name
 *   - importFromCsv: create / update / delete rows, error collection
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
  enabled: boolean;
  createdAt: Date;
}> = {}) {
  return {
    id: 'label-1',
    name: 'Beach',
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
      const newLabel = makeTagLabel({ name: 'Beach' });
      (mockPrisma.tagLabel.create as jest.Mock).mockResolvedValue(newLabel);

      const result = await service.create({ name: 'Beach' });

      expect(result).toEqual(newLabel);
      expect(mockPrisma.tagLabel.create).toHaveBeenCalledWith({
        data: { name: 'Beach' },
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
    const label = makeTagLabel({ id: 'label-1', name: 'Beach' });

    beforeEach(() => {
      // Default: label found
      (mockPrisma.tagLabel.findUnique as jest.Mock).mockResolvedValue(label);
      (mockPrisma.tagLabel.delete as jest.Mock).mockResolvedValue(label);
      (mockPrisma.mediaTag.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (mockPrisma.tag.findMany as jest.Mock).mockResolvedValue([]);
      // $transaction executes callback
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(mockPrisma));
    });

    it('resolves without returning a value on success', async () => {
      await expect(service.remove('label-1')).resolves.toBeUndefined();
    });

    it('deletes the tag label inside the transaction', async () => {
      await service.remove('label-1');
      expect(mockPrisma.tagLabel.delete).toHaveBeenCalledWith({ where: { id: 'label-1' } });
    });

    it('calls tx.mediaTag.deleteMany for AI-sourced instances of the label (case-insensitive)', async () => {
      await service.remove('label-1');
      expect(mockPrisma.mediaTag.deleteMany).toHaveBeenCalledWith({
        where: {
          source: 'ai',
          tag: { name: { equals: 'Beach', mode: 'insensitive' } },
        },
      });
    });

    it('deletes now-empty Tag rows after removing AI MediaTags', async () => {
      (mockPrisma.tag.findMany as jest.Mock).mockResolvedValue([{ id: 'tag-beach' }]);

      await service.remove('label-1');

      expect(mockPrisma.tag.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['tag-beach'] } },
      });
    });

    it('does NOT call tag.deleteMany when no empty tags remain', async () => {
      (mockPrisma.tag.findMany as jest.Mock).mockResolvedValue([]);

      await service.remove('label-1');

      expect(mockPrisma.tag.deleteMany).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when label does not exist', async () => {
      (mockPrisma.tagLabel.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.remove('missing-id')).rejects.toThrow(NotFoundException);
    });

    it('does not call $transaction when label is not found (early 404)', async () => {
      (mockPrisma.tagLabel.findUnique as jest.Mock).mockResolvedValue(null);

      try { await service.remove('missing-id'); } catch {}

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('preserves manual MediaTag instances (only AI source is deleted)', async () => {
      await service.remove('label-1');
      const deleteManyCalls = (mockPrisma.mediaTag.deleteMany as jest.Mock).mock.calls;
      expect(deleteManyCalls).toHaveLength(1);
      expect(deleteManyCalls[0][0].where.source).toBe('ai');
    });

    it('rethrows non-404 errors from the transaction', async () => {
      (mockPrisma.$transaction as jest.Mock).mockRejectedValue(new Error('DB error'));

      await expect(service.remove('label-1')).rejects.toThrow('DB error');
    });
  });

  // -------------------------------------------------------------------------
  // exportToCsv
  // -------------------------------------------------------------------------

  describe('exportToCsv', () => {
    it('returns a CSV string with header id,name and one row per label', async () => {
      (mockPrisma.tagLabel.findMany as jest.Mock).mockResolvedValue([
        { id: 'label-1', name: 'Beach' },
        { id: 'label-2', name: 'Sunset' },
      ]);

      const csv = await service.exportToCsv();

      const lines = csv.trim().split('\n');
      expect(lines[0]).toBe('id,name');
      expect(lines[1]).toContain('label-1');
      expect(lines[1]).toContain('Beach');
      expect(lines[2]).toContain('label-2');
      expect(lines[2]).toContain('Sunset');
    });

    it('returns only the header row when no labels exist', async () => {
      (mockPrisma.tagLabel.findMany as jest.Mock).mockResolvedValue([]);

      const csv = await service.exportToCsv();

      const lines = csv.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe('id,name');
    });

    it('queries with orderBy name ascending and selects only id and name', async () => {
      (mockPrisma.tagLabel.findMany as jest.Mock).mockResolvedValue([]);

      await service.exportToCsv();

      expect(mockPrisma.tagLabel.findMany).toHaveBeenCalledWith({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
    });
  });

  // -------------------------------------------------------------------------
  // importFromCsv
  // -------------------------------------------------------------------------

  describe('importFromCsv', () => {
    beforeEach(() => {
      // Default: transaction executes the callback immediately
      (mockPrisma.$transaction as jest.Mock).mockImplementation(
        async (fn: any) => fn(mockPrisma),
      );
    });

    it('creates a new label when id is absent', async () => {
      (mockPrisma.tagLabel.create as jest.Mock).mockResolvedValue(
        makeTagLabel({ name: 'Beach' }),
      );

      const summary = await service.importFromCsv([{ name: 'Beach' }]);

      expect(summary.created).toBe(1);
      expect(summary.updated).toBe(0);
      expect(summary.deleted).toBe(0);
      expect(summary.errors).toHaveLength(0);
      expect(mockPrisma.tagLabel.create).toHaveBeenCalledWith({
        data: { name: 'Beach' },
      });
    });

    it('updates an existing label when id and name are present', async () => {
      (mockPrisma.tagLabel.update as jest.Mock).mockResolvedValue(
        makeTagLabel({ id: 'label-1', name: 'Sunrise' }),
      );

      const summary = await service.importFromCsv([
        { id: 'label-1', name: 'Sunrise' },
      ]);

      expect(summary.updated).toBe(1);
      expect(summary.created).toBe(0);
      expect(summary.deleted).toBe(0);
      expect(summary.errors).toHaveLength(0);
      expect(mockPrisma.tagLabel.update).toHaveBeenCalledWith({
        where: { id: 'label-1' },
        data: { name: 'Sunrise' },
      });
    });

    it('deletes a label when delete is truthy and id is present', async () => {
      const label = makeTagLabel({ id: 'label-1', name: 'Beach' });
      (mockPrisma.tagLabel.findUnique as jest.Mock).mockResolvedValue(label);
      (mockPrisma.tagLabel.delete as jest.Mock).mockResolvedValue(label);
      (mockPrisma.mediaTag.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (mockPrisma.tag.findMany as jest.Mock).mockResolvedValue([]);

      const summary = await service.importFromCsv([
        { id: 'label-1', delete: 'true' },
      ]);

      expect(summary.deleted).toBe(1);
      expect(summary.created).toBe(0);
      expect(summary.updated).toBe(0);
      expect(summary.errors).toHaveLength(0);
      expect(mockPrisma.tagLabel.delete).toHaveBeenCalledWith({
        where: { id: 'label-1' },
      });
    });

    it.each([['true'], ['1'], ['yes'], ['TRUE'], ['YES'], ['1']])(
      'recognises delete=%s as truthy',
      async (deleteVal) => {
        const label = makeTagLabel({ id: 'label-1', name: 'Beach' });
        (mockPrisma.tagLabel.findUnique as jest.Mock).mockResolvedValue(label);
        (mockPrisma.tagLabel.delete as jest.Mock).mockResolvedValue(label);
        (mockPrisma.mediaTag.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
        (mockPrisma.tag.findMany as jest.Mock).mockResolvedValue([]);

        const summary = await service.importFromCsv([
          { id: 'label-1', delete: deleteVal },
        ]);

        expect(summary.deleted).toBe(1);
        expect(summary.errors).toHaveLength(0);
      },
    );

    it('records an error and continues when delete=true but no id', async () => {
      (mockPrisma.tagLabel.create as jest.Mock).mockResolvedValue(
        makeTagLabel({ name: 'Valid' }),
      );

      const summary = await service.importFromCsv([
        { delete: 'true' },     // error: no id
        { name: 'Valid' },      // create: succeeds
      ]);

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0].message).toMatch(/no id/i);
    });

    it('records an error when create row has no name (empty string)', async () => {
      // A row with a blank name but no id → CREATE branch; name required
      const summary = await service.importFromCsv([{ name: '   ' }]);

      expect(summary.created).toBe(0);
      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0].message).toMatch(/name is required/i);
    });

    it('records an error when update row has no name', async () => {
      const summary = await service.importFromCsv([{ id: 'label-1' }]);

      expect(summary.updated).toBe(0);
      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0].message).toMatch(/name is required/i);
    });

    it('records a conflict error on P2002 during create and continues', async () => {
      (mockPrisma.tagLabel.create as jest.Mock)
        .mockRejectedValueOnce(makePrismaError('P2002'))
        .mockResolvedValue(makeTagLabel({ name: 'Other' }));

      const summary = await service.importFromCsv([
        { name: 'Beach' },
        { name: 'Other' },
      ]);

      expect(summary.created).toBe(1);
      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0].message).toMatch(/already exists/i);
    });

    it('records a not-found error on P2025 during update and continues', async () => {
      (mockPrisma.tagLabel.update as jest.Mock)
        .mockRejectedValueOnce(makePrismaError('P2025'))
        .mockResolvedValue(makeTagLabel({ name: 'Good' }));

      const summary = await service.importFromCsv([
        { id: 'missing', name: 'X' },
        { id: 'label-1', name: 'Good' },
      ]);

      expect(summary.updated).toBe(1);
      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0].message).toMatch(/not found/i);
    });

    it('skips rows where all columns are undefined without recording an error', async () => {
      // {} has no id/name/delete keys at all — treated as an empty row
      const summary = await service.importFromCsv([{}]);

      expect(summary.created).toBe(0);
      expect(summary.errors).toHaveLength(0);
    });

    it('returns correct row numbers in errors (offset by header row)', async () => {
      const summary = await service.importFromCsv([
        { delete: 'true' }, // row 2 (header is row 1)
      ]);

      expect(summary.errors[0].row).toBe(2);
    });

    it('handles a mixed batch: create + update + delete + error', async () => {
      const labelToDelete = makeTagLabel({ id: 'label-2', name: 'OldName' });
      (mockPrisma.tagLabel.create as jest.Mock).mockResolvedValue(
        makeTagLabel({ name: 'New' }),
      );
      (mockPrisma.tagLabel.update as jest.Mock).mockResolvedValue(
        makeTagLabel({ id: 'label-1', name: 'Renamed' }),
      );
      (mockPrisma.tagLabel.findUnique as jest.Mock).mockResolvedValue(labelToDelete);
      (mockPrisma.tagLabel.delete as jest.Mock).mockResolvedValue(labelToDelete);
      (mockPrisma.mediaTag.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (mockPrisma.tag.findMany as jest.Mock).mockResolvedValue([]);

      const summary = await service.importFromCsv([
        { name: 'New' },                      // create
        { id: 'label-1', name: 'Renamed' },   // update
        { id: 'label-2', delete: '1' },       // delete
        { delete: 'yes' },                    // error: no id
      ]);

      expect(summary.created).toBe(1);
      expect(summary.updated).toBe(1);
      expect(summary.deleted).toBe(1);
      expect(summary.errors).toHaveLength(1);
    });

    it('CSV delete triggers cascade: calls mediaTag.deleteMany with source=ai and label name', async () => {
      const label = makeTagLabel({ id: 'label-1', name: 'Beach' });
      (mockPrisma.tagLabel.findUnique as jest.Mock).mockResolvedValue(label);
      (mockPrisma.tagLabel.delete as jest.Mock).mockResolvedValue(label);
      (mockPrisma.mediaTag.deleteMany as jest.Mock).mockResolvedValue({ count: 3 });
      (mockPrisma.tag.findMany as jest.Mock).mockResolvedValue([]);

      await service.importFromCsv([{ id: 'label-1', delete: 'true' }]);

      expect(mockPrisma.mediaTag.deleteMany).toHaveBeenCalledWith({
        where: {
          source: 'ai',
          tag: { name: { equals: 'Beach', mode: 'insensitive' } },
        },
      });
    });

    it('CSV delete cascade cleans up now-empty Tag rows', async () => {
      const label = makeTagLabel({ id: 'label-1', name: 'Beach' });
      (mockPrisma.tagLabel.findUnique as jest.Mock).mockResolvedValue(label);
      (mockPrisma.tagLabel.delete as jest.Mock).mockResolvedValue(label);
      (mockPrisma.mediaTag.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
      (mockPrisma.tag.findMany as jest.Mock).mockResolvedValue([{ id: 'tag-beach' }]);
      (mockPrisma.tag.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.importFromCsv([{ id: 'label-1', delete: 'true' }]);

      expect(mockPrisma.tag.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['tag-beach'] } },
      });
    });

    it('CSV delete records not-found error when label does not exist and continues', async () => {
      (mockPrisma.tagLabel.findUnique as jest.Mock).mockResolvedValue(null);
      (mockPrisma.tagLabel.create as jest.Mock).mockResolvedValue(
        makeTagLabel({ name: 'Other' }),
      );

      const summary = await service.importFromCsv([
        { id: 'missing-id', delete: 'true' },   // not found → error
        { name: 'Other' },                       // create → succeeds
      ]);

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0].message).toMatch(/not found/i);
      expect(summary.created).toBe(1);
      // No cascade calls should have been made for the missing label
      expect(mockPrisma.tagLabel.delete).not.toHaveBeenCalled();
      expect(mockPrisma.mediaTag.deleteMany).not.toHaveBeenCalled();
    });
  });
});
