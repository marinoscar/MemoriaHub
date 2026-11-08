import type { OnboardingFactDef } from '@marinoscar/platform-api/onboarding';
import { CircleRole, MediaSyncDeviceStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AiDeploymentKeySource } from '../../ai-port/ai-deployment-key-source';
import { AppSystemSettingsService } from '../settings/app-system-settings.service';
import { isMemoriesEnabled } from '../../settings/feature-gates';
import { resolveActiveStorageProvider } from '../../doctor/checks/storage/active-provider.doctor-check';

// =============================================================================
// MemoriaHub's onboarding facts (RETRO-H3, #599)
// =============================================================================
//
// A fact is the ONLY read an onboarding step may depend on: the platform engine
// resolves each one at most once per request, in parallel, and only when an
// applicable step names it. A step's `applies` / `evaluate` receive plain values
// (`onboarding.steps.ts`), never a client.
//
// Every fact here is BOUNDED and returns counts or flags only, never content:
//
//   memoriahub.media_counts        one `count(... take: 1)` on media_items by added_by_id
//   memoriahub.album_counts        one `count(... take: 1)` on albums by added_by_id
//   memoriahub.circle_membership   the caller's collaborator+ memberships (at most 100 rows),
//                                  then two `count(... take: 1)`: another member, a pending invite
//   memoriahub.people_named        one `count(... take: 1)` over named people in the caller's circles
//   memoriahub.devices             two `count(... take: 1)`: an active Media Sync device, an active PAT
//   memoriahub.feature_readiness   the cached system settings (5 s TTL) plus at most two
//                                  `findFirst` on the credential tables; resolved only for an
//                                  administrator (only admin steps name it)
//
// `take: 1` makes each count a presence test: the steps only ever ask "is there one", and the
// cost stays constant however large the library is. The values are therefore 0 or 1.
//
// FACT IDS are not persisted (only step ids are), but a step's `facts` array names them; a rename
// is a two-file change `assertOnboardingRegistries` checks at boot.
// =============================================================================

/** The fact ids, spelled once. */
export const MEMORIAHUB_ONBOARDING_FACTS = {
  MEDIA_COUNTS: 'memoriahub.media_counts',
  ALBUM_COUNTS: 'memoriahub.album_counts',
  CIRCLE_MEMBERSHIP: 'memoriahub.circle_membership',
  PEOPLE_NAMED: 'memoriahub.people_named',
  DEVICES: 'memoriahub.devices',
  FEATURE_READINESS: 'memoriahub.feature_readiness',
} as const;

/** `memoriahub.media_counts`: media items the caller registered (trashed ones included: the upload happened). */
export interface MediaCountsFact {
  /** 0 or 1 (a presence test). */
  addedByUser: number;
}

/** `memoriahub.album_counts`: albums the caller created. */
export interface AlbumCountsFact {
  /** 0 or 1 (a presence test). */
  addedByUser: number;
}

/** `memoriahub.circle_membership`: whether the caller can invite, and whether anybody else is in. */
export interface CircleMembershipFact {
  /** Circles where the caller is `collaborator` or `circle_admin` (capped at 100). */
  collaboratorCircles: number;
  /** In one of those circles: another member (0 or 1). */
  otherMembers: number;
  /** In one of those circles: an unclaimed invite (0 or 1). */
  pendingInvites: number;
}

/** `memoriahub.people_named`: named, live people in circles the caller belongs to. */
export interface PeopleNamedFact {
  /** 0 or 1 (a presence test). */
  named: number;
}

/** `memoriahub.devices`: what the caller connected besides the browser. */
export interface DevicesFact {
  /** Active Media Sync devices (0 or 1). */
  syncDevices: number;
  /** Personal access tokens neither revoked nor expired, the CLI's credential (0 or 1). */
  activeTokens: number;
}

/** `memoriahub.feature_readiness`: the deployment's media features, as the admin steps read them. */
export interface FeatureReadinessFact {
  /** `storage.activeProvider` (else `STORAGE_PROVIDER`, else `s3`) is `local` or has an enabled credential. */
  storageReady: boolean;
  /** `features.faceRecognition`. */
  faceRecognition: boolean;
  /** `features.autoTagging`. */
  autoTagging: boolean;
  /** `ai.features.tagging` names a provider and a model, and that provider has an enabled credential. */
  taggingProviderReady: boolean;
  /** `features.memories` (and `MEMORIES_ENABLED` is not `false`). */
  memories: boolean;
}

export const MEDIA_COUNTS_FACT: OnboardingFactDef<MediaCountsFact> = {
  id: MEMORIAHUB_ONBOARDING_FACTS.MEDIA_COUNTS,
  resolve: async (ctx) => ({
    addedByUser: await ctx.get(PrismaService).mediaItem.count({
      where: { addedById: ctx.caller.id },
      take: 1,
    }),
  }),
};

export const ALBUM_COUNTS_FACT: OnboardingFactDef<AlbumCountsFact> = {
  id: MEMORIAHUB_ONBOARDING_FACTS.ALBUM_COUNTS,
  resolve: async (ctx) => ({
    addedByUser: await ctx.get(PrismaService).album.count({
      where: { addedById: ctx.caller.id },
      take: 1,
    }),
  }),
};

/** At most this many memberships are read (a user in more circles than this is not a first-run user). */
export const MEMBERSHIP_READ_CAP = 100;

export const CIRCLE_MEMBERSHIP_FACT: OnboardingFactDef<CircleMembershipFact> = {
  id: MEMORIAHUB_ONBOARDING_FACTS.CIRCLE_MEMBERSHIP,
  resolve: async (ctx) => {
    const prisma = ctx.get(PrismaService);
    const memberships = await prisma.circleMember.findMany({
      where: { userId: ctx.caller.id, role: { in: [CircleRole.collaborator, CircleRole.circle_admin] } },
      select: { circleId: true },
      take: MEMBERSHIP_READ_CAP,
    });
    const circleIds = memberships.map((m) => m.circleId);
    if (circleIds.length === 0) return { collaboratorCircles: 0, otherMembers: 0, pendingInvites: 0 };
    const [otherMembers, pendingInvites] = await Promise.all([
      prisma.circleMember.count({
        where: { circleId: { in: circleIds }, userId: { not: ctx.caller.id } },
        take: 1,
      }),
      prisma.circleInvite.count({ where: { circleId: { in: circleIds }, claimedAt: null }, take: 1 }),
    ]);
    return { collaboratorCircles: circleIds.length, otherMembers, pendingInvites };
  },
};

export const PEOPLE_NAMED_FACT: OnboardingFactDef<PeopleNamedFact> = {
  id: MEMORIAHUB_ONBOARDING_FACTS.PEOPLE_NAMED,
  resolve: async (ctx) => ({
    named: await ctx.get(PrismaService).person.count({
      where: {
        name: { not: null },
        deletedAt: null,
        mergedIntoId: null,
        circle: { members: { some: { userId: ctx.caller.id } } },
      },
      take: 1,
    }),
  }),
};

export const DEVICES_FACT: OnboardingFactDef<DevicesFact> = {
  id: MEMORIAHUB_ONBOARDING_FACTS.DEVICES,
  resolve: async (ctx) => {
    const prisma = ctx.get(PrismaService);
    const [syncDevices, activeTokens] = await Promise.all([
      prisma.mediaSyncDevice.count({
        where: { userId: ctx.caller.id, status: MediaSyncDeviceStatus.active },
        take: 1,
      }),
      prisma.personalAccessToken.count({
        where: { userId: ctx.caller.id, revokedAt: null, expiresAt: { gt: new Date() } },
        take: 1,
      }),
    ]);
    return { syncDevices, activeTokens };
  },
};

/**
 * The deployment's readiness. The flags come from the CACHED settings document
 * (`AppSystemSettingsService.getSettings`, the same read every feature gate makes), and the storage
 * credential read is a `findFirst` with a `select` of the id only and the AI one a key status: no key material is ever read.
 */
export const FEATURE_READINESS_FACT: OnboardingFactDef<FeatureReadinessFact> = {
  id: MEMORIAHUB_ONBOARDING_FACTS.FEATURE_READINESS,
  resolve: async (ctx) => {
    const settings = await ctx.get(AppSystemSettingsService).getSettings();
    const prisma = ctx.get(PrismaService);

    const storageProvider = resolveActiveStorageProvider(
      settings.storage?.activeProvider,
      process.env['STORAGE_PROVIDER'],
    );
    const tagging = settings.ai?.features?.tagging;

    const [storageCredential, taggingCredential] = await Promise.all([
      storageProvider === 'local'
        ? Promise.resolve(null)
        : prisma.storageProviderCredential.findFirst({
            where: { provider: storageProvider, enabled: true },
            select: { id: true },
          }),
      // The platform deployment key first, then the legacy row (RETRO-E3, #605); a status read,
      // never a decryption.
      tagging?.provider && tagging.model
        ? ctx.get(AiDeploymentKeySource).status(tagging.provider)
        : Promise.resolve(null),
    ]);

    return {
      storageReady: storageProvider === 'local' || storageCredential !== null,
      faceRecognition: settings.features?.['faceRecognition'] === true,
      autoTagging: settings.features?.['autoTagging'] === true,
      taggingProviderReady: taggingCredential !== null && taggingCredential.configured && taggingCredential.enabled,
      memories: isMemoriesEnabled(settings),
    };
  },
};

/** MemoriaHub's facts, in the order they are registered. */
export const MEMORIAHUB_ONBOARDING_FACT_DEFS: readonly OnboardingFactDef[] = [
  MEDIA_COUNTS_FACT,
  ALBUM_COUNTS_FACT,
  CIRCLE_MEMBERSHIP_FACT,
  PEOPLE_NAMED_FACT,
  DEVICES_FACT,
  FEATURE_READINESS_FACT,
];
