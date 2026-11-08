/**
 * MemoriaHub's onboarding steps (RETRO-H3, #599): facts in, status out.
 *
 * Every step is a pure function of the facts it names; these tests feed facts and read the status,
 * and pin the registry the manifest builds (the permanent ids, the two built-ins left out, the
 * activation milestone).
 */
import {
  ONBOARDING_FACTS,
  ONBOARDING_STEP_IDS,
  activationMilestoneRegistry,
  onboardingFactRegistry,
  onboardingStepRegistry,
  type OnboardingStepDef,
} from '@marinoscar/platform-api/onboarding';

import '../../src/platform/onboarding/onboarding.manifest';
import { EXCLUDED_PLATFORM_STEP_IDS } from '../../src/platform/onboarding/onboarding.manifest';
import { MEMORIAHUB_ONBOARDING_FACTS as F } from '../../src/platform/onboarding/onboarding.facts';
import {
  CONNECT_DEVICE_STEP,
  CREATE_ALBUM_STEP,
  ENABLE_FACES_STEP,
  ENABLE_MEMORIES_STEP,
  ENABLE_TAGGING_STEP,
  FACE_DETECTION_CHECK_ID,
  FIRST_UPLOAD_STEP,
  INVITE_MEMBER_STEP,
  MEMORIAHUB_ONBOARDING_STEP_IDS,
  NAME_PEOPLE_STEP,
  STORAGE_READY_STEP,
} from '../../src/platform/onboarding/onboarding.steps';

const readiness = (over: Partial<Record<string, boolean>> = {}) => ({
  [F.FEATURE_READINESS]: {
    storageReady: false,
    faceRecognition: false,
    autoTagging: false,
    taggingProviderReady: false,
    memories: false,
    ...over,
  },
});

const status = (step: OnboardingStepDef, facts: Record<string, unknown>) => step.evaluate!(facts).status;

describe('MemoriaHub onboarding registry', () => {
  it('registers the nine permanent memoriahub.* step ids', () => {
    const ids = onboardingStepRegistry
      .list()
      .map((s) => s.id)
      .filter((id) => id.startsWith('memoriahub.'))
      .sort();
    expect(ids).toEqual(
      [
        'memoriahub.connect_device',
        'memoriahub.create_album',
        'memoriahub.enable_faces',
        'memoriahub.enable_memories',
        'memoriahub.enable_tagging',
        'memoriahub.first_upload',
        'memoriahub.invite_member',
        'memoriahub.name_people',
        'memoriahub.storage_ready',
      ].sort(),
    );
    expect(Object.values(MEMORIAHUB_ONBOARDING_STEP_IDS).sort()).toEqual(ids);
  });

  it('keeps the platform built-ins except admin.storage and admin.ai', () => {
    const ids = onboardingStepRegistry.list().map((s) => s.id);
    expect(EXCLUDED_PLATFORM_STEP_IDS).toEqual([ONBOARDING_STEP_IDS.STORAGE, ONBOARDING_STEP_IDS.AI]);
    for (const excluded of EXCLUDED_PLATFORM_STEP_IDS) expect(ids).not.toContain(excluded);
    expect(ids).toEqual(
      expect.arrayContaining([ONBOARDING_STEP_IDS.EMAIL, ONBOARDING_STEP_IDS.ACCESS, ONBOARDING_STEP_IDS.PUSH, ONBOARDING_STEP_IDS.BACKUP]),
    );
  });

  it('registers the six MemoriaHub facts and the platform facts', () => {
    const facts = onboardingFactRegistry.list().map((f) => f.id);
    expect(facts).toEqual(expect.arrayContaining([...Object.values(F), ONBOARDING_FACTS.DOCTOR]));
  });

  it('declares the first upload as the activation milestone', () => {
    const milestone = activationMilestoneRegistry.list().find((m) => m.id === 'first_upload');
    expect(milestone).toBeDefined();
    expect(milestone!.firstReachedAtSql).toContain('media_items');
    expect(milestone!.firstReachedAtSql).not.toContain(';');
  });

  it('gives every MemoriaHub step a permission and an in-app href', () => {
    for (const step of onboardingStepRegistry.list().filter((s) => s.id.startsWith('memoriahub.'))) {
      expect(step.permission).toMatch(/^[a-z_]+:[a-z_]+$/);
      expect(step.href.startsWith('/')).toBe(true);
    }
  });

  it('never makes a required step skippable', () => {
    for (const step of onboardingStepRegistry.list()) {
      if (step.tier === 'required') expect(step.skippable).toBe(false);
    }
  });
});

describe('user steps', () => {
  it('first_upload is done once the user registered a media item', () => {
    expect(status(FIRST_UPLOAD_STEP, { [F.MEDIA_COUNTS]: { addedByUser: 0 } })).toBe('todo');
    expect(status(FIRST_UPLOAD_STEP, { [F.MEDIA_COUNTS]: { addedByUser: 1 } })).toBe('done');
    expect(FIRST_UPLOAD_STEP.tier).toBe('required');
  });

  it('create_album applies only after the first upload', () => {
    expect(CREATE_ALBUM_STEP.applies!({ [F.MEDIA_COUNTS]: { addedByUser: 0 } })).toBe(false);
    expect(CREATE_ALBUM_STEP.applies!({ [F.MEDIA_COUNTS]: { addedByUser: 1 } })).toBe(true);
    expect(status(CREATE_ALBUM_STEP, { [F.ALBUM_COUNTS]: { addedByUser: 0 } })).toBe('todo');
    expect(status(CREATE_ALBUM_STEP, { [F.ALBUM_COUNTS]: { addedByUser: 1 } })).toBe('done');
  });

  it('invite_member applies to a collaborator and is done with company or a pending invite', () => {
    const m = (collaboratorCircles: number, otherMembers: number, pendingInvites: number) => ({
      [F.CIRCLE_MEMBERSHIP]: { collaboratorCircles, otherMembers, pendingInvites },
    });
    expect(INVITE_MEMBER_STEP.applies!(m(0, 0, 0))).toBe(false);
    expect(INVITE_MEMBER_STEP.applies!(m(1, 0, 0))).toBe(true);
    expect(status(INVITE_MEMBER_STEP, m(1, 0, 0))).toBe('todo');
    expect(status(INVITE_MEMBER_STEP, m(1, 1, 0))).toBe('done');
    expect(status(INVITE_MEMBER_STEP, m(1, 0, 1))).toBe('done');
  });

  it('name_people is gated on the faceRecognition feature (hidden, not todo, while off)', () => {
    expect(NAME_PEOPLE_STEP.feature).toBe('faceRecognition');
    expect(status(NAME_PEOPLE_STEP, { [F.PEOPLE_NAMED]: { named: 0 } })).toBe('todo');
    expect(status(NAME_PEOPLE_STEP, { [F.PEOPLE_NAMED]: { named: 1 } })).toBe('done');
  });

  it('connect_device is done with a Media Sync device or an active token', () => {
    const d = (syncDevices: number, activeTokens: number) => ({ [F.DEVICES]: { syncDevices, activeTokens } });
    expect(CONNECT_DEVICE_STEP.tier).toBe('optional');
    expect(status(CONNECT_DEVICE_STEP, d(0, 0))).toBe('todo');
    expect(status(CONNECT_DEVICE_STEP, d(1, 0))).toBe('done');
    expect(status(CONNECT_DEVICE_STEP, d(0, 1))).toBe('done');
  });
});

describe('administrator steps', () => {
  it('storage_ready follows the active provider readiness', () => {
    expect(STORAGE_READY_STEP.audience).toBe('admin');
    expect(STORAGE_READY_STEP.href).toBe('/admin/settings/storage');
    expect(status(STORAGE_READY_STEP, readiness())).toBe('todo');
    expect(status(STORAGE_READY_STEP, readiness({ storageReady: true }))).toBe('done');
  });

  it('enable_faces needs the flag AND a passing face.detection Doctor check', () => {
    const doctor = (s: 'pass' | 'fail' | 'skip') =>
      new Map([[FACE_DETECTION_CHECK_ID, { id: FACE_DETECTION_CHECK_ID, status: s, detail: 'x', remedy: 'fix it' }]]);
    expect(ENABLE_FACES_STEP.doctorChecks).toEqual([FACE_DETECTION_CHECK_ID]);
    expect(status(ENABLE_FACES_STEP, { ...readiness(), [ONBOARDING_FACTS.DOCTOR]: doctor('pass') })).toBe('todo');
    expect(
      status(ENABLE_FACES_STEP, { ...readiness({ faceRecognition: true }), [ONBOARDING_FACTS.DOCTOR]: doctor('fail') }),
    ).toBe('todo');
    expect(
      status(ENABLE_FACES_STEP, { ...readiness({ faceRecognition: true }), [ONBOARDING_FACTS.DOCTOR]: doctor('pass') }),
    ).toBe('done');
  });

  it('enable_tagging needs the flag AND a tagging model with an enabled key', () => {
    expect(status(ENABLE_TAGGING_STEP, readiness({ taggingProviderReady: true }))).toBe('todo');
    expect(status(ENABLE_TAGGING_STEP, readiness({ autoTagging: true }))).toBe('todo');
    expect(status(ENABLE_TAGGING_STEP, readiness({ autoTagging: true, taggingProviderReady: true }))).toBe('done');
  });

  it('enable_memories follows the memories gate', () => {
    expect(status(ENABLE_MEMORIES_STEP, readiness())).toBe('todo');
    expect(status(ENABLE_MEMORIES_STEP, readiness({ memories: true }))).toBe('done');
  });

  it('links each admin step to its settings page', () => {
    expect(ENABLE_FACES_STEP.href).toBe('/admin/settings/face');
    expect(ENABLE_TAGGING_STEP.href).toBe('/admin/settings/tagging');
    expect(ENABLE_MEMORIES_STEP.href).toBe('/admin/settings/memories');
  });
});
