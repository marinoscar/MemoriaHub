import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// Personal libraries: the one place that knows where they are stored
// (RETRO-K1, #588; epic #556; docs/platform-adoption/circles-to-groups.md §0f)
// =============================================================================
//
// A personal library is NOT a platform group (decision 3): its content rows are
// owned by the user (`owner_user_id`) and carry the library's SCOPE ID in the
// `circle_id` column, an id that never changes. Everything else in the app asks
// this store (through `OwnerAccessService` and `OwnerScopeSweepService`) instead
// of reading a table itself, so the storage can change in one file.
//
// Stored in `personal_libraries` since RETRO-K2 (`id` = the scope id, `user_id` unique): one row
// per user, created at sign-up. The `circles` table is gone.
// =============================================================================

/** A personal library with the owner's display fields (the library's name is derived from them). */
export interface PersonalLibraryRow {
  /** The scope id: what content rows carry in `circle_id`. */
  id: string;
  ownerId: string;
  ownerName: string | null;
  ownerEmail: string;
  createdAt: Date;
}

/** The display name of a user's personal library ("Person A's Library"). */
export function personalLibraryName(owner: { ownerName: string | null; ownerEmail: string }): string {
  return `${owner.ownerName || owner.ownerEmail}'s Library`;
}

const OWNER_SELECT = { select: { displayName: true, providerDisplayName: true, email: true } } as const;

@Injectable()
export class PersonalLibraryStore {
  constructor(private readonly prisma: PrismaService) {}

  /** The scope id of the user's personal library, or `null`. */
  async idOf(userId: string): Promise<string | null> {
    const row = await this.prisma.personalLibrary.findUnique({ where: { userId }, select: { id: true } });
    return row?.id ?? null;
  }

  /** The owner of the personal library with this scope id, or `null` when it is not one. */
  async ownerOf(scopeId: string): Promise<string | null> {
    const row = await this.prisma.personalLibrary.findUnique({ where: { id: scopeId }, select: { userId: true } });
    return row?.userId ?? null;
  }

  /** One personal library by scope id, or `null`. */
  async get(scopeId: string): Promise<PersonalLibraryRow | null> {
    const row = await this.prisma.personalLibrary.findUnique({
      where: { id: scopeId },
      select: { id: true, userId: true, createdAt: true, user: OWNER_SELECT },
    });
    return row ? toRow(row) : null;
  }

  /** Personal libraries by scope id (ids that are not one are left out). */
  async getMany(scopeIds: readonly string[]): Promise<PersonalLibraryRow[]> {
    if (scopeIds.length === 0) return [];
    const rows = await this.prisma.personalLibrary.findMany({
      where: { id: { in: [...scopeIds] } },
      select: { id: true, userId: true, createdAt: true, user: OWNER_SELECT },
    });
    return rows.map(toRow);
  }

  /** A keyset page of every personal library, by id. */
  async page(after: string | undefined, take: number): Promise<PersonalLibraryRow[]> {
    const rows = await this.prisma.personalLibrary.findMany({
      select: { id: true, userId: true, createdAt: true, user: OWNER_SELECT },
      orderBy: { id: 'asc' },
      take,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
    return rows.map(toRow);
  }

  /**
   * Creates the user's personal library if they have none and returns its scope id. Safe to call
   * twice or concurrently (`user_id` is unique: the loser of a race reads the winner's row).
   */
  async ensure(userId: string, client: Pick<PrismaService, 'personalLibrary'> = this.prisma): Promise<{ id: string; created: boolean }> {
    const existing = await client.personalLibrary.findUnique({ where: { userId }, select: { id: true } });
    if (existing) return { id: existing.id, created: false };
    try {
      const row = await client.personalLibrary.create({ data: { userId }, select: { id: true } });
      return { id: row.id, created: true };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        const winner = await client.personalLibrary.findUniqueOrThrow({ where: { userId }, select: { id: true } });
        return { id: winner.id, created: false };
      }
      throw err;
    }
  }

  /** Deletes the personal library row of a user (the content must be gone). Returns how many rows went. */
  async removeFor(userId: string): Promise<number> {
    return (await this.prisma.personalLibrary.deleteMany({ where: { userId } })).count;
  }
}

function toRow(row: {
  id: string;
  userId: string;
  createdAt: Date;
  user: { displayName: string | null; providerDisplayName: string | null; email: string };
}): PersonalLibraryRow {
  return {
    id: row.id,
    ownerId: row.userId,
    ownerName: row.user.displayName || row.user.providerDisplayName || null,
    ownerEmail: row.user.email,
    createdAt: row.createdAt,
  };
}
