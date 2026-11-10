// The name of the library a content row belongs to, from the row's owner relations (RETRO-K1).
// A group-owned row reads its group's name; a user-owned row is "<owner>'s Library". No read of
// `circles`: the ownership columns of RETRO-I2 carry it.

/** The owner relations a dataset selects so a row's library name can be shown (`libraryName`). */
export const OWNER_NAME_SELECT = {
  ownerGroup: { select: { name: true } },
  ownerUser: { select: { displayName: true, providerDisplayName: true, email: true } },
} as const;

/** The display name of the library a row belongs to: its group's name, or "<owner>'s Library". */
export function libraryName(row: Record<string, unknown>): string | null {
  const group = row.ownerGroup as { name?: unknown } | null | undefined;
  if (group && typeof group.name === 'string') return group.name;
  const user = row.ownerUser as { displayName?: unknown; providerDisplayName?: unknown; email?: unknown } | null | undefined;
  if (!user) return null;
  const who = [user.displayName, user.providerDisplayName, user.email].find((v) => typeof v === 'string' && v) as string | undefined;
  return who ? `${who}'s Library` : null;
}
