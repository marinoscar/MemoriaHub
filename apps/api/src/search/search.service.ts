import { Injectable, Logger } from '@nestjs/common';
import { Prisma, CircleRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import {
  SEARCHABLE_FIELDS,
  buildWhereFromFields,
  SearchableField,
} from './searchable-fields.registry';
import { SearchQueryDto } from './dto/search-query.dto';

// Re-export for controller convenience
export type SearchFieldDescriptor = Pick<
  SearchableField,
  'key' | 'label' | 'type' | 'enumValues' | 'description'
>;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembershipService: CircleMembershipService,
  ) {}

  async search(dto: SearchQueryDto, userId: string, userPermissions: string[]) {
    const { circleId, filters, page, pageSize, sortBy, sortOrder } = dto;

    await this.circleMembershipService.assertCircleAccess(
      userId,
      circleId,
      userPermissions,
      'viewer' as CircleRole,
    );

    const where = buildWhereFromFields(circleId, filters as Record<string, unknown>);
    const skip = (page - 1) * pageSize;
    const orderBy: Prisma.MediaItemOrderByWithRelationInput = { [sortBy]: sortOrder };

    const [items, totalItems] = await Promise.all([
      this.prisma.mediaItem.findMany({ where, orderBy, skip, take: pageSize }),
      this.prisma.mediaItem.count({ where }),
    ]);

    this.logger.log(
      `Search: circleId=${circleId} filters=${JSON.stringify(filters)} page=${page} total=${totalItems}`,
    );

    return {
      items,
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  getFields(): SearchFieldDescriptor[] {
    return SEARCHABLE_FIELDS.map(({ key, label, type, enumValues, description }) => ({
      key,
      label,
      type,
      ...(enumValues ? { enumValues } : {}),
      description,
    }));
  }
}
