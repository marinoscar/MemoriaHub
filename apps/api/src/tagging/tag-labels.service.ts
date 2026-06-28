import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { stringify as csvStringify } from 'csv-stringify/sync';
import { PrismaService } from '../prisma/prisma.service';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export const createTagLabelSchema = z.object({
  name: z.string().min(1).max(100),
});

export class CreateTagLabelDto extends createZodDto(createTagLabelSchema) {}

export const updateTagLabelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
});

export class UpdateTagLabelDto extends createZodDto(updateTagLabelSchema) {}

// ---------------------------------------------------------------------------
// CSV import types
// ---------------------------------------------------------------------------

/** A single parsed CSV row passed in from the controller. */
export interface TagLabelCsvRow {
  /** Present on UPDATE and DELETE rows; blank/missing for CREATE. */
  id?: string;
  name?: string;
  /** Truthy when the row requests deletion: 'true', '1', 'yes' (case-insensitive). */
  delete?: string;
}

export interface ImportSummary {
  created: number;
  updated: number;
  deleted: number;
  errors: Array<{ row: number; message: string }>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class TagLabelsService {
  constructor(private readonly prisma: PrismaService) {}

  getAll() {
    return this.prisma.tagLabel.findMany({ orderBy: { name: 'asc' } });
  }

  async create(dto: CreateTagLabelDto) {
    try {
      return await this.prisma.tagLabel.create({
        data: { name: dto.name },
      });
    } catch (e: any) {
      if (e.code === 'P2002')
        throw new ConflictException(`Tag label "${dto.name}" already exists`);
      throw e;
    }
  }

  async update(id: string, dto: UpdateTagLabelDto) {
    try {
      return await this.prisma.tagLabel.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        },
      });
    } catch (e: any) {
      if (e.code === 'P2025')
        throw new NotFoundException(`Tag label ${id} not found`);
      if (e.code === 'P2002')
        throw new ConflictException(`Tag label name already exists`);
      throw e;
    }
  }

  async remove(id: string) {
    const label = await this.prisma.tagLabel.findUnique({ where: { id } });
    if (!label) {
      throw new NotFoundException(`Tag label ${id} not found`);
    }

    await this.prisma.$transaction(async (tx) => {
      await this.cascadeDeleteLabel(tx, id, label.name);
    });
  }

  private async cascadeDeleteLabel(
    tx: Prisma.TransactionClient,
    labelId: string,
    labelName: string,
  ): Promise<void> {
    await tx.tagLabel.delete({ where: { id: labelId } });

    // Delete all AI-sourced MediaTag instances for this label name (case-insensitive)
    await tx.mediaTag.deleteMany({
      where: {
        source: 'ai',
        tag: { name: { equals: labelName, mode: 'insensitive' } },
      },
    });

    // Clean up now-empty Tag rows for this label name (never delete system tags)
    const emptyTags = await tx.tag.findMany({
      where: {
        name: { equals: labelName, mode: 'insensitive' },
        mediaTags: { none: {} },
        isSystem: false, // Never auto-delete system tags
      },
      select: { id: true },
    });
    if (emptyTags.length > 0) {
      await tx.tag.deleteMany({
        where: { id: { in: emptyTags.map((t) => t.id) } },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------------

  /** Return a UTF-8 CSV string with header `id,name` ordered by name. */
  async exportToCsv(): Promise<string> {
    const labels = await this.prisma.tagLabel.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });

    return csvStringify(labels, { header: true, columns: ['id', 'name'] });
  }

  // ---------------------------------------------------------------------------
  // CSV import
  // ---------------------------------------------------------------------------

  /**
   * Apply a batch of pre-parsed CSV rows.
   *
   * The controller is responsible for parsing the raw CSV bytes (using
   * csv-parse) and passing plain row objects here, keeping this method
   * unit-testable without the csv-parse package.
   *
   * Per-row semantics:
   *   - `delete` truthy → delete by id (id required)
   *   - `id` absent/blank → CREATE with name
   *   - `id` present, not delete → UPDATE name by id
   *   - Empty rows (no id, no name, no delete) are skipped
   *
   * Errors on individual rows are collected; the batch continues.
   * The whole set runs inside a single transaction so all successful
   * mutations commit atomically.
   */
  async importFromCsv(rows: TagLabelCsvRow[]): Promise<ImportSummary> {
    const summary: ImportSummary = {
      created: 0,
      updated: 0,
      deleted: 0,
      errors: [],
    };

    const isDeleteTruthy = (val: string | undefined): boolean => {
      if (!val) return false;
      return ['true', '1', 'yes'].includes(val.trim().toLowerCase());
    };

    // Process inside a transaction so successful rows commit together.
    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2; // 1-indexed, offset by header row

        // Skip rows where every column is absent or undefined (e.g. csv-parse
        // blank lines that slip through).  Whitespace-only strings are NOT
        // skipped — they will be caught as validation errors below.
        if (
          row.id === undefined &&
          row.name === undefined &&
          row.delete === undefined
        ) {
          continue;
        }

        const id = row.id?.trim() || undefined;
        const name = row.name?.trim() || undefined;
        const wantDelete = isDeleteTruthy(row.delete);

        if (wantDelete) {
          if (!id) {
            summary.errors.push({
              row: rowNum,
              message: 'delete=true but no id provided',
            });
            continue;
          }
          // Fetch the label first to get its name for the cascade
          const labelToDelete = await tx.tagLabel.findUnique({ where: { id } });
          if (!labelToDelete) {
            summary.errors.push({
              row: rowNum,
              message: `Tag label ${id} not found`,
            });
            continue;
          }
          try {
            await this.cascadeDeleteLabel(tx, id, labelToDelete.name);
            summary.deleted++;
          } catch (e: any) {
            summary.errors.push({
              row: rowNum,
              message: `Delete failed: ${(e as Error).message}`,
            });
          }
        } else if (!id) {
          // CREATE
          if (!name) {
            summary.errors.push({ row: rowNum, message: 'name is required for create (id is blank)' });
            continue;
          }
          try {
            await tx.tagLabel.create({ data: { name } });
            summary.created++;
          } catch (e: any) {
            summary.errors.push({
              row: rowNum,
              message: e.code === 'P2002'
                ? `Tag label "${name}" already exists`
                : `Create failed: ${e.message}`,
            });
          }
        } else {
          // UPDATE
          if (!name) {
            summary.errors.push({ row: rowNum, message: `name is required for update (id=${id})` });
            continue;
          }
          try {
            await tx.tagLabel.update({ where: { id }, data: { name } });
            summary.updated++;
          } catch (e: any) {
            summary.errors.push({
              row: rowNum,
              message: e.code === 'P2025'
                ? `Tag label ${id} not found`
                : e.code === 'P2002'
                  ? `Tag label "${name}" already exists`
                  : `Update failed: ${e.message}`,
            });
          }
        }
      }
    });

    return summary;
  }
}
