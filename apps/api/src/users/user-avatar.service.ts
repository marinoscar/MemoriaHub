import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CircleRole,
  MediaType,
  Prisma,
  UserAvatarSource,
} from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { extname } from 'path';
import { Readable } from 'stream';

import { buildFaceCropThumbnail } from '@memoriahub/enrichment-compute/face-video';
import { PrismaService } from '../prisma/prisma.service';
import { CircleMembershipService } from '../circles/circle-membership.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { StorageProvider } from '../storage/providers/storage-provider.interface';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';
import { UserSettingsService } from '../settings/user-settings/user-settings.service';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { UpdateUserProfileDto, UserProfileDto } from './dto/user-profile.dto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Every avatar — uploaded or person-derived — normalizes to this one artifact. */
const AVATAR_DIM = 512;
const AVATAR_QUALITY = 85;

/**
 * Long-edge cap applied to the SOURCE image before cropping. 2048 is far more
 * than the 512 output needs even after a tight face crop (a padded face box on
 * a 2048px-long-edge photo still lands around 400-500px), and it bounds peak
 * memory on a bulk-uploaded 50MP original.
 */
const AVATAR_SOURCE_MAX_DIM = 2048;

/** Hard cap on an uploaded avatar, enforced by the controller's multipart limits. */
export const AVATAR_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Accepted upload MIME types. This is only a cheap first gate — the real check
 * is that sharp can decode the bytes into a non-zero-dimension image, since a
 * client-supplied Content-Type is not evidence of anything.
 */
export const AVATAR_ALLOWED_MIME_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
];

/** Storage-key prefix. See the recursion-guard note on `storeAvatarObject`. */
const AVATAR_KEY_PREFIX = 'avatars/';

/**
 * Client-facing message for `assertPersonLinkable` (issue #406). Deliberately
 * generic — it must never reveal whether the person is missing/deleted or
 * merely in a circle the caller cannot see (enumeration-resistance), while
 * still giving the user something actionable instead of a bare UUID.
 */
const PERSON_UNLINKABLE_MESSAGE =
  'This person is no longer available to link. They may have been removed, merged with another person, or you may no longer have access to their circle. Please pick again.';

/** The columns `resolveAvatarUrl` reads. */
const AVATAR_COLUMNS = {
  id: true,
  avatarSource: true,
  avatarStorageKey: true,
  avatarVersion: true,
  linkedPersonId: true,
  providerProfileImageUrl: true,
} satisfies Prisma.UserSelect;

type AvatarColumns = Prisma.UserGetPayload<{ select: typeof AVATAR_COLUMNS }>;

/** Normalized (0..1) crop rectangle, as stored in `Person.profileCrop`. */
interface NormalizedCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pixel rectangle handed to sharp's `.extract()`. */
interface PixelRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A resolved storage location plus the bytes' owning provider. */
interface ResolvedObject {
  provider: StorageProvider;
  storageKey: string;
}

// ---------------------------------------------------------------------------
// UserAvatarService
// ---------------------------------------------------------------------------

/**
 * Profile picture management (issue #354).
 *
 * This service is the ONLY code path that writes `User.avatarSource`,
 * `avatarStorageKey`, `avatarVersion`, `linkedPersonId`, and `profileImageUrl`.
 * That single-writer rule mirrors `UserSettingsService.syncDisplayName` (the
 * only writer of `User.displayName`) and exists for one reason: every write
 * goes through `writeAvatarState`, which recomputes `profileImageUrl` from the
 * post-write source columns in the SAME statement, so the materialized URL can
 * never drift from the state that produced it.
 *
 * WHY `profileImageUrl` is materialized rather than resolved per read:
 * `AuthService.getCurrentUser`, `CirclesService.listMembers`, and the admin
 * users table all already select that column. Writing the resolved value there
 * propagates the new avatar app-wide with zero changes to any of those
 * consumers.
 *
 * NOT touched by this service: the OAuth refresh in `AuthService.handleLogin`,
 * which writes only the `provider*` columns. It correctly never clobbers a user
 * override, and it stays that way — an `oauth`-sourced user simply resolves to
 * whatever `providerProfileImageUrl` currently holds (or `null`, which the
 * frontend renders as initials, rather than a broken image).
 */
@Injectable()
export class UserAvatarService {
  private readonly logger = new Logger(UserAvatarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
    private readonly circleMembership: CircleMembershipService,
    private readonly userSettings: UserSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve the URL that should be materialized into `User.profileImageUrl`.
   *
   *   | avatarSource        | resolved URL                                  |
   *   |---------------------|-----------------------------------------------|
   *   | upload / person     | /api/users/{id}/avatar?v={avatarVersion}      |
   *   | oauth               | providerProfileImageUrl                       |
   *   | anything unusable   | null (frontend falls back to initials)        |
   *
   * The `?v=` cache-buster is what lets the byte-proxy respond `immutable` with
   * a one-year max-age while still updating the instant the avatar changes:
   * `avatarVersion` is regenerated on every render, so the URL itself changes.
   */
  resolveAvatarUrl(user: AvatarColumns): string | null {
    const derived =
      user.avatarSource === UserAvatarSource.upload ||
      user.avatarSource === UserAvatarSource.person;

    if (derived && user.avatarStorageKey) {
      const base = `/api/users/${user.id}/avatar`;
      return user.avatarVersion ? `${base}?v=${user.avatarVersion}` : base;
    }

    if (user.avatarSource === UserAvatarSource.oauth) {
      return user.providerProfileImageUrl ?? null;
    }

    // Derived source with no stored bytes (e.g. a reset that raced a render):
    // null rather than a URL that would 404.
    return null;
  }

  // ---------------------------------------------------------------------------
  // GET /api/users/me/profile
  // ---------------------------------------------------------------------------

  async getProfile(userId: string): Promise<UserProfileDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...AVATAR_COLUMNS,
        email: true,
        displayName: true,
        providerDisplayName: true,
        profileImageUrl: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    return {
      id: user.id,
      email: user.email,
      // Override-then-provider, identical to AuthService.getCurrentUser.
      displayName: user.displayName || user.providerDisplayName || null,
      // The materialized column WINS over a fresh resolve, deliberately: it is
      // literally what auth/me, member lists, and the admin table render, and
      // this page must not claim a different picture from the rest of the app.
      // The resolve is only a backstop for a row this service has never
      // written (a pre-#354 user, whose column may still hold a value from the
      // old settings-based flow). The first avatar action normalizes it.
      avatarUrl: user.profileImageUrl ?? this.resolveAvatarUrl(user),
      avatarSource: user.avatarSource,
      providerProfileImageUrl: user.providerProfileImageUrl,
      linkedPerson: await this.describeLinkedPerson(user.linkedPersonId),
    };
  }

  // ---------------------------------------------------------------------------
  // PATCH /api/users/me/profile
  // ---------------------------------------------------------------------------

  /**
   * Apply any combination of display-name, person-link, and avatar-source
   * changes. Each field is independent — a PATCH carrying only `displayName`
   * never touches the avatar.
   *
   * Order matters: the link is applied before `avatarSource` so a single
   * request can both link a person and immediately reset to the OAuth picture.
   */
  async updateProfile(
    user: RequestUser,
    dto: UpdateUserProfileDto,
  ): Promise<UserProfileDto> {
    // 1. Display name — delegated so UserSettingsService stays the single
    //    writer of User.displayName (its syncDisplayName does the column write)
    //    and user_settings.profile.displayName cannot drift from it.
    //    `null` maps to '' because the settings schema types displayName as a
    //    non-nullable optional string; syncDisplayName turns any falsy value
    //    back into a NULL column.
    if (dto.displayName !== undefined) {
      await this.userSettings.patchSettings(user.id, {
        profile: { displayName: dto.displayName ?? '' },
      });
    }

    // An explicit avatarSource in the same request wins over the implicit
    // "linking re-renders" behaviour, so we never render bytes only to discard
    // them a step later.
    const implicitRender = dto.avatarSource === undefined;

    // 2. Person link.
    if (dto.linkedPersonId !== undefined) {
      if (dto.linkedPersonId === null) {
        // Unlink only. The picture is deliberately left alone: "this Person is
        // me" and "this is the picture I display" are separate statements, and
        // the already-rendered bytes remain a perfectly good avatar.
        await this.writeAvatarState(user.id, { linkedPersonId: null });
      } else {
        await this.assertPersonLinkable(user, dto.linkedPersonId);
        await this.writeAvatarState(user.id, { linkedPersonId: dto.linkedPersonId });

        if (implicitRender) {
          // Linking IS the moment the picture becomes available, so it is also
          // the moment we adopt it.
          await this.renderFromPersonAndStore(user.id, dto.linkedPersonId);
        }
      }
    }

    // 3. Avatar source.
    if (dto.avatarSource !== undefined) {
      await this.applyAvatarSource(user.id, dto.avatarSource);
    }

    return this.getProfile(user.id);
  }

  // ---------------------------------------------------------------------------
  // POST /api/users/me/avatar
  // ---------------------------------------------------------------------------

  /**
   * Render and store an uploaded image as this user's avatar.
   *
   * The client's Content-Type is only a cheap pre-filter; the authoritative
   * validation is that sharp decodes the bytes into a real image (non-zero
   * dimensions). HEIC/HEIF decode natively in the API image, with
   * `prepareImageForProcessing`'s ffmpeg-transcode fallback behind it.
   */
  async uploadAvatar(
    userId: string,
    file: { buffer: Buffer; filename?: string; mimetype?: string },
  ): Promise<UserProfileDto> {
    if (file.buffer.length === 0) {
      throw new BadRequestException('Uploaded file is empty');
    }

    if (file.mimetype && !AVATAR_ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported image type "${file.mimetype}". Allowed: ${AVATAR_ALLOWED_MIME_TYPES.join(', ')}`,
      );
    }

    const prepared = await prepareImageForProcessing(file.buffer, {
      maxDim: AVATAR_SOURCE_MAX_DIM,
      fileExtension: file.filename ? extname(file.filename) : undefined,
    });

    // width === 0 is prepareImageForProcessing's "could not decode" signal (it
    // returns the input buffer untouched rather than throwing).
    if (prepared.width === 0 || prepared.height === 0) {
      throw new BadRequestException(
        'The uploaded file could not be read as an image',
      );
    }

    // 'attention' picks the most salient region, which on an arbitrary uploaded
    // photo is nearly always the subject's face — the right default when the
    // user has given us no crop of their own.
    const jpeg = await this.renderAvatarJpeg(prepared.buffer, {
      focus: 'attention',
    });

    await this.storeAndAdopt(userId, jpeg, UserAvatarSource.upload);
    return this.getProfile(userId);
  }

  // ---------------------------------------------------------------------------
  // POST /api/users/me/avatar/from-person
  // ---------------------------------------------------------------------------

  /** Re-render the avatar from the currently linked person. */
  async renderFromLinkedPerson(userId: string): Promise<UserProfileDto> {
    const user = await this.loadAvatarColumns(userId);

    if (!user.linkedPersonId) {
      throw new BadRequestException(
        'This account is not linked to a person yet. Link one first.',
      );
    }

    // Defense-in-depth backstop (issue #406): `deletePerson` clears
    // linkedPersonId as part of deleting a person, but this re-checks
    // liveness directly rather than trusting that every path that can make a
    // person unusable has already done so (a race between two tabs, or any
    // future deletion path). Throws a friendly, actionable message and
    // self-heals instead of reaching renderPersonAvatar's raw
    // NotFoundException naming an internal UUID.
    await this.assertLinkedPersonLive(userId, user.linkedPersonId);

    await this.renderFromPersonAndStore(userId, user.linkedPersonId);
    return this.getProfile(userId);
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/users/me/avatar
  // ---------------------------------------------------------------------------

  /**
   * Reset to the OAuth picture.
   *
   * This KEEPS `linkedPersonId`. The link asserts "this Person is me", which
   * stays true regardless of which picture is displayed; unlinking is the
   * separate, explicit `PATCH /api/users/me/profile { linkedPersonId: null }`.
   */
  async resetAvatar(userId: string): Promise<UserProfileDto> {
    await this.resetAvatarState(userId);
    return this.getProfile(userId);
  }

  // ---------------------------------------------------------------------------
  // GET /api/users/:id/avatar — byte proxy
  // ---------------------------------------------------------------------------

  /**
   * Resolve the stored avatar bytes for the byte-proxy route.
   *
   * Throws 404 when the user has no stored avatar (an `oauth`-sourced user's
   * picture lives on the provider's CDN, not here).
   */
  async resolveStoredAvatar(userId: string): Promise<ResolvedObject> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarStorageKey: true },
    });

    if (!user?.avatarStorageKey) {
      throw new NotFoundException('This user has no stored avatar');
    }

    return this.resolveObject(user.avatarStorageKey);
  }

  // ---------------------------------------------------------------------------
  // Cross-module hooks (PeopleService)
  // ---------------------------------------------------------------------------

  /**
   * Best-effort re-render for every account whose displayed avatar is derived
   * from this person — called when the person's chosen profile picture changes.
   *
   * Deliberately total: it logs and swallows every failure, because the caller
   * is a person update that must not fail because an avatar could not be
   * re-rendered (same fire-and-forget posture as the notification producers).
   *
   * Only `avatarSource: 'person'` accounts are touched. A linked user who is
   * displaying an upload or the OAuth picture has not adopted the person's
   * picture, so there is nothing to refresh.
   */
  async refreshAvatarsForPerson(personId: string): Promise<void> {
    try {
      const linked = await this.prisma.user.findMany({
        where: { linkedPersonId: personId, avatarSource: UserAvatarSource.person },
        select: { id: true },
      });

      for (const user of linked) {
        try {
          await this.renderFromPersonAndStore(user.id, personId);
        } catch (err) {
          this.logger.warn(
            `refreshAvatarsForPerson: re-render failed for user ${user.id} / person ${personId} (non-fatal): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `refreshAvatarsForPerson: lookup failed for person ${personId} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Carry every link from a merged-away person onto the merge target.
   *
   * Called from INSIDE `PeopleService.mergePeople`'s transaction, mirroring how
   * `coverFaceId` is carried over there, so the link cannot survive a rolled-back
   * merge. The rendered bytes need no refresh: the avatar URL addresses the
   * USER, not the person, so it stays valid — which is also why neither
   * `profileImageUrl` nor `avatarVersion` is touched here.
   */
  async carryLinkedUsersOnMerge(
    tx: Prisma.TransactionClient,
    sourcePersonId: string,
    targetPersonId: string,
  ): Promise<number> {
    const { count } = await tx.user.updateMany({
      where: { linkedPersonId: sourcePersonId },
      data: { linkedPersonId: targetPersonId },
    });
    return count;
  }

  /**
   * Detach every account linked to a person that is being (or was just)
   * soft-deleted (issue #406).
   *
   * `Person.deletedAt` is a soft-delete, so the `User.linkedPersonId ->
   * Person.id` FK's `onDelete: SetNull` — which only fires on a genuine row
   * delete — never runs, and the column would otherwise dangle forever.
   * Called from INSIDE `PeopleService.deletePerson`'s transaction, on the
   * `tx` passed in, mirroring `carryLinkedUsersOnMerge`'s shape: the clear
   * MUST be atomic with the soft-delete itself, so a request that fails after
   * this call can never leave the link half-cleaned.
   *
   * Only clears `linkedPersonId` here — it does NOT reset avatar state, since
   * that write touches `profileImageUrl` (fine inside a transaction) but the
   * superseded storage bytes must also be reaped, which talks to the storage
   * provider and does not belong inside a DB transaction. Callers should pass
   * the returned `resetUserIds` to `resetAvatarsAfterUnlink` AFTER the
   * transaction commits.
   */
  async unlinkUsersFromPerson(
    tx: Prisma.TransactionClient,
    personId: string,
  ): Promise<{ unlinkedUserIds: string[]; resetUserIds: string[] }> {
    const linked = await tx.user.findMany({
      where: { linkedPersonId: personId },
      select: { id: true, avatarSource: true },
    });

    if (linked.length === 0) {
      return { unlinkedUserIds: [], resetUserIds: [] };
    }

    const unlinkedUserIds = linked.map((u) => u.id);
    const resetUserIds = linked
      .filter((u) => u.avatarSource === UserAvatarSource.person)
      .map((u) => u.id);

    await tx.user.updateMany({
      where: { id: { in: unlinkedUserIds } },
      data: { linkedPersonId: null },
    });

    return { unlinkedUserIds, resetUserIds };
  }

  /**
   * Best-effort avatar-state reset for the `resetUserIds` returned by
   * `unlinkUsersFromPerson` — every account that was actively displaying a
   * now-deleted person's derived picture falls back to the OAuth picture,
   * using the exact same reset semantics `resetAvatarState` applies elsewhere
   * (avatarSource -> oauth, avatarStorageKey -> null, avatarVersion -> null,
   * profileImageUrl recomputed).
   *
   * MUST be called AFTER the caller's transaction has committed: it writes
   * through `this.prisma` (not a `tx`) and reaps storage bytes, neither of
   * which belongs inside a DB transaction. Mirrors `refreshAvatarsForPerson`'s
   * fire-and-forget posture — a failure to reset one user's avatar must never
   * fail (or partially undo) the person deletion that triggered it.
   */
  async resetAvatarsAfterUnlink(userIds: string[]): Promise<void> {
    for (const userId of userIds) {
      try {
        await this.resetAvatarState(userId);
      } catch (err) {
        this.logger.warn(
          `resetAvatarsAfterUnlink: avatar reset failed for user ${userId} (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — state writes
  // ---------------------------------------------------------------------------

  /**
   * The single write path for all five avatar columns.
   *
   * Reads the current row, applies the patch in memory, resolves the URL from
   * the RESULT, and writes the patch plus the freshly-resolved
   * `profileImageUrl` in one statement — so the materialized URL is always a
   * function of the source columns it was written beside.
   */
  private async writeAvatarState(
    userId: string,
    patch: {
      avatarSource?: UserAvatarSource;
      avatarStorageKey?: string | null;
      avatarVersion?: string | null;
      linkedPersonId?: string | null;
    },
  ): Promise<AvatarColumns> {
    const current = await this.loadAvatarColumns(userId);
    const next: AvatarColumns = { ...current, ...patch };

    return this.prisma.user.update({
      where: { id: userId },
      data: { ...patch, profileImageUrl: this.resolveAvatarUrl(next) },
      select: AVATAR_COLUMNS,
    });
  }

  private async loadAvatarColumns(userId: string): Promise<AvatarColumns> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: AVATAR_COLUMNS,
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    return user;
  }

  /**
   * Point the account back at the OAuth picture and reap the stored bytes.
   * `linkedPersonId` is deliberately untouched — see `resetAvatar`.
   */
  private async resetAvatarState(userId: string): Promise<void> {
    const previous = await this.loadAvatarColumns(userId);

    await this.writeAvatarState(userId, {
      avatarSource: UserAvatarSource.oauth,
      avatarStorageKey: null,
      avatarVersion: null,
    });

    await this.deleteAvatarObject(previous.avatarStorageKey);
  }

  /** Apply an explicit `avatarSource` switch from PATCH /users/me/profile. */
  private async applyAvatarSource(
    userId: string,
    source: UserAvatarSource,
  ): Promise<void> {
    if (source === UserAvatarSource.oauth) {
      await this.resetAvatarState(userId);
      return;
    }

    if (source === UserAvatarSource.person) {
      const user = await this.loadAvatarColumns(userId);
      if (!user.linkedPersonId) {
        throw new BadRequestException(
          'This account is not linked to a person yet. Link one first.',
        );
      }
      // Defense-in-depth backstop (issue #406) — see renderFromLinkedPerson.
      await this.assertLinkedPersonLive(userId, user.linkedPersonId);
      await this.renderFromPersonAndStore(userId, user.linkedPersonId);
      return;
    }

    // 'upload': uploaded bytes only ever arrive via POST /users/me/avatar,
    // which sets the source itself. Selecting it here is therefore only ever a
    // no-op re-affirmation of an existing upload — anything else would relabel
    // person-derived bytes as an upload they are not.
    const user = await this.loadAvatarColumns(userId);
    if (user.avatarSource !== UserAvatarSource.upload || !user.avatarStorageKey) {
      throw new BadRequestException(
        'No uploaded picture is stored for this account. Upload an image first.',
      );
    }
  }

  /** Render from a person, store the bytes, and adopt them as the avatar. */
  private async renderFromPersonAndStore(
    userId: string,
    personId: string,
  ): Promise<void> {
    const jpeg = await this.renderPersonAvatar(personId);
    await this.storeAndAdopt(userId, jpeg, UserAvatarSource.person);
  }

  /**
   * Upload freshly-rendered bytes, point the user at them, and reap whatever
   * they replaced — so an account accumulates at most one avatar object.
   */
  private async storeAndAdopt(
    userId: string,
    jpeg: Buffer,
    source: UserAvatarSource,
  ): Promise<void> {
    const previous = await this.loadAvatarColumns(userId);
    const storageKey = await this.storeAvatarObject(userId, jpeg);

    await this.writeAvatarState(userId, {
      avatarSource: source,
      avatarStorageKey: storageKey,
      // Regenerated on EVERY change — this is what makes the immutable
      // Cache-Control on the byte proxy safe.
      avatarVersion: randomBytes(6).toString('hex'),
    });

    await this.deleteAvatarObject(previous.avatarStorageKey);
  }

  // ---------------------------------------------------------------------------
  // Private — storage
  // ---------------------------------------------------------------------------

  /**
   * Write the rendered avatar to the active provider and register its
   * StorageObject row DIRECTLY at `status: 'ready'`.
   *
   * We deliberately do NOT route through `ObjectsService.simpleUpload`: that
   * emits OBJECT_UPLOADED_EVENT, which would drag the avatar through the entire
   * media processing pipeline (content hashing, thumbnail generation, EXIF
   * extraction, perceptual hashing, dedup). An avatar is not a media item — it
   * has no MediaItem row, appears in no gallery, and must never enter a review
   * queue.
   *
   * For the same reason the `avatars/` prefix must never become an input to the
   * processing pipeline, exactly like the `thumbnails/` recursion guard in
   * ThumbnailProcessor. Writing `status: 'ready'` also keeps these rows out of
   * StorageProcessingRecoveryTask's stuck-at-`processing` sweep.
   */
  private async storeAvatarObject(userId: string, jpeg: Buffer): Promise<string> {
    const storageKey = `${AVATAR_KEY_PREFIX}${userId}/${randomUUID()}.jpg`;

    const { id: providerId, provider } = await this.resolver.getActiveProvider();

    await provider.upload(storageKey, Readable.from(jpeg), {
      mimeType: 'image/jpeg',
      contentLength: jpeg.length,
    });

    await this.prisma.storageObject.create({
      data: {
        name: `avatar-${userId}.jpg`,
        size: BigInt(jpeg.length),
        mimeType: 'image/jpeg',
        storageKey,
        storageProvider: providerId,
        bucket: provider.getBucket(),
        status: 'ready',
        uploadedById: userId,
        metadata: { avatarOf: userId },
      },
    });

    return storageKey;
  }

  /**
   * Remove a superseded avatar's bytes and its StorageObject row.
   *
   * Strictly best-effort: a failed delete leaves an orphan object, which is
   * cheap, whereas failing the request would leave the user unable to change
   * their picture.
   */
  private async deleteAvatarObject(storageKey: string | null): Promise<void> {
    if (!storageKey) return;

    try {
      const { provider } = await this.resolveObject(storageKey);
      await provider.delete(storageKey);
    } catch (err) {
      this.logger.warn(
        `deleteAvatarObject: failed to delete bytes for ${storageKey} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    try {
      await this.prisma.storageObject.deleteMany({ where: { storageKey } });
    } catch (err) {
      this.logger.warn(
        `deleteAvatarObject: failed to delete StorageObject row for ${storageKey} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Resolve the provider that owns a stored key, via its StorageObject row. */
  private async resolveObject(storageKey: string): Promise<ResolvedObject> {
    const object = await this.prisma.storageObject.findUnique({
      where: { storageKey },
      select: { storageProvider: true, bucket: true },
    });

    if (!object) {
      throw new NotFoundException('Stored object not found');
    }

    const provider = await this.resolver.getProviderFor(
      object.storageProvider,
      object.bucket,
    );

    return { provider, storageKey };
  }

  private async downloadObject(storageKey: string): Promise<Buffer> {
    const { provider } = await this.resolveObject(storageKey);
    return streamToBuffer(await provider.download(storageKey));
  }

  // ---------------------------------------------------------------------------
  // Private — person-derived rendering
  // ---------------------------------------------------------------------------

  /**
   * Build a 512x512 avatar from a Person, in strict preference order:
   *
   *   1. The picture the user explicitly chose on the People page
   *      (`profileMediaItemId` + `profileCrop`).
   *   2. The resolved cover face — explicit `coverFaceId`, else the best face by
   *      confidence, matching PeopleService.pickCoverFace's `coverFace ?? faces[0]`
   *      over a `confidence DESC, createdAt DESC` ordering.
   *   3. Nothing usable → 400 with an actionable message.
   *
   * Each tier falls through to the next when its source is unusable (media item
   * trashed, a video with no saved frame, undecodable bytes), so a stale
   * explicit choice degrades to the cover face rather than to an error.
   */
  private async renderPersonAvatar(personId: string): Promise<Buffer> {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: {
        id: true,
        deletedAt: true,
        coverFaceId: true,
        profileMediaItemId: true,
        profileCrop: true,
      },
    });

    if (!person || person.deletedAt) {
      throw new NotFoundException(`Person ${personId} not found`);
    }

    // --- 1. Explicit profile picture + crop ---
    const crop = parseNormalizedCrop(person.profileCrop);
    if (person.profileMediaItemId && crop) {
      const rendered = await this.renderFromProfileCrop(
        person.profileMediaItemId,
        crop,
      );
      if (rendered) return rendered;
    }

    // --- 2. Cover face ---
    const face = await this.resolveCoverFace(personId, person.coverFaceId);
    if (face) {
      const rendered = await this.renderFromFace(face);
      if (rendered) return rendered;
    }

    // --- 3. Nothing usable ---
    throw new BadRequestException(
      'This person has no profile picture or detected face yet. Set one on the People page first.',
    );
  }

  private async renderFromProfileCrop(
    mediaItemId: string,
    crop: NormalizedCrop,
  ): Promise<Buffer | null> {
    const prepared = await this.loadPreparedPhoto(mediaItemId);
    if (!prepared) return null;

    // The crop is normalized against the DISPLAYED image, and
    // prepareImageForProcessing has already applied EXIF orientation, so the
    // rectangle maps directly onto the prepared buffer.
    // 'centre' (not 'attention') because the user already told us what the
    // subject is — re-deciding it here would move their crop.
    return this.renderAvatarJpeg(prepared.buffer, {
      focus: 'centre',
      extract: toPixelRegion(crop, prepared.width, prepared.height),
    });
  }

  private async resolveCoverFace(
    personId: string,
    coverFaceId: string | null,
  ): Promise<{ mediaItemId: string; boundingBox: unknown; frameThumbnailKey: string | null } | null> {
    const select = {
      mediaItemId: true,
      boundingBox: true,
      frameThumbnailKey: true,
    } as const;

    if (coverFaceId) {
      const cover = await this.prisma.face.findUnique({
        where: { id: coverFaceId },
        select,
      });
      if (cover) return cover;
    }

    return this.prisma.face.findFirst({
      where: { personId },
      orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
      select,
    });
  }

  private async renderFromFace(face: {
    mediaItemId: string;
    boundingBox: unknown;
    frameThumbnailKey: string | null;
  }): Promise<Buffer | null> {
    // A video-sourced face already has a saved representative-frame JPEG; use
    // it directly rather than trying to decode the video here.
    if (face.frameThumbnailKey) {
      try {
        const bytes = await this.downloadObject(face.frameThumbnailKey);
        return await this.renderAvatarJpeg(bytes, { focus: 'centre' });
      } catch (err) {
        this.logger.warn(
          `renderFromFace: frame thumbnail ${face.frameThumbnailKey} unusable, falling back: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const prepared = await this.loadPreparedPhoto(face.mediaItemId);
    if (!prepared) return null;

    const bbox = parseNormalizedCrop(face.boundingBox);
    if (!bbox) return null;

    // buildFaceCropThumbnail returns an ENCODED JPEG (padded face crop, `fit:
    // inside`), so squaring it costs a second encode. Accepted: it is the same
    // helper the video face pipeline uses, and re-implementing the padding
    // maths here would be a second source of truth for face framing.
    const cropped = await buildFaceCropThumbnail(prepared.buffer, {
      boundingBox: bbox,
      cropMaxDim: AVATAR_DIM * 2,
    });

    return this.renderAvatarJpeg(cropped, { focus: 'centre' });
  }

  /**
   * Download a media item's ORIGINAL bytes and auto-orient them.
   *
   * Returns null (rather than throwing) whenever the item is not a usable
   * still image — trashed, a video, or undecodable — so the caller can fall
   * through to the next tier.
   */
  private async loadPreparedPhoto(
    mediaItemId: string,
  ): Promise<{ buffer: Buffer; width: number; height: number } | null> {
    try {
      const item = await this.prisma.mediaItem.findUnique({
        where: { id: mediaItemId },
        select: {
          type: true,
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

      if (
        !item ||
        item.deletedAt ||
        item.type !== MediaType.photo ||
        !item.storageObject ||
        !item.storageObject.mimeType.startsWith('image/')
      ) {
        return null;
      }

      const provider = await this.resolver.getProviderFor(
        item.storageObject.storageProvider,
        item.storageObject.bucket,
      );
      const bytes = await streamToBuffer(
        await provider.download(item.storageObject.storageKey),
      );

      const prepared = await prepareImageForProcessing(bytes, {
        maxDim: AVATAR_SOURCE_MAX_DIM,
        fileExtension: extname(item.storageObject.storageKey),
      });

      return prepared.width > 0 && prepared.height > 0 ? prepared : null;
    } catch (err) {
      this.logger.warn(
        `loadPreparedPhoto: MediaItem ${mediaItemId} unusable as an avatar source: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — rendering
  // ---------------------------------------------------------------------------

  /**
   * Normalize any source image to the one avatar artifact: a square
   * 512x512 JPEG at quality 85.
   *
   * EXIF is auto-oriented upstream (`prepareImageForProcessing`) and then
   * STRIPPED here by re-encoding without `withMetadata()` — deliberately, so an
   * uploaded phone photo cannot leak its GPS coordinates through an avatar that
   * every member of every shared circle can fetch.
   *
   * `extract` (when supplied) is applied in the SAME pipeline as the resize, so
   * a cropped render costs one decode/encode rather than two.
   */
  private async renderAvatarJpeg(
    source: Buffer,
    opts: { focus: 'attention' | 'centre'; extract?: PixelRegion | null },
  ): Promise<Buffer> {
    const sharp = (await import('sharp')).default;

    let pipeline = sharp(source);
    if (opts.extract) {
      pipeline = pipeline.extract(opts.extract);
    }

    return pipeline
      .resize(AVATAR_DIM, AVATAR_DIM, { fit: 'cover', position: opts.focus })
      .jpeg({ quality: AVATAR_QUALITY })
      .toBuffer();
  }

  // ---------------------------------------------------------------------------
  // Private — person link
  // ---------------------------------------------------------------------------

  /**
   * Validate that the caller may link to this person.
   *
   * The person must exist, be live, and live in a circle the caller can see.
   * Every failure — missing, soft-deleted, or in a circle the caller is not a
   * member of — surfaces as 404, never 403: a 403 would confirm that the id
   * names a real person in a circle the caller cannot see, which is exactly the
   * enumeration the public-share and notification routes also refuse to allow.
   *
   * The thrown message is deliberately generic (issue #406) — it must never
   * reveal WHICH of the two cases applied, only that linking cannot proceed.
   * A concrete example of the "missing" case: the picker's client-side list
   * goes stale between page load and the click (the person gets soft-deleted
   * via `PeopleService.mergePeople`/`deletePerson` in that window), so a
   * user who picked a real, visible option can still land here — a bare
   * UUID in a raw NotFoundException gave them nothing to act on. Each throw
   * site logs server-side first, at `warn` (an expected, user-triggerable
   * condition, not a system fault), so the disambiguating detail the client
   * never sees is still traceable from the logs.
   */
  private async assertPersonLinkable(
    user: RequestUser,
    personId: string,
  ): Promise<void> {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: { id: true, circleId: true, deletedAt: true },
    });

    if (!person || person.deletedAt) {
      this.logger.warn(
        `assertPersonLinkable: person ${personId} not found or deleted (requested by user ${user.id})`,
      );
      throw new NotFoundException(PERSON_UNLINKABLE_MESSAGE);
    }

    try {
      await this.circleMembership.assertCircleAccess(
        user.id,
        person.circleId,
        user.permissions,
        CircleRole.viewer,
      );
    } catch (err) {
      this.logger.warn(
        `assertPersonLinkable: circle access denied for person ${personId} (circle ${person.circleId}), user ${user.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Collapse Forbidden (and any circle-level NotFound) into a single 404.
      throw new NotFoundException(PERSON_UNLINKABLE_MESSAGE);
    }
  }

  /**
   * Defense-in-depth backstop (issue #406) for the two entry points that
   * actually READ a person to render bytes — `renderFromLinkedPerson` and
   * `applyAvatarSource`'s `'person'` branch — as opposed to
   * `describeLinkedPerson`, which only ever DESCRIBES the link for a GET.
   *
   * `PeopleService.deletePerson` clears `linkedPersonId` for every linked
   * account as part of the delete itself, so this should normally never fire.
   * It exists for whatever that cleanup doesn't (yet) cover — a race between
   * two tabs, or a future way for a person to become unusable without going
   * through `deletePerson` — and it self-heals exactly like that cleanup
   * does: clears the stale link, and falls an actively `'person'`-sourced
   * avatar back to `'oauth'`, so the affordance is consistently disabled on
   * the client's next `GET /api/users/me/profile` instead of failing the same
   * way forever. Throws a friendly, actionable message rather than
   * `renderPersonAvatar`'s raw `NotFoundException` naming an internal UUID.
   */
  private async assertLinkedPersonLive(
    userId: string,
    personId: string,
  ): Promise<void> {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: { deletedAt: true },
    });

    if (person && !person.deletedAt) return;

    const current = await this.loadAvatarColumns(userId);
    const wasPersonSourced = current.avatarSource === UserAvatarSource.person;

    if (wasPersonSourced) {
      const previousStorageKey = current.avatarStorageKey;
      await this.writeAvatarState(userId, {
        linkedPersonId: null,
        avatarSource: UserAvatarSource.oauth,
        avatarStorageKey: null,
        avatarVersion: null,
      });
      await this.deleteAvatarObject(previousStorageKey);
    } else {
      await this.writeAvatarState(userId, { linkedPersonId: null });
    }

    throw new BadRequestException(
      'Your linked person no longer exists. Please link a different person.',
    );
  }

  /**
   * Describe the linked person for the profile response.
   *
   * Returns null for an absent link AND for a link whose person has since been
   * soft-deleted — while a hard delete nulls the column outright via the FK's
   * `onDelete: SetNull`. In both cases the user may still be serving
   * person-derived bytes; reporting `linkedPerson: null` is how the UI learns to
   * offer a re-link.
   */
  private async describeLinkedPerson(
    linkedPersonId: string | null,
  ): Promise<UserProfileDto['linkedPerson']> {
    if (!linkedPersonId) return null;

    const person = await this.prisma.person.findUnique({
      where: { id: linkedPersonId },
      select: {
        id: true,
        name: true,
        circleId: true,
        deletedAt: true,
        circle: { select: { name: true } },
      },
    });

    if (!person || person.deletedAt) return null;

    return {
      id: person.id,
      name: person.name,
      circleId: person.circleId,
      circleName: person.circle.name,
    };
  }
}

// ---------------------------------------------------------------------------
// Module-local helpers
// ---------------------------------------------------------------------------

/**
 * Parse a normalized `{x,y,w,h}` rectangle out of a JSONB column.
 *
 * Shared by `Person.profileCrop` and `Face.boundingBox`, which use the same
 * 0..1 shape. Returns null for anything malformed or degenerate so the caller
 * can fall through to a lower-preference source.
 */
function parseNormalizedCrop(value: unknown): NormalizedCrop | null {
  if (!value || typeof value !== 'object') return null;

  const raw = value as Record<string, unknown>;
  const x = Number(raw['x']);
  const y = Number(raw['y']);
  const w = Number(raw['w']);
  const h = Number(raw['h']);

  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  if (w <= 0 || h <= 0) return null;

  return { x, y, w, h };
}

/** Convert a normalized rectangle to a pixel region clamped to the image. */
function toPixelRegion(
  crop: NormalizedCrop,
  imageWidth: number,
  imageHeight: number,
): PixelRegion {
  const left = clamp(Math.round(crop.x * imageWidth), 0, Math.max(0, imageWidth - 1));
  const top = clamp(Math.round(crop.y * imageHeight), 0, Math.max(0, imageHeight - 1));

  const width = clamp(Math.round(crop.w * imageWidth), 1, imageWidth - left);
  const height = clamp(Math.round(crop.h * imageHeight), 1, imageHeight - top);

  return { left, top, width, height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
