/**
 * How MemoriaHub offers sharing of a photo, a video or an album (RETRO-I4, #578).
 *
 * The API's resource types `media_item` and `album` (`apps/api/src/app-registrations/sharing.ts`)
 * grant `viewer` to a person and `viewer` / `editor` to a group, and only `viewer` to a public
 * link; a group editor (a circle collaborator) may manage the links (`share_link: 'editor'`).
 */
import type { SharingRoleOption } from '@marinoscar/platform-web/sharing/headless';

/** What a person or group may be given from the share dialog (the API refuses editor for a person). */
export const MEDIA_SHARE_ROLES: readonly SharingRoleOption[] = [{ value: 'viewer', label: 'Can view' }];

/** What anyone holding a public link gets. */
export const MEDIA_LINK_ROLES: readonly SharingRoleOption[] = [{ value: 'viewer', label: 'Can view' }];

/** The expiry choices of a new public link; "Never" kept from the pre-platform share dialog. */
export const LINK_EXPIRY_PRESETS: ReadonlyArray<{ label: string; days: number | null }> = [
  { label: 'Never', days: null },
  { label: '1 day', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
];

/** The two shareable resource types (ids are permanent). */
export type MediaShareType = 'media_item' | 'album';
