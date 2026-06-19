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
  'key' | 'label' | 'type' | 'enumValues' | 'optionsSource' | 'description'
>;

export interface SearchPaging {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: string;
}

export interface SearchResult {
  items: Prisma.MediaItemGetPayload<Record<string, never>>[];
  meta: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembershipService: CircleMembershipService,
  ) {}

  async runSearch(
    userId: string,
    circleId: string,
    permissions: string[],
    filters: Record<string, unknown>,
    paging?: SearchPaging,
  ): Promise<SearchResult> {
    const page = paging?.page ?? 1;
    const pageSize = paging?.pageSize ?? 20;
    const sortBy = paging?.sortBy ?? 'capturedAt';
    const sortOrder = paging?.sortOrder ?? 'desc';

    await this.circleMembershipService.assertCircleAccess(
      userId,
      circleId,
      permissions,
      'viewer' as CircleRole,
    );

    const where = buildWhereFromFields(circleId, filters);
    const skip = (page - 1) * pageSize;
    const orderBy: Prisma.MediaItemOrderByWithRelationInput = { [sortBy]: sortOrder as Prisma.SortOrder };

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

  async search(dto: SearchQueryDto, userId: string, userPermissions: string[]): Promise<SearchResult> {
    const { circleId, filters, page, pageSize, sortBy, sortOrder } = dto;

    return this.runSearch(
      userId,
      circleId,
      userPermissions,
      filters as Record<string, unknown>,
      { page, pageSize, sortBy, sortOrder },
    );
  }

  getFields(): SearchFieldDescriptor[] {
    return SEARCHABLE_FIELDS.map(({ key, label, type, enumValues, optionsSource, description }) => ({
      key,
      label,
      type,
      ...(enumValues ? { enumValues } : {}),
      ...(optionsSource ? { optionsSource } : {}),
      description,
    }));
  }
}
