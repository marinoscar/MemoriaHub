// =============================================================================
// Hooks the host fills for what is not a port
// =============================================================================
//
// Two things the face slice needs have no port because they are not platform-shaped:
// an account may be LINKED to a person and show that person's picture (the host's
// profile code owns the avatar), and a derived storage row (a video face frame) needs
// the organization it is stamped with. The host binds both once, in `FaceModule.forRoot`.
// =============================================================================

/**
 * Injection token of {@link FacePersonAvatars}.
 *
 * @stability experimental
 */
export const FACE_PERSON_AVATARS = Symbol.for('@marinoscar/memoriahub/FACE_PERSON_AVATARS');

/**
 * The host's account-avatar code, called when a person's picture changes, is merged or removed.
 *
 * @stability experimental
 */
export interface FacePersonAvatars {
  /**
   * Re-renders the avatar of every account whose avatar comes from this person.
   *
   * @param personId - the person whose picture changed.
   */
  refreshAvatarsForPerson(personId: string): Promise<void>;

  /**
   * Moves every account link from a merged-away person to the survivor, inside the merge transaction.
   *
   * @param tx - the merge transaction.
   * @param sourcePersonId - the person merged away.
   * @param targetPersonId - the survivor.
   * @returns how many accounts moved.
   */
  carryLinkedUsersOnMerge(tx: unknown, sourcePersonId: string, targetPersonId: string): Promise<number>;

  /**
   * Clears every account link to a deleted person, inside the delete transaction.
   *
   * @param tx - the delete transaction.
   * @param personId - the deleted person.
   * @returns the accounts unlinked and those whose avatar must be reset after commit.
   */
  unlinkUsersFromPerson(tx: unknown, personId: string): Promise<{ unlinkedUserIds: string[]; resetUserIds: string[] }>;

  /**
   * Resets the avatar state of accounts that were unlinked, after the transaction committed.
   *
   * @param userIds - the accounts to reset.
   */
  resetAvatarsAfterUnlink(userIds: string[]): Promise<void>;
}

/**
 * Injection token of {@link FaceStorageOrg}.
 *
 * @stability experimental
 */
export const FACE_STORAGE_ORG = Symbol.for('@marinoscar/memoriahub/FACE_STORAGE_ORG');

/**
 * The organization a derived storage row (a video face frame) is stamped with.
 *
 * @stability experimental
 */
export interface FaceStorageOrg {
  /**
   * The organization id (the default organization in single-organization mode).
   */
  get(): Promise<string>;
}
