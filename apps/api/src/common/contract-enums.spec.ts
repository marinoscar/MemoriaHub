// The wire vocabularies of @marinoscar/memoriahub-contract are literal tuples
// (the package cannot import Prisma). This pins each one to the database enum
// it mirrors, in the same order, so a new enum value cannot reach the database
// without reaching the wire schemas (and the OpenAPI document) too.
import {
  LocationGroupLevel,
  MediaEnhancementStatus,
  MediaSyncDeviceStatus,
  MediaSyncRunStatus,
  MediaSyncTrigger,
  MemoryType,
  ReviewRunAction,
  ReviewRunSubject,
  WorkflowRunStatus,
  WorkflowTrigger,
} from '@prisma/client';
import { ENHANCEMENT_STATUSES } from '@marinoscar/memoriahub-contract/enhancement';
import { LOCATION_GROUP_LEVELS } from '@marinoscar/memoriahub-contract/location';
import {
  MEDIA_SYNC_DEVICE_STATUSES,
  MEDIA_SYNC_RUN_STATUSES,
  MEDIA_SYNC_TRIGGERS,
} from '@marinoscar/memoriahub-contract/media-sync';
import { MEMORY_TYPES } from '@marinoscar/memoriahub-contract/memories';
import { REVIEW_RUN_ACTIONS, REVIEW_RUN_SUBJECTS } from '@marinoscar/memoriahub-contract/review-runs';
import { WORKFLOW_RUN_STATUSES, WORKFLOW_TRIGGERS } from '@marinoscar/memoriahub-contract/workflows';

describe('contract vocabularies mirror the Prisma enums', () => {
  const cases: Array<[string, readonly string[], Record<string, string>]> = [
    ['WORKFLOW_TRIGGERS', WORKFLOW_TRIGGERS, WorkflowTrigger],
    ['WORKFLOW_RUN_STATUSES', WORKFLOW_RUN_STATUSES, WorkflowRunStatus],
    ['MEMORY_TYPES', MEMORY_TYPES, MemoryType],
    ['ENHANCEMENT_STATUSES', ENHANCEMENT_STATUSES, MediaEnhancementStatus],
    ['REVIEW_RUN_SUBJECTS', REVIEW_RUN_SUBJECTS, ReviewRunSubject],
    ['REVIEW_RUN_ACTIONS', REVIEW_RUN_ACTIONS, ReviewRunAction],
    ['MEDIA_SYNC_TRIGGERS', MEDIA_SYNC_TRIGGERS, MediaSyncTrigger],
    ['MEDIA_SYNC_RUN_STATUSES', MEDIA_SYNC_RUN_STATUSES, MediaSyncRunStatus],
    ['MEDIA_SYNC_DEVICE_STATUSES', MEDIA_SYNC_DEVICE_STATUSES, MediaSyncDeviceStatus],
    ['LOCATION_GROUP_LEVELS', LOCATION_GROUP_LEVELS, LocationGroupLevel],
  ];

  it.each(cases)('%s has the values of its enum, in order', (_name, tuple, prismaEnum) => {
    expect([...tuple]).toEqual(Object.values(prismaEnum));
  });
});
