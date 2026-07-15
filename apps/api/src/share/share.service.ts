import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { ShareTargetType, CircleRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { PERMISSIONS } from '../common/constants/roles.constants';
import { CreateShareDto } from './dto/create-share.dto';
import { UpdateShareDto } from './dto/update-share.dto';
import { BulkShareDto } from './dto/bulk-share.dto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShareStatus = 'active' | 'expired' | 'revoked';

export interface ShareWithStatus {
  id: string;
  token: string;
  targetType: ShareTargetType;
  mediaItemId: string | null;
  albumId: string | null;
  circleId: string;
  createdById: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  status: ShareStatus;
  publicUrl: string;
  preview: SharePreview | null;
}

export interface SharePreview {
  type: 'media_item' | 'album';
  thumbnailUrl?: string | null;
  albumName?: string;
  itemCount?: number;
  coverThumbnailUrl?: string | null;
}

export interface ListSharesQuery {
  scope?: 'mine' | 'all';
  status?: ShareStatus;
  targetType?: ShareTargetType;
  page?: number;
  pageSize?: number;
}

export interface PublicShareResolved {
  share: {
    id: string;
    token: string;
    targetType: ShareTargetType;
    mediaItemId: string | null;
    albumId: string | null;
  };
  mediaItem?: {
    type: string;
    width: number | null;
    height: number | null;
    storageObject: {
      storageKey: string;
      storageProvider: string;
      bucket: string | null;
      mimeType: string;
    };
  };
  albumItems?: Array<{
    mediaItemId: string;
    type: string;
    width: number | null;
    height: number | null;
    storageObject: {
      storageKey: string;
      storageProvider: string;
      bucket: string | null;
      mimeType: string;
    };
    thumbnailStorageKey: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly circleMembership: CircleMembershipService,
    private readonly thumbnailService: MediaThumbnailService,
  ) {}

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private computeStatus(share: {
    revokedAt: Date | null;
    expiresAt: Date | null;
  }): ShareStatus {
    if (share.revokedAt) return 'revoked';
    if (share.expiresAt && share.expiresAt <= new Date()) return 'expired';
    return 'active';
  }

  private buildPublicUrl(token: string): string {
    const appUrl = this.config.get<string>('appUrl', 'http://localhost:3535');
    return `${appUrl}/s/${token}`;
  }

  private toShareWithStatus(
    share: {
      id: string;
      token: string;
      targetType: ShareTargetType;
      mediaItemId: string | null;
      albumId: string | null;
      circleId: string;
      createdById: string;
      expiresAt: Date | null;
      revokedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
    preview: SharePreview | null = null,
  ): ShareWithStatus {
    return {
      ...share,
      status: this.computeStatus(share),
      publicUrl: this.buildPublicUrl(share.token),
      preview,
    };
  }

  // -------------------------------------------------------------------------
  // createShare
  // -------------------------------------------------------------------------

  async createShare(
    userId: string,
    userPermissions: string[],
    dto: CreateShareDto,
  ): Promise<ShareWithStatus> {
    // Validate XOR: exactly one target id must be provided
    if (dto.targetType === ShareTargetType.media_item) {
      if (!dto.mediaItemId) {
        throw new BadRequestException('mediaItemId is required when targetType is media_item');
      }
      if (dto.albumId) {
        throw new BadRequestException('albumId must not be provided when targetType is media_item');
      }
    } else {
      if (!dto.albumId) {
        throw new BadRequestException('albumId is required when targetType is album');
      }
      if (dto.mediaItemId) {
        throw new BadRequestException('mediaItemId must not be provided when targetType is album');
      }
    }

    // Resolve circle and validate target
    let circleId: string;

    if (dto.targetType === ShareTargetType.media_item) {
      const item = await this.prisma.mediaItem.findUnique({
        where: { id: dto.mediaItemId! },
        select: { circleId: true, deletedAt: true },
      });
      if (!item) throw new NotFoundException('Media item not found');
      if (item.deletedAt) {
        throw new BadRequestException('Cannot share a trashed media item');
      }
      circleId = item.circleId;
    } else {
      const album = await this.prisma.album.findUnique({
        where: { id: dto.albumId! },
        select: { circleId: true },
      });
      if (!album) throw new NotFoundException('Album not found');
      circleId = album.circleId;
    }

    // Assert at least collaborator-level access in that circle
    await this.circleMembership.assertCircleAccess(
      userId,
      circleId,
      userPermissions,
      'collaborator' as CircleRole,
    );

    // Idempotency: return existing active share if one exists
    const existingWhere: Prisma.MediaShareWhereInput = {
      createdById: userId,
      targetType: dto.targetType,
      revokedAt: null,
      ...(dto.targetType === ShareTargetType.media_item
        ? { mediaItemId: dto.mediaItemId }
        : { albumId: dto.albumId }),
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };

    const existing = await this.prisma.mediaShare.findFirst({
      where: existingWhere,
    });

    if (existing) {
      return this.toShareWithStatus(existing);
    }

    // Create new share
    const token = this.generateToken();
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;

    const created = await this.prisma.mediaShare.create({
      data: {
        token,
        targetType: dto.targetType,
        mediaItemId: dto.mediaItemId ?? null,
        albumId: dto.albumId ?? null,
        circleId,
        createdById: userId,
        expiresAt,
      },
    });

    return this.toShareWithStatus(created);
  }

  // -------------------------------------------------------------------------
  // listShares
  // -------------------------------------------------------------------------

  async listShares(
    userId: string,
    userPermissions: string[],
    query: ListSharesQuery,
  ): Promise<{
    items: ShareWithStatus[];
    meta: { page: number; pageSize: number; totalItems: number; totalPages: number };
  }> {
    const scope = query.scope ?? 'mine';
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));

    if (scope === 'all' && !userPermissions.includes(PERMISSIONS.SHARES_MANAGE_ANY)) {
      throw new ForbiddenException('shares:manage_any permission required to list all shares');
    }

    const where: Prisma.MediaShareWhereInput = {
      ...(scope === 'mine' ? { createdById: userId } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
    };

    // Status filter — translate to DB conditions
    if (query.status === 'revoked') {
      where.revokedAt = { not: null };
    } else if (query.status === 'expired') {
      where.revokedAt = null;
      where.expiresAt = { lte: new Date() };
    } else if (query.status === 'active') {
      where.revokedAt = null;
      where.OR = [{ expiresAt: null }, { expiresAt: { gt: new Date() } }];
    }

    const [totalItems, rows] = await Promise.all([
      this.prisma.mediaShare.count({ where }),
      this.prisma.mediaShare.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          mediaItem: {
            select: { metadata: true },
          },
          album: {
            select: {
              name: true,
              items: {
                where: { mediaItem: { deletedAt: null } },
                orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
                take: 1,
                select: { mediaItem: { select: { metadata: true } } },
              },
              _count: { select: { items: { where: { mediaItem: { deletedAt: null } } } } },
            },
          },
        },
      }),
    ]);

    // Collect every preview thumbnail key across the page (media items +
    // album covers) and sign them with a single batched StorageObject query.
    const previewKeys: string[] = [];
    for (const row of rows) {
      if (row.targetType === ShareTargetType.media_item && row.mediaItem) {
        const k = this.thumbnailService.extractThumbKey(row.mediaItem.metadata);
        if (k) previewKeys.push(k);
      } else if (row.targetType === ShareTargetType.album && row.album) {
        const firstItem = row.album.items[0]?.mediaItem;
        const k = firstItem
          ? this.thumbnailService.extractThumbKey(firstItem.metadata)
          : null;
        if (k) previewKeys.push(k);
      }
    }
    const keyToUrl = await this.thumbnailService.signThumbsBatched(previewKeys);
    const urlFor = (metadata: Prisma.JsonValue | null): string | null => {
      const k = this.thumbnailService.extractThumbKey(metadata);
      return k ? keyToUrl.get(k) ?? null : null;
    };

    const items: ShareWithStatus[] = rows.map((row) => {
      let preview: SharePreview | null = null;

      if (row.targetType === ShareTargetType.media_item && row.mediaItem) {
        preview = {
          type: 'media_item',
          thumbnailUrl: urlFor(row.mediaItem.metadata),
        };
      } else if (row.targetType === ShareTargetType.album && row.album) {
        const firstItem = row.album.items[0]?.mediaItem;
        preview = {
          type: 'album',
          albumName: row.album.name,
          itemCount: row.album._count.items,
          coverThumbnailUrl: firstItem ? urlFor(firstItem.metadata) : null,
        };
      }

      return this.toShareWithStatus(row, preview);
    });

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

  // -------------------------------------------------------------------------
  // updateShare
  // -------------------------------------------------------------------------

  async updateShare(
    userId: string,
    userPermissions: string[],
    id: string,
    dto: UpdateShareDto,
  ): Promise<ShareWithStatus> {
    const share = await this.prisma.mediaShare.findUnique({ where: { id } });
    if (!share) throw new NotFoundException('Share not found');

    // Authorization: own share, or manage_any
    if (
      share.createdById !== userId &&
      !userPermissions.includes(PERMISSIONS.SHARES_MANAGE_ANY)
    ) {
      throw new ForbiddenException('You can only update your own shares');
    }

    const updated = await this.prisma.mediaShare.update({
      where: { id },
      data: { expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null },
    });

    return this.toShareWithStatus(updated);
  }

  // -------------------------------------------------------------------------
  // revokeShare
  // -------------------------------------------------------------------------

  async revokeShare(
    userId: string,
    userPermissions: string[],
    id: string,
  ): Promise<void> {
    const share = await this.prisma.mediaShare.findUnique({ where: { id } });
    if (!share) throw new NotFoundException('Share not found');

    if (
      share.createdById !== userId &&
      !userPermissions.includes(PERMISSIONS.SHARES_MANAGE_ANY)
    ) {
      throw new ForbiddenException('You can only revoke your own shares');
    }

    // Idempotent: only set if not already revoked
    if (!share.revokedAt) {
      await this.prisma.mediaShare.update({
        where: { id },
        data: { revokedAt: new Date() },
      });
    }
  }

  // -------------------------------------------------------------------------
  // bulkAction
  // -------------------------------------------------------------------------

  async bulkAction(
    userId: string,
    userPermissions: string[],
    dto: BulkShareDto,
  ): Promise<{ affected: number }> {
    const isAdmin = userPermissions.includes(PERMISSIONS.SHARES_MANAGE_ANY);

    // Build base scope filter
    const where: Prisma.MediaShareWhereInput = {
      id: { in: dto.ids },
      ...(!isAdmin ? { createdById: userId } : {}),
    };

    if (dto.action === 'revoke') {
      const result = await this.prisma.mediaShare.updateMany({
        where: { ...where, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { affected: result.count };
    }

    if (dto.action === 'set_expiration') {
      const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
      const result = await this.prisma.mediaShare.updateMany({
        where,
        data: { expiresAt },
      });
      return { affected: result.count };
    }

    if (dto.action === 'delete') {
      const result = await this.prisma.mediaShare.deleteMany({ where });
      return { affected: result.count };
    }

    throw new BadRequestException('Unknown action');
  }

  // -------------------------------------------------------------------------
  // resolvePublicShare
  // -------------------------------------------------------------------------

  /**
   * Resolve a public share token. Throws a generic NotFoundException for any
   * invalid/revoked/expired state — no distinguishing information is leaked.
   */
  async resolvePublicShare(token: string): Promise<PublicShareResolved> {
    const share = await this.prisma.mediaShare.findUnique({
      where: { token },
      select: {
        id: true,
        token: true,
        targetType: true,
        mediaItemId: true,
        albumId: true,
        revokedAt: true,
        expiresAt: true,
      },
    });

    if (!share) throw new NotFoundException('Share not found');
    if (share.revokedAt) throw new NotFoundException('Share not found');
    if (share.expiresAt && share.expiresAt <= new Date()) {
      throw new NotFoundException('Share not found');
    }

    if (share.targetType === ShareTargetType.media_item) {
      const item = await this.prisma.mediaItem.findUnique({
        where: { id: share.mediaItemId! },
        select: {
          type: true,
          width: true,
          height: true,
          deletedAt: true,
          storageObject: {
            select: {
              storageKey: true,
              storageProvider: true,
              bucket: true,
              mimeType: true,
            },
          },
        },
      });

      if (!item || item.deletedAt) throw new NotFoundException('Share not found');

      return {
        share: {
          id: share.id,
          token: share.token,
          targetType: share.targetType,
          mediaItemId: share.mediaItemId,
          albumId: share.albumId,
        },
        mediaItem: {
          type: item.type,
          width: item.width,
          height: item.height,
          storageObject: item.storageObject,
        },
      };
    }

    // Album share
    const album = await this.prisma.album.findUnique({
      where: { id: share.albumId! },
      select: {
        items: {
          where: { mediaItem: { deletedAt: null } },
          orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
          select: {
            mediaItem: {
              select: {
                id: true,
                type: true,
                width: true,
                height: true,
                metadata: true,
                storageObject: {
                  select: {
                    storageKey: true,
                    storageProvider: true,
                    bucket: true,
                    mimeType: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!album) throw new NotFoundException('Share not found');

    const albumItems = album.items.map((ai) => {
      const meta = ai.mediaItem.metadata as Record<string, unknown> | null;
      const thumbnailStorageKey =
        meta && typeof meta['thumbnailStorageKey'] === 'string'
          ? meta['thumbnailStorageKey']
          : null;

      return {
        mediaItemId: ai.mediaItem.id,
        type: ai.mediaItem.type,
        width: ai.mediaItem.width,
        height: ai.mediaItem.height,
        storageObject: ai.mediaItem.storageObject,
        thumbnailStorageKey,
      };
    });

    return {
      share: {
        id: share.id,
        token: share.token,
        targetType: share.targetType,
        mediaItemId: share.mediaItemId,
        albumId: share.albumId,
      },
      albumItems,
    };
  }
}
