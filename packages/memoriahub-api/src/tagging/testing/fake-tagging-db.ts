// =============================================================================
// An in-memory database for the tagging slice (RETRO-J7, #618)
// =============================================================================
//
// Just the delegates the slice calls, with the behaviour the kit's rules rely on: a unique label name
// (the `P2002` the service maps to a conflict), the `circleId_name` and `tagId_mediaItemId` keys, a
// transaction that runs its callback on the same store. It is not a Prisma emulation: a query shape
// the slice does not use is not supported.
// =============================================================================

interface Label {
  id: string;
  name: string;
  enabled: boolean;
}

interface Tag {
  id: string;
  circleId: string;
  name: string;
  addedById: string | null;
}

interface MediaTagRow {
  tagId: string;
  mediaItemId: string;
  source: string;
}

/**
 * A media item as the fake stores it.
 *
 * @stability experimental
 */
export interface FakeMediaItemRow {
  /** The id. */
  id: string;
  /** The owner scope. */
  circleId: string;
  /** `photo` or `video`. */
  type: string;
  /** The adding user. */
  addedById?: string;
  /** Set when trashed. */
  deletedAt?: Date | null;
  /** The generated description. */
  description?: string | null;
}

/**
 * The in-memory store behind {@link createFakeTaggingDb}.
 *
 * @stability experimental
 */
export class FakeTaggingStore {
  /** The vocabulary. */
  readonly labels: Label[] = [];
  /** The tags of every circle. */
  readonly tags: Tag[] = [];
  /** The tag-to-item joins. */
  readonly mediaTags: MediaTagRow[] = [];
  /** The media items. */
  readonly items = new Map<string, FakeMediaItemRow>();
  /** The tagging status per media item. */
  readonly statuses = new Map<string, Record<string, unknown>>();

  private seq = 0;

  /**
   * A fresh id.
   *
   * @param prefix - the id prefix.
   */
  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  /**
   * Adds a vocabulary label.
   *
   * @param name - the label name.
   * @param enabled - whether the model may choose it.
   */
  addLabel(name: string, enabled = true): void {
    this.labels.push({ id: this.nextId('label'), name, enabled });
  }

  /**
   * The tags an item carries: name and source.
   *
   * @param itemId - the media item.
   */
  tagsOf(itemId: string): Array<{ name: string; source: string }> {
    return this.mediaTags
      .filter((row) => row.mediaItemId === itemId)
      .map((row) => ({ name: this.tags.find((tag) => tag.id === row.tagId)?.name ?? '?', source: row.source }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Gives an item a tag directly (a manual tag, or a stale AI one).
   *
   * @param item - the media item.
   * @param name - the tag name.
   * @param source - `manual`, `ai` or `system`.
   */
  addTag(item: FakeMediaItemRow, name: string, source: string): void {
    let tag = this.tags.find((t) => t.circleId === item.circleId && t.name === name);
    if (!tag) {
      tag = { id: this.nextId('tag'), circleId: item.circleId, name, addedById: item.addedById ?? null };
      this.tags.push(tag);
    }
    this.mediaTags.push({ tagId: tag.id, mediaItemId: item.id, source });
  }
}

/** The delegate-shaped object over a store. */
export function createFakeTaggingDb(store: FakeTaggingStore): Record<string, unknown> {
  const tagName = (tagId: string): string | undefined => store.tags.find((t) => t.id === tagId)?.name;

  const db: Record<string, unknown> = {
    mediaItem: {
      async findUnique({ where }: { where: { id: string } }) {
        const item = store.items.get(where.id);
        return item ? { ...item, storageObject: null } : null;
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        const item = store.items.get(where.id);
        if (item) Object.assign(item, data);
        return item;
      },
      async updateMany() {
        return { count: 0 };
      },
      async findMany({ where }: { where: { circleId: string; type?: { in: string[] }; OR?: unknown[] } }) {
        return [...store.items.values()].filter(
          (item) =>
            item.circleId === where.circleId &&
            !item.deletedAt &&
            (where.type?.in ? where.type.in.includes(item.type) : true) &&
            (where.OR ? (store.statuses.get(item.id)?.['status'] ?? 'not_processed') !== 'processed' : true),
        );
      },
    },
    tagLabel: {
      async findMany({ where }: { where?: { enabled?: boolean } } = {}) {
        return store.labels
          .filter((label) => (where?.enabled === undefined ? true : label.enabled === where.enabled))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((label) => ({ ...label }));
      },
      async findUnique({ where }: { where: { id: string } }) {
        return store.labels.find((label) => label.id === where.id) ?? null;
      },
      async create({ data }: { data: { name: string } }) {
        if (store.labels.some((label) => label.name === data.name)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const label = { id: store.nextId('label'), name: data.name, enabled: true };
        store.labels.push(label);
        return { ...label };
      },
    },
    tag: {
      async upsert({
        where,
        create,
      }: {
        where: { circleId_name: { circleId: string; name: string } };
        create: { addedById: string | null; circleId: string; name: string };
      }) {
        let tag = store.tags.find((t) => t.circleId === where.circleId_name.circleId && t.name === where.circleId_name.name);
        if (!tag) {
          tag = { id: store.nextId('tag'), circleId: create.circleId, name: create.name, addedById: create.addedById };
          store.tags.push(tag);
        }
        return tag;
      },
    },
    mediaTag: {
      async deleteMany({
        where,
      }: {
        where: { mediaItemId: string; source: string; tag: { name: { notIn: string[] } } };
      }) {
        const keep = (row: MediaTagRow): boolean =>
          !(
            row.mediaItemId === where.mediaItemId &&
            row.source === where.source &&
            !where.tag.name.notIn.includes(tagName(row.tagId) ?? '')
          );
        const before = store.mediaTags.length;
        const kept = store.mediaTags.filter(keep);
        store.mediaTags.splice(0, store.mediaTags.length, ...kept);
        return { count: before - kept.length };
      },
      async upsert({
        where,
        create,
      }: {
        where: { tagId_mediaItemId: { tagId: string; mediaItemId: string } };
        create: MediaTagRow;
      }) {
        const key = where.tagId_mediaItemId;
        const existing = store.mediaTags.find((row) => row.tagId === key.tagId && row.mediaItemId === key.mediaItemId);
        if (!existing) store.mediaTags.push({ ...create });
        return existing ?? create;
      },
    },
    mediaTagStatus: {
      async upsert({
        where,
        create,
        update,
      }: {
        where: { mediaItemId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) {
        const existing = store.statuses.get(where.mediaItemId);
        const next = existing ? { ...existing, ...update } : { ...create };
        store.statuses.set(where.mediaItemId, next);
        return next;
      },
    },
    mediaTranscript: {
      async findUnique() {
        return null;
      },
    },
    face: {
      async findMany() {
        return [];
      },
    },
    async $executeRaw() {
      return 1;
    },
    async $queryRaw() {
      return [];
    },
  };
  db['$transaction'] = async (fn: (tx: unknown) => unknown) => fn(db);
  return db;
}
