// =============================================================================
// The shape of the system settings document, as this app reads it (RETRO-B3, #614)
// =============================================================================
//
// WHY THIS IS NOT JUST `SystemSettingsValue`. The platform types the document from the
// `SystemSettingsNamespaces` interface, which every slice's declaration file AUGMENTS with its own
// namespace. Six of this app's namespaces are TEMPORARY copies of a namespace whose slice MemoriaHub
// adopts later (`ai`, `storage`, `email`), stored under the
// SAME key but in MemoriaHub's own shape. Augmenting the interface for those keys would declare a
// property twice with different types as soon as the program also sees the platform's declaration
// (any import of `@marinoscar/platform-api/manifest` does): TS2717, and which declaration wins then
// depends on file order, so call sites would compile in one program and not in another.
//
// So those keys are NOT augmented, and the app reads the document through this type instead
// (`AppSystemSettingsService.getSettings()` and `readKnownValue()` are typed with it). Each slice
// adoption removes a key's entry here and augments the interface instead.
// PLATFORM-ADOPTION-SHIM: D1 (storage), D2 (email). `ai` is the platform AI
// slice's since RETRO-E1 (#595); `ai` below is MemoriaHub's view of it (its `features` extension).
// `jobs` and `retention` are the jobs slice's (RETRO-C1), `databaseBackup` the db-backup slice's (RETRO-D4),
// `notifications` the notifications slice's (RETRO-D3).
// =============================================================================

import type { AiSettingsValue } from '../platform/ai/ai-settings.extension';
import type { AutoTaggingSettingsValue } from './registry/namespaces/system/auto-tagging';
import type { BackupSettingsValue } from './registry/namespaces/system/backup';
import type { BurstSettingsValue } from './registry/namespaces/system/burst';
import type { DedupSettingsValue } from './registry/namespaces/system/dedup';
import type { EmailSettingsValue } from './registry/namespaces/system/email';
import type { FaceSettingsValue } from './registry/namespaces/system/face';
import type { FeaturesSettingsValue } from './registry/namespaces/system/features';
import type { GeoSettingsValue } from './registry/namespaces/system/geo';
import type { RetentionSettingsValue } from '@marinoscar/platform-api/jobs';
import type { SystemSettingsNamespaces } from '@marinoscar/platform-api/settings';
import type { LocationGroupingSettingsValue } from './registry/namespaces/system/location-grouping';
import type { LocationInferenceSettingsValue } from './registry/namespaces/system/location-inference';
import type { MemoriesSettingsValue } from './registry/namespaces/system/memories';
import type { PictureEnhancementSettingsValue } from './registry/namespaces/system/picture-enhancement';
import type { ReviewRunsSettingsValue } from './registry/namespaces/system/review-runs';
import type { SocialMediaSettingsValue } from './registry/namespaces/system/social-media';
import type { StorageSettingsValue } from './registry/namespaces/system/storage';
import type { UiSettingsValue } from './registry/namespaces/system/ui';
import type { WorkflowsSettingsValue } from './registry/namespaces/system/workflows';

/** The persisted maintenance window (the platform host core owns the namespace). */
export interface MaintenanceSettingsValue {
  enabled: boolean;
  message: string;
  allowAdmins: boolean;
  startedAt: string | null;
  startedById: string | null;
}

/** Every system namespace this deployment stores, complete (a read fills any gap from the defaults). */
export interface AppSystemSettingsDocument {
  ui: UiSettingsValue;
  features: FeaturesSettingsValue;
  ai: AiSettingsValue;
  autoTagging: AutoTaggingSettingsValue;
  face: FaceSettingsValue;
  storage: StorageSettingsValue;
  burst: BurstSettingsValue;
  dedup: DedupSettingsValue;
  locationInference: LocationInferenceSettingsValue;
  locationGrouping: LocationGroupingSettingsValue;
  socialMedia: SocialMediaSettingsValue;
  geo: GeoSettingsValue;
  email: EmailSettingsValue;
  jobs: SystemSettingsNamespaces['jobs'];
  retention: RetentionSettingsValue;
  reviewRuns: ReviewRunsSettingsValue;
  notifications: SystemSettingsNamespaces['notifications'];
  pictureEnhancement: PictureEnhancementSettingsValue;
  backup: BackupSettingsValue;
  workflows: WorkflowsSettingsValue;
  memories: MemoriesSettingsValue;
  databaseBackup: SystemSettingsNamespaces['databaseBackup'];
  maintenance: MaintenanceSettingsValue;
}

/** `GET /api/system-settings`: the document plus the row's audit fields. */
export type AppSystemSettings = AppSystemSettingsDocument & {
  updatedAt: Date;
  updatedBy: { id: string; email: string } | null;
  version: number;
};
