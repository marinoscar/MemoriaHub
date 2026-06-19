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
  description: z.string().max(500).optional(),
});

export class CreateTagLabelDto extends createZodDto(createTagLabelSchema) {}

export const updateTagLabelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
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
        data: { name: dto.name, description: dto.description },
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
          ...(dto.description !== undefined && { description: dto.description }),
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
    try {
      await this.prisma.tagLabel.delete({ where: { id } });
    } catch (e: any) {
      if (e.code === 'P2025')
        throw new NotFoundException(`Tag label ${id} not found`);
      throw e;
    }
  }
}
