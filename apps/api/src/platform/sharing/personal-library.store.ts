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
// PLATFORM-ADOPTION-SHIM(RETRO-K1): the ids are still the `is_personal` rows of
// the app's `circles` table, kept for one release because every content table's
// `circle_id` still has a foreign key to it. RETRO-K2 moves them to
// `personal_libraries` and drops `circles`; only this file changes.
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

@Injectable()
export class PersonalLibraryStore {
  constructor(private readonly prisma: PrismaService) {}

  /** The scope id of the user's personal library, or `null`. */
  async idOf(userId: string): Promise<string | null> {
    const row = await this.prisma.circle.findFirst({
      where: { ownerId: userId, isPersonal: true },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** The owner of the personal library with this scope id, or `null` when it is not one. */
  async ownerOf(scopeId: string): Promise<string | null> {
    const row = await this.prisma.circle.findFirst({
      where: { id: scopeId, isPersonal: true },
      select: { ownerId: true },
    });
    return row?.ownerId ?? null;
  }

  /** One personal library by scope id, or `null`. */
  async get(scopeId: string): Promise<PersonalLibraryRow | null> {
    const row = await this.prisma.circle.findFirst({
      where: { id: scopeId, isPersonal: true },
      select: { id: true, ownerId: true, createdAt: true, owner: { select: { displayName: true, providerDisplayName: true, email: true } } },
    });
    return row ? toRow(row) : null;
  }

  /** Personal libraries by scope id (ids that are not one are left out). */
  async getMany(scopeIds: readonly string[]): Promise<PersonalLibraryRow[]> {
    if (scopeIds.length === 0) return [];
    const rows = await this.prisma.circle.findMany({
      where: { id: { in: [...scopeIds] }, isPersonal: true },
      select: { id: true, ownerId: true, createdAt: true, owner: { select: { displayName: true, providerDisplayName: true, email: true } } },
    });
    return rows.map(toRow);
  }

  /** A keyset page of every personal library, by id. */
  async page(after: string | undefined, take: number): Promise<PersonalLibraryRow[]> {
    const rows = await this.prisma.circle.findMany({
      where: { isPersonal: true },
      select: { id: true, ownerId: true, createdAt: true, owner: { select: { displayName: true, providerDisplayName: true, email: true } } },
      orderBy: { id: 'asc' },
      take,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
    return rows.map(toRow);
  }
}

function toRow(row: {
  id: string;
  ownerId: string;
  createdAt: Date;
  owner: { displayName: string | null; providerDisplayName: string | null; email: string };
}): PersonalLibraryRow {
  return {
    id: row.id,
    ownerId: row.ownerId,
    ownerName: row.owner.displayName || row.owner.providerDisplayName || null,
    ownerEmail: row.owner.email,
    createdAt: row.createdAt,
  };
}
