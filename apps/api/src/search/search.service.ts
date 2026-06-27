import { Injectable, Logger } from '@nestjs/common';
import { Prisma, CircleRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import {
  SEARCHABLE_FIELDS,
  buildWhereFromFields,
  SearchableField,
} from './searchable-fields.registry';
import { SemanticSearchService } from './semantic-search.service';
import { SearchQueryDto } from './dto/search-query.dto';
import { MediaThumbnailService } from '../media/media-thumbnail.service';

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
  items: (Prisma.MediaItemGetPayload<Record<string, never>> & { thumbnailUrl: string | null })[];
  meta: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

/**
 * Hand-authored descriptor for semanticQuery.
 * NOT added to SEARCHABLE_FIELDS to avoid breaking buildWhereFromFields unknown-key guard.
 */
const SEMANTIC_QUERY_DESCRIPTOR: SearchFieldDescriptor = {
  key: 'semanticQuery',
  label: 'Semantic search',
  type: 'string',
  description:
    'Natural-language description of photo content; ranks results by semantic similarity. ' +
    'Requires the embedding feature to be configured in AI Settings. ' +
    'Can be combined with structured filters for hybrid search.',
};

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly circleMembershipService: CircleMembershipService,
    private readonly semanticSearch: SemanticSearchService,
    private readonly mediaThumbnail: MediaThumbnailService,
  ) {}

  async runSearch(
    userId: string,
    circleId: string,
    permissions: string[],
    filters: Record<string, unknown>,
    paging?: SearchPaging,
    semanticQuery?: string,
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

    // --- Semantic search path ---
    if (semanticQuery && semanticQuery.trim().length > 0) {
      const vec = await this.semanticSearch.embedQuery(semanticQuery.trim());

      if (vec === null) {
        // Embedding unavailable or failed — fall back to normal filter-only path
        this.logger.warn(
          `SearchService: semanticQuery provided but embedding returned null; ` +
            `falling back to filter-only search (circleId=${circleId})`,
        );
      } else {
        // KNN limit: fetch a superset so the filter intersection can still yield a full page
        const knnLimit = Math.min(Math.max(pageSize * 5, 100), 500);
        const knn = await this.semanticSearch.knnMediaIds(circleId, vec, knnLimit);

        if (knn.length === 0) {
          this.logger.log(
            `SearchService: semantic KNN returned 0 results (circleId=${circleId}, query="${semanticQuery}")`,
          );
          return {
            items: [],
            meta: { page, pageSize, totalItems: 0, totalPages: 0 },
          };
        }

        const orderedIds = knn.map((k) => k.id);

        // Build the standard filter where-clause and AND in the KNN id set
        const baseWhere = buildWhereFromFields(circleId, filters);
        const where: Prisma.MediaItemWhereInput = {
          ...baseWhere,
          id: { in: orderedIds },
        };

        // Fetch the full intersection in one query (no skip/take — we paginate in app)
        const allItems = await this.prisma.mediaItem.findMany({ where });

        // Re-order in app by KNN distance rank
        const positionMap = new Map<string, number>(orderedIds.map((id, i) => [id, i]));
        allItems.sort((a, b) => {
          const posA = positionMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
          const posB = positionMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
          return posA - posB;
        });

        const totalItems = allItems.length;
        const start = (page - 1) * pageSize;
        const pageItems = allItems.slice(start, start + pageSize);

        this.logger.log(
          `SearchService: semantic search circleId=${circleId} query="${semanticQuery}" ` +
            `knn=${knn.length} intersect=${totalItems} page=${page}`,
        );

        const items = await this.mediaThumbnail.attachThumbnailUrls(pageItems);

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
    }

    // --- Normal filter-only path (existing behavior, unchanged) ---
    const where = buildWhereFromFields(circleId, filters);
    const skip = (page - 1) * pageSize;
    const orderBy: Prisma.MediaItemOrderByWithRelationInput = {
      [sortBy]: sortOrder as Prisma.SortOrder,
    };

    const [rawItems, totalItems] = await Promise.all([
      this.prisma.mediaItem.findMany({ where, orderBy, skip, take: pageSize }),
      this.prisma.mediaItem.count({ where }),
    ]);

    this.logger.log(
      `Search: circleId=${circleId} filters=${JSON.stringify(filters)} page=${page} total=${totalItems}`,
    );

    const items = await this.mediaThumbnail.attachThumbnailUrls(rawItems);

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
    const { circleId, filters, page, pageSize, sortBy, sortOrder, semanticQuery } = dto;

    return this.runSearch(
      userId,
      circleId,
      userPermissions,
      filters as Record<string, unknown>,
      { page, pageSize, sortBy, sortOrder },
      semanticQuery,
    );
  }

  getFields(): SearchFieldDescriptor[] {
    const registryFields = SEARCHABLE_FIELDS.map(
      ({ key, label, type, enumValues, optionsSource, description }) => ({
        key,
        label,
        type,
        ...(enumValues ? { enumValues } : {}),
        ...(optionsSource ? { optionsSource } : {}),
        description,
      }),
    );

    // Append semanticQuery descriptor after the registry fields so the
    // frontend and agent know it exists without polluting SEARCHABLE_FIELDS
    // (which would break the unknown-key guard in buildWhereFromFields).
    return [...registryFields, SEMANTIC_QUERY_DESCRIPTOR];
  }
}
