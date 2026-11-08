import {
  ONBOARDING_FACTS,
  evaluateDoctorChecks,
  type OnboardingFacts,
  type OnboardingStepDef,
} from '@marinoscar/platform-api/onboarding';

import {
  MEMORIAHUB_ONBOARDING_FACTS as F,
  type AlbumCountsFact,
  type CircleMembershipFact,
  type DevicesFact,
  type FeatureReadinessFact,
  type MediaCountsFact,
  type PeopleNamedFact,
} from './onboarding.facts';

// =============================================================================
// MemoriaHub's onboarding steps (RETRO-H3, #599)
// =============================================================================
//
// STEP IDS ARE PERMANENT: a user's `onboarding.skipped` stores them, and the activation milestone
// names `memoriahub.first_upload`. Rename a title, an href, a tier or an order freely; never an id.
// The list is recorded in docs/specs/onboarding.md.
//
// A step NEVER issues a query: every `applies` / `evaluate` below is a pure function of the facts it
// names (`onboarding.facts.ts`), which is what bounds a request's cost (`no-io-in-evaluate` in the
// `onboarding` conformance suite proves it).
//
// User (Get started), in order:
//   memoriahub.first_upload    required     media:write                   the activation milestone
//   memoriahub.create_album    recommended  media:write   after the first upload
//   memoriahub.invite_member   recommended  circles:write when collaborator+ in a circle
//   memoriahub.name_people     recommended  media:write   feature `faceRecognition`
//   memoriahub.connect_device  optional     media:write   the Android app or the CLI
//   user.profile, user.notifications (the platform's, orders 10 and 20)
//
// Administrator (Setup guide), in order:
//   memoriahub.storage_ready   required     storage_settings:read   (replaces the platform's admin.storage)
//   admin.email                required     the platform's step: it is MemoriaHub's `email_ready`
//   admin.access               required     the platform's
//   memoriahub.enable_faces    recommended  face_settings:read      flag on AND the Doctor's face.detection passes
//   memoriahub.enable_tagging  recommended  ai_settings:read        flag on AND tagging model with an enabled key
//   memoriahub.enable_memories recommended  system_settings:read    flag on
//   admin.push, admin.backup   recommended  the platform's
//
// Each step's `permission` is the exact string its page's API enforces; a caller without it never
// sees the step (it is omitted, not shown blocked).
// =============================================================================

/** The step ids, spelled once. PERMANENT. */
export const MEMORIAHUB_ONBOARDING_STEP_IDS = {
  FIRST_UPLOAD: 'memoriahub.first_upload',
  CREATE_ALBUM: 'memoriahub.create_album',
  INVITE_MEMBER: 'memoriahub.invite_member',
  NAME_PEOPLE: 'memoriahub.name_people',
  CONNECT_DEVICE: 'memoriahub.connect_device',
  STORAGE_READY: 'memoriahub.storage_ready',
  ENABLE_FACES: 'memoriahub.enable_faces',
  ENABLE_TAGGING: 'memoriahub.enable_tagging',
  ENABLE_MEMORIES: 'memoriahub.enable_memories',
} as const;

/** The deployment feature `memoriahub.name_people` is gated on (`ONBOARDING_FEATURES`). */
export const FACE_RECOGNITION_FEATURE = 'faceRecognition';

/** The Doctor check `memoriahub.enable_faces` reuses (the CompreFace connectivity probe). */
export const FACE_DETECTION_CHECK_ID = 'memoriahub.face.detection';

const S = MEMORIAHUB_ONBOARDING_STEP_IDS;

/** The `doctor` fact's value (`ReadonlyMap<checkId, DoctorCheckReport>`), as `evaluateDoctorChecks` takes it. */
type DoctorReports = Parameters<typeof evaluateDoctorChecks>[1];

const done = (yes: boolean) => ({ status: yes ? ('done' as const) : ('todo' as const) });
const readiness = (facts: OnboardingFacts) => facts[F.FEATURE_READINESS] as FeatureReadinessFact;

// -- user ----------------------------------------------------------------------

export const FIRST_UPLOAD_STEP: OnboardingStepDef = {
  id: S.FIRST_UPLOAD,
  audience: 'user',
  tier: 'required',
  order: 1,
  title: 'Upload your first photo or video',
  description: 'Add a photo or a video to your library. Everything else (albums, people, memories) starts from it.',
  actionLabel: 'Upload',
  href: '/',
  // `POST /api/media` (registering an upload) enforces media:write.
  permission: 'media:write',
  skippable: false,
  facts: [F.MEDIA_COUNTS],
  // A trashed item still counts: the upload happened.
  funnelSql: 'EXISTS (SELECT 1 FROM media_items m WHERE m.added_by_id = c.id)',
  evaluate: (facts) => done((facts[F.MEDIA_COUNTS] as MediaCountsFact).addedByUser > 0),
};

export const CREATE_ALBUM_STEP: OnboardingStepDef = {
  id: S.CREATE_ALBUM,
  audience: 'user',
  tier: 'recommended',
  order: 2,
  title: 'Create an album',
  description: 'Gather the photos of an event or a trip in one place you can share.',
  actionLabel: 'Open albums',
  href: '/albums',
  // `POST /api/media/albums` enforces media:write.
  permission: 'media:write',
  skippable: true,
  facts: [F.MEDIA_COUNTS, F.ALBUM_COUNTS],
  funnelSql: 'EXISTS (SELECT 1 FROM albums a WHERE a.added_by_id = c.id)',
  // An album of nothing is not the point: offered once there is something to put in it.
  applies: (facts) => (facts[F.MEDIA_COUNTS] as MediaCountsFact).addedByUser > 0,
  evaluate: (facts) => done((facts[F.ALBUM_COUNTS] as AlbumCountsFact).addedByUser > 0),
};

export const INVITE_MEMBER_STEP: OnboardingStepDef = {
  id: S.INVITE_MEMBER,
  audience: 'user',
  tier: 'recommended',
  order: 3,
  title: 'Invite your family',
  description: 'Invite somebody into one of your circles so you can share the library.',
  actionLabel: 'Open circles',
  href: '/circles',
  // `POST /api/circles/:id/invites` enforces circles:write (plus the circle_admin role in the circle).
  permission: 'circles:write',
  skippable: true,
  facts: [F.CIRCLE_MEMBERSHIP],
  // Only a collaborator or circle admin can invite anybody.
  applies: (facts) => (facts[F.CIRCLE_MEMBERSHIP] as CircleMembershipFact).collaboratorCircles > 0,
  evaluate: (facts) => {
    const m = facts[F.CIRCLE_MEMBERSHIP] as CircleMembershipFact;
    return done(m.otherMembers > 0 || m.pendingInvites > 0);
  },
};

export const NAME_PEOPLE_STEP: OnboardingStepDef = {
  id: S.NAME_PEOPLE,
  audience: 'user',
  tier: 'recommended',
  order: 4,
  title: 'Name the people in your photos',
  description: 'Give a name to a face the app found, so you can find every photo of that person.',
  actionLabel: 'Open people',
  href: '/people',
  // `PATCH /api/people/:id` (naming a person) enforces media:write.
  permission: 'media:write',
  // Hidden (not "todo") while face recognition is off: there is nothing to name.
  feature: FACE_RECOGNITION_FEATURE,
  skippable: true,
  facts: [F.PEOPLE_NAMED],
  evaluate: (facts) => done((facts[F.PEOPLE_NAMED] as PeopleNamedFact).named > 0),
};

export const CONNECT_DEVICE_STEP: OnboardingStepDef = {
  id: S.CONNECT_DEVICE,
  audience: 'user',
  tier: 'optional',
  order: 5,
  title: 'Back up your phone automatically',
  description: 'Pair the Android app (or sign in with the command-line tool) so new photos arrive on their own.',
  actionLabel: 'Get the app',
  href: '/settings/android-app',
  // Registering a Media Sync device enforces media:write.
  permission: 'media:write',
  skippable: true,
  facts: [F.DEVICES],
  evaluate: (facts) => {
    const d = facts[F.DEVICES] as DevicesFact;
    return done(d.syncDevices > 0 || d.activeTokens > 0);
  },
};

// -- administrator -------------------------------------------------------------

export const STORAGE_READY_STEP: OnboardingStepDef = {
  id: S.STORAGE_READY,
  audience: 'admin',
  tier: 'required',
  order: 10,
  title: 'Connect object storage',
  description: 'Choose where photos and videos are stored. Nothing can be uploaded until a provider is configured.',
  actionLabel: 'Configure storage',
  href: '/admin/settings/storage/providers',
  // `GET /api/storage-settings` enforces storage_settings:read.
  permission: 'storage_settings:read',
  skippable: false,
  facts: [F.FEATURE_READINESS],
  evaluate: (facts) =>
    readiness(facts).storageReady
      ? { status: 'done' }
      : { status: 'todo', detail: 'The active storage provider has no enabled credential.' },
};

export const ENABLE_FACES_STEP: OnboardingStepDef = {
  id: S.ENABLE_FACES,
  audience: 'admin',
  tier: 'recommended',
  order: 41,
  title: 'Turn on face recognition',
  description: 'Find the people in every photo. Needs the face recognition switch and a reachable CompreFace service.',
  actionLabel: 'Configure faces',
  href: '/admin/settings/face',
  // `GET /api/face/settings` enforces face_settings:read.
  permission: 'face_settings:read',
  skippable: true,
  // The step is omitted when the Doctor check is not registered (sugar of `doctorChecks`).
  doctorChecks: [FACE_DETECTION_CHECK_ID],
  facts: [ONBOARDING_FACTS.DOCTOR, F.FEATURE_READINESS],
  evaluate: (facts) => {
    if (!readiness(facts).faceRecognition) {
      return { status: 'todo', detail: 'Face recognition is switched off.' };
    }
    return evaluateDoctorChecks(
      [FACE_DETECTION_CHECK_ID],
      facts[ONBOARDING_FACTS.DOCTOR] as DoctorReports,
    );
  },
};

export const ENABLE_TAGGING_STEP: OnboardingStepDef = {
  id: S.ENABLE_TAGGING,
  audience: 'admin',
  tier: 'recommended',
  order: 42,
  title: 'Turn on automatic tagging',
  description: 'Describe and tag every photo with AI, which also makes search by meaning work.',
  actionLabel: 'Configure tagging',
  href: '/admin/settings/tagging',
  // The tagging page reads `GET /api/ai/settings`, which enforces ai_settings:read.
  permission: 'ai_settings:read',
  skippable: true,
  facts: [F.FEATURE_READINESS],
  evaluate: (facts) => {
    const r = readiness(facts);
    if (!r.autoTagging) return { status: 'todo', detail: 'Automatic tagging is switched off.' };
    if (!r.taggingProviderReady) {
      return {
        status: 'todo',
        detail: 'Choose a tagging model on the AI Providers page, for a provider with an enabled key.',
      };
    }
    return { status: 'done' };
  },
};

export const ENABLE_MEMORIES_STEP: OnboardingStepDef = {
  id: S.ENABLE_MEMORIES,
  audience: 'admin',
  tier: 'recommended',
  order: 43,
  title: 'Turn on memories',
  description: 'Resurface On This Day, trips and the people in them, on Home and in a weekly email.',
  actionLabel: 'Configure memories',
  href: '/admin/settings/memories',
  // The memories page reads `GET /api/system-settings`, which enforces system_settings:read.
  permission: 'system_settings:read',
  skippable: true,
  facts: [F.FEATURE_READINESS],
  evaluate: (facts) => done(readiness(facts).memories),
};

/** MemoriaHub's steps, in the order they are registered. */
export const MEMORIAHUB_ONBOARDING_STEP_DEFS: readonly OnboardingStepDef[] = [
  FIRST_UPLOAD_STEP,
  CREATE_ALBUM_STEP,
  INVITE_MEMBER_STEP,
  NAME_PEOPLE_STEP,
  CONNECT_DEVICE_STEP,
  STORAGE_READY_STEP,
  ENABLE_FACES_STEP,
  ENABLE_TAGGING_STEP,
  ENABLE_MEMORIES_STEP,
];
