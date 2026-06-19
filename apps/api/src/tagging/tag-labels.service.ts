import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
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
      await tx.tagLabel.delete({ where: { id } });

      // Delete all AI-sourced MediaTag instances for this label name (case-insensitive)
      await tx.mediaTag.deleteMany({
        where: {
          source: 'ai',
          tag: { name: { equals: label.name, mode: 'insensitive' } },
        },
      });

      // Clean up now-empty Tag rows for this label name
      const emptyTags = await tx.tag.findMany({
        where: {
          name: { equals: label.name, mode: 'insensitive' },
          mediaTags: { none: {} },
        },
        select: { id: true },
      });
      if (emptyTags.length > 0) {
        await tx.tag.deleteMany({
          where: { id: { in: emptyTags.map((t) => t.id) } },
        });
      }
    });
  }
}
