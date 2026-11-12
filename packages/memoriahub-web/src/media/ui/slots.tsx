import { defineHostSlot } from '../../core/ui/index.js';
import {
  MEDIA_LIGHTBOX_SLOT,
  MEDIA_DETAIL_DRAWER_SLOT,
  MEDIA_ENHANCEMENT_DRAWER_SLOT,
  BATCH_ENHANCE_DIALOG_SLOT,
  MEDIA_SHARE_DIALOG_SLOT,
  ALBUM_PEOPLE_DIALOG_SLOT,
  PERSON_MULTI_SELECT_SLOT,
  MERGE_LOCATIONS_DIALOG_SLOT,
} from '../headless/slot-names.js';
import type { AddAlbumItemsByFilterDto, MediaItem } from '../headless/types.js';


// =============================================================================
// Slots: the components the media pages reach but cannot import
// =============================================================================
//
// The gallery, the album page and the places pages reach a few components that
// belong to other slices or to the platform. The host registers them under the
// names below (`slots` of `MemoriahubWebHost`); a host that registers none
// renders the page without them.
//
// - The people pickers (`AlbumPeopleDialog`, `PersonMultiSelect`) and the AI
//   enhancement drawer and batch dialog are the `people` and `enhancement`
//   slices', and stay slots permanently: those slices import `media` (the media
//   clients), so `media` cannot import them back. The web edition binds them to
//   the packaged components.
// - The lightbox and detail drawer (the `viewer` slice) and the location-merge
//   dialog (the `location` slice) stay slots for good for the same reason: those
//   slices import `media`. The platform's share dialog is the host's own.
// =============================================================================

/**
 * Props of the full-screen viewer the host supplies.
 *
 * @stability experimental
 */
export interface MediaLightboxSlotProps {
  /** The items being browsed. */
  items: MediaItem[];
  /** The open item's index, `null` when closed. */
  index: number | null;
  /** Called with the new index. */
  onIndexChange: (i: number) => void;
  /** Close the viewer. */
  onClose: () => void;
  /** Open the properties drawer for an item. */
  onOpenProperties: (item: MediaItem) => void;
  /** Called after the viewer changed an item. */
  onItemUpdated?: (updated: MediaItem) => void;
  /** Start a slideshow when the viewer opens. Default false. */
  autoPlay?: boolean;
}

/**
 * Props of the properties drawer the host supplies.
 *
 * @stability experimental
 */
export interface MediaDetailDrawerSlotProps {
  /** The item, `null` when none. */
  item: MediaItem | null;
  /** Whether the drawer is open. */
  open: boolean;
  /** Close the drawer. */
  onClose: () => void;
  /** Called after the drawer changed the item. */
  onItemUpdated: (updated: MediaItem) => void;
}

/**
 * Props of the single-photo AI enhancement drawer the host supplies.
 *
 * @stability experimental
 */
export interface MediaEnhancementDrawerSlotProps {
  /** The photo. */
  item: MediaItem;
  /** Whether the drawer is open. */
  open: boolean;
  /** Close the drawer. */
  onClose: () => void;
  /** Open onto a known enhancement instead of the item's latest. */
  enhancementId?: string;
  /** The model label shown in the params step. */
  modelLabel?: string | null;
  /** The server-resolved replace policy. */
  replacePolicy?: { allowReplace: boolean; blockReplaceOnDownscale: boolean };
  /** Called after a successful "replace". */
  onReplaced?: () => void;
  /** Called after a successful "keep both". */
  onKeptBoth?: (message: string) => void;
  /** Fired when the enhancement finished while the drawer was closed. */
  onFinishedInBackground?: (status: 'ready' | 'failed') => void;
}

/**
 * Props of the bulk AI enhancement dialog the host supplies.
 *
 * @stability experimental
 */
export interface BatchEnhanceDialogSlotProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Close the dialog. */
  onClose: () => void;
  /** The owner scope id. */
  circleId: string;
  /** The whole selection (by-selection mode). */
  items?: MediaItem[];
  /** Filter mode: submit a filter instead of ids. */
  filterMode?: {
    /** The filter to send verbatim. */
    filters: AddAlbumItemsByFilterDto;
    /** The exact matching count when the caller knows it. */
    matchCount?: number | null;
    /** Qualifier after the count. */
    scopeLabel?: string;
    /** Verb phrase in the refusal. */
    matchPhrase?: string;
  };
  /** `pictureEnhancement.maxBatchSize`. */
  maxBatchSize?: number;
  /** The model label. */
  modelLabel?: string | null;
  /** Called with the server's one-line summary and the batch id. */
  onSuccess: (message: string, batchId: string) => void;
}

/**
 * Props of the share dialog the host supplies (the platform's link-share panel).
 *
 * @stability experimental
 */
export interface MediaShareDialogSlotProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Close the dialog. */
  onClose: () => void;
  /** What is shared. */
  target: { type: 'media_item' | 'album'; id: string };
  /** The dialog title. */
  title?: string;
}

/**
 * Props of the people dialog of an album the host supplies.
 *
 * @stability experimental
 */
export interface AlbumPeopleDialogSlotProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Close the dialog. */
  onClose: () => void;
  /** The album. */
  albumId: string;
  /** The owner scope id. */
  circleId: string;
}

/**
 * The person filter value of the library page.
 *
 * @stability experimental
 */
export interface PersonFilterValue {
  /** The selected person ids. */
  ids: string[];
  /** Match all or any of them. */
  mode: 'all' | 'any';
}

/**
 * Props of the person multi-select the host supplies.
 *
 * @stability experimental
 */
export interface PersonMultiSelectSlotProps {
  /** The owner scope id. */
  circleId: string;
  /** The current value. */
  value: PersonFilterValue;
  /** Called with the next value. */
  onChange: (next: PersonFilterValue) => void;
  /** The field label. */
  label?: string;
}

/**
 * Props of the location-merge dialog the host supplies.
 *
 * @stability experimental
 */
export interface MergeLocationsDialogSlotProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The tier the merge targets. */
  level: 'country' | 'region' | 'locality';
  /** The selected locations. */
  selection: Array<{ value: string; itemCount: number; countryCode?: string | null }>;
  /** The country scope to submit unconditionally; `''` is the unscoped sentinel. */
  forcedCountryCode?: string | null;
  /** Close the dialog. */
  onClose: () => void;
  /** Called with the canonical name of the group the selection was merged into. */
  onMerged: (groupName: string) => void;
}


/** The full-screen viewer, from the host. @stability experimental */
export const MediaLightboxSlot = defineHostSlot<MediaLightboxSlotProps>(MEDIA_LIGHTBOX_SLOT);
/** The properties drawer, from the host. @stability experimental */
export const MediaDetailDrawerSlot = defineHostSlot<MediaDetailDrawerSlotProps>(MEDIA_DETAIL_DRAWER_SLOT);
/** The single-photo enhancement drawer, from the host. @stability experimental */
export const MediaEnhancementDrawerSlot = defineHostSlot<MediaEnhancementDrawerSlotProps>(MEDIA_ENHANCEMENT_DRAWER_SLOT);
/** The bulk enhancement dialog, from the host. @stability experimental */
export const BatchEnhanceDialogSlot = defineHostSlot<BatchEnhanceDialogSlotProps>(BATCH_ENHANCE_DIALOG_SLOT);
/** The share dialog, from the host. @stability experimental */
export const MediaShareDialogSlot = defineHostSlot<MediaShareDialogSlotProps>(MEDIA_SHARE_DIALOG_SLOT);
/** The album people dialog, from the host. @stability experimental */
export const AlbumPeopleDialogSlot = defineHostSlot<AlbumPeopleDialogSlotProps>(ALBUM_PEOPLE_DIALOG_SLOT);
/** The person multi-select, from the host. @stability experimental */
export const PersonMultiSelectSlot = defineHostSlot<PersonMultiSelectSlotProps>(PERSON_MULTI_SELECT_SLOT);
/** The location-merge dialog, from the host. @stability experimental */
export const MergeLocationsDialogSlot = defineHostSlot<MergeLocationsDialogSlotProps>(MERGE_LOCATIONS_DIALOG_SLOT);
