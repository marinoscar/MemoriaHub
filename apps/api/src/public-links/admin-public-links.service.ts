import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { PrismaService } from '../prisma/prisma.service';
import { LinkGrantDirectory, type AdminLinkQuery, type AdminLinkRow } from './link-grant-directory.service';

/** What the admin page shows of the record a link opens. */
export interface AdminLinkPreview {
  type: 'media_item' | 'album';
  /** The photo's filename or the album's name; `null` when the record is gone. */
  title: string | null;
  thumbnailUrl: string | null;
  /** Albums only: the non-trashed member count. */
  itemCount?: number;
}

export interface AdminPublicLink extends AdminLinkRow {
  grantedBy: { id: string; email: string; displayName: string | null } | null;
  preview: AdminLinkPreview | null;
}

export interface AdminPublicLinkPage {
  items: AdminPublicLink[];
  meta: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

/**
 * The admin listing of public links (RETRO-I4, #578): a page of link grants
 * (`LinkGrantDirectory`) plus, in batched reads, each link's creator and a
 * preview of its record (one thumbnail-signing round per page, as the
 * `media_shares` listing did).
 */
@Injectable()
export class AdminPublicLinksService {
  constructor(
    private readonly directory: LinkGrantDirectory,
    private readonly prisma: PrismaService,
    private readonly thumbnails: MediaThumbnailService,
  ) {}

  async list(query: AdminLinkQuery): Promise<AdminPublicLinkPage> {
    const { items, total } = await this.directory.adminPage(query);

    const mediaIds = items.filter((i) => i.resourceType === 'media_item').map((i) => i.resourceId);
    const albumIds = items.filter((i) => i.resourceType === 'album').map((i) => i.resourceId);
    const userIds = [...new Set(items.map((i) => i.grantedById).filter((id): id is string => id !== null))];

    const [media, albums, users] = await Promise.all([
      mediaIds.length
        ? this.prisma.mediaItem.findMany({ where: { id: { in: mediaIds } }, select: { id: true, originalFilename: true, metadata: true } })
        : Promise.resolve([]),
      albumIds.length
        ? this.prisma.album.findMany({
            where: { id: { in: albumIds } },
            select: {
              id: true,
              name: true,
              items: {
                where: { mediaItem: { deletedAt: null } },
                orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
                take: 1,
                select: { mediaItem: { select: { metadata: true } } },
              },
              _count: { select: { items: { where: { mediaItem: { deletedAt: null } } } } },
            },
          })
        : Promise.resolve([]),
      userIds.length
        ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, displayName: true } })
        : Promise.resolve([]),
    ]);

    const keys: string[] = [];
    const keyOf = (metadata: Prisma.JsonValue | null): string | null => {
      const key = this.thumbnails.extractThumbKey(metadata);
      if (key) keys.push(key);
      return key;
    };
    const mediaById = new Map(media.map((m) => [m.id, { title: m.originalFilename, key: keyOf(m.metadata) }]));
    const albumById = new Map(
      albums.map((a) => [a.id, { title: a.name, key: keyOf(a.items[0]?.mediaItem.metadata ?? null), count: a._count.items }]),
    );
    const signed = await this.thumbnails.signThumbsBatched(keys);
    const urlOf = (key: string | null): string | null => (key ? signed.get(key) ?? null : null);
    const usersById = new Map(users.map((u) => [u.id, u]));

    return {
      items: items.map((row): AdminPublicLink => {
        let preview: AdminLinkPreview | null = null;
        if (row.resourceType === 'media_item') {
          const m = mediaById.get(row.resourceId);
          preview = { type: 'media_item', title: m?.title ?? null, thumbnailUrl: urlOf(m?.key ?? null) };
        } else if (row.resourceType === 'album') {
          const a = albumById.get(row.resourceId);
          preview = { type: 'album', title: a?.title ?? null, thumbnailUrl: urlOf(a?.key ?? null), itemCount: a?.count ?? 0 };
        }
        return { ...row, grantedBy: row.grantedById ? usersById.get(row.grantedById) ?? null : null, preview };
      }),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }
}
