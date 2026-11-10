// =============================================================================
// An in-memory database for the search slice (RETRO-J7, #618)
// =============================================================================
//
// The delegates search calls, recording every `where` it was given so a rule can prove which scope a
// query was bound to. Rows are filtered by `circleId` and `deletedAt` only (the kit's rules read the
// recorded clause, not a Prisma emulation); `$queryRaw` answers the rows seeded as the pgvector KNN result.
// =============================================================================

/**
 * The in-memory store behind {@link createFakeSearchDb}.
 *
 * @stability experimental
 */
export class FakeSearchStore {
  /** The media rows. */
  readonly items: Array<{ id: string; circleId: string; deletedAt?: Date | null; metadata?: unknown } & Record<string, unknown>> = [];
  /** The people (`people` rows) the agent resolves names against. */
  readonly people: Array<{ id: string; circleId: string; name: string }> = [];
  /** The KNN rows `$queryRaw` answers with. */
  knn: Array<{ id: string; distance: number }> = [];
  /** Every `where` the media delegate was queried with. */
  readonly wheres: Array<Record<string, any>> = [];
  /** How many times the KNN query ran. */
  knnQueries = 0;
}

/** The delegate-shaped object over a store. */
export function createFakeSearchDb(store: FakeSearchStore): Record<string, unknown> {
  const matching = (where: Record<string, any>) =>
    store.items.filter((item) => item.circleId === where['circleId'] && !item.deletedAt && (where['id']?.in ? where['id'].in.includes(item.id) : true));

  return {
    mediaItem: {
      async findMany({ where }: { where: Record<string, any> }) {
        store.wheres.push(where);
        return matching(where);
      },
      async count({ where }: { where: Record<string, any> }) {
        return matching(where).length;
      },
    },
    person: {
      async findMany({ where }: { where: { circleId: string; name: { in: string[] } } }) {
        const names = where.name.in.map((n) => n.toLowerCase());
        return store.people.filter((p) => p.circleId === where.circleId && names.includes(p.name.toLowerCase()));
      },
    },
    storageObject: {
      async findMany() {
        return [];
      },
    },
    async $queryRaw() {
      store.knnQueries += 1;
      return store.knn;
    },
    async $executeRaw() {
      return 1;
    },
  };
}
