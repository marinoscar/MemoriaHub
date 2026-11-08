// An in-memory stand-in for the four tables the settings services touch. It is
// deliberately tiny: findUnique / create / update / upsert on a keyed row, and
// a recording audit sink. Rows are stored by reference semantics a real JSONB
// column does not have, so every write deep-copies.

type Row = Record<string, any>;

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

export interface FakeSettingsDb {
  system: Map<string, Row>;
  user: Map<string, Row>;
  audit: Row[];
  users: Map<string, Row>;
  prisma: any;
}

export function createFakeSettingsDb(): FakeSettingsDb {
  const system = new Map<string, Row>();
  const user = new Map<string, Row>();
  const audit: Row[] = [];
  const users = new Map<string, Row>();
  let seq = 0;

  const bump = (row: Row, data: Row): Row => {
    const next = { ...row };
    for (const [k, v] of Object.entries(data)) {
      if (k === 'version' && v && typeof v === 'object' && 'increment' in v) {
        next.version = (row.version ?? 0) + (v as Row).increment;
      } else if (k === 'value') {
        next.value = clone(v);
      } else {
        next[k] = v;
      }
    }
    next.updatedAt = new Date();
    return next;
  };

  const withUpdater = (row: Row | undefined, include: any): Row | null => {
    if (!row) return null;
    const out: Row = { ...row, value: clone(row.value) };
    if (include?.updatedByUser) out.updatedByUser = null;
    return out;
  };

  const systemSettings = {
    findUnique: jest.fn(async (args: Row) => withUpdater(system.get(args.where.key), args.include)),
    create: jest.fn(async (args: Row) => {
      const row = bump(
        { id: `sys-${++seq}`, key: args.data.key, version: 1, updatedByUserId: null },
        args.data,
      );
      row.version = 1;
      system.set(row.key, row);
      return withUpdater(row, args.include);
    }),
    update: jest.fn(async (args: Row) => {
      const current = system.get(args.where.key);
      if (!current) throw new Error('P2025');
      const row = bump(current, args.data);
      system.set(row.key, row);
      return withUpdater(row, args.include);
    }),
    upsert: jest.fn(async (args: Row) => {
      const current = system.get(args.where.key);
      const row = current
        ? bump(current, args.update)
        : { ...bump({ id: `sys-${++seq}`, key: args.where.key, version: 1 }, args.create), version: 1 };
      system.set(args.where.key, row);
      return withUpdater(row, args.include);
    }),
  };

  const userSettings = {
    findUnique: jest.fn(async (args: Row) => {
      const row = user.get(args.where.userId);
      return row ? { ...row, value: clone(row.value) } : null;
    }),
    create: jest.fn(async (args: Row) => {
      const row = bump({ id: `us-${++seq}`, userId: args.data.userId, version: 1 }, args.data);
      row.version = 1;
      user.set(row.userId, row);
      return { ...row, value: clone(row.value) };
    }),
    update: jest.fn(async (args: Row) => {
      const current = user.get(args.where.userId);
      if (!current) throw new Error('P2025');
      const row = bump(current, args.data);
      user.set(row.userId, row);
      return { ...row, value: clone(row.value) };
    }),
    upsert: jest.fn(async (args: Row) => {
      const current = user.get(args.where.userId);
      const row = current
        ? bump(current, args.update)
        : { ...bump({ id: `us-${++seq}`, userId: args.where.userId }, args.create), version: 1 };
      user.set(args.where.userId, row);
      return { ...row, value: clone(row.value) };
    }),
  };

  const prisma: any = {
    systemSettings,
    userSettings,
    auditEvent: {
      create: jest.fn(async (args: Row) => {
        audit.push(clone(args.data));
        return args.data;
      }),
    },
    user: {
      update: jest.fn(async (args: Row) => {
        users.set(args.where.id, { ...(users.get(args.where.id) ?? {}), ...args.data });
        return users.get(args.where.id);
      }),
    },
    // The notifications namespaces' `onWrite` dismissals (RETRO-D3) run raw SQL in the write's transaction.
    $executeRaw: jest.fn(async () => 0),
    $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => fn(prisma)),
  };

  return { system, user, audit, users, prisma };
}
