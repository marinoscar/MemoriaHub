import { z } from 'zod';

import { defineSystemNamespace } from '../../define-namespace';

/**
 * Constants for the well-known feature flag keys stored in `features`.
 * System-wide on/off switches, Admin-managed.
 */
export const FEATURE_KEYS = {
  AUTO_TAGGING: 'autoTagging',
  FACE_RECOGNITION: 'faceRecognition',
  BURST_DETECTION: 'burstDetection',
  DUPLICATE_DETECTION: 'duplicateDetection',
  LOCATION_INFERENCE: 'locationInference',
  SOCIAL_MEDIA_DETECTION: 'socialMediaDetection',
  FACE_AUTO_ARCHIVE: 'faceAutoArchive',
  PICTURE_ENHANCEMENT: 'pictureEnhancement',
  WORKFLOWS: 'workflows',
  MEMORIES: 'memories',
  LOCATION_GROUPING: 'locationGrouping',
} as const;

// A free-form flag map on purpose: a flag is added by code, not by a migration,
// and a PATCH merges it key by key (an unlisted flag keeps its stored value).
const flagMap = z.record(z.string(), z.boolean());
export type FeaturesSettingsValue = z.infer<typeof flagMap>;

const defaults: FeaturesSettingsValue = Object.fromEntries(
  Object.values(FEATURE_KEYS).map((flag) => [flag, false]),
);

// `features` is the one namespace whose value IS the record, not an object
// holding one, so it is declared by hand instead of through defineSystemNamespace.
export const FEATURES_SYSTEM_SETTINGS = {
  key: 'features',
  description: 'Global feature flags (system-wide on/off, Admin-managed), keyed by flag name.',
  storedSchema: flagMap,
  patchSchema: flagMap,
  putSchema: flagMap,
  wirePatchSchema: flagMap,
  responseSchema: flagMap,
  defaults,
  requiredOnPut: false,
  read(stored: unknown): FeaturesSettingsValue {
    const parsed = flagMap.safeParse(stored);
    return parsed.success ? parsed.data : { ...defaults };
  },
  merge(current: FeaturesSettingsValue, patch: FeaturesSettingsValue | undefined): FeaturesSettingsValue {
    return { ...current, ...(patch ?? {}) };
  },
};
