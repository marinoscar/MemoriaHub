import type { SvgIconComponent } from '@mui/icons-material';
import PhonelinkRingIcon from '@mui/icons-material/PhonelinkRing';

/**
 * The settings page of the paired Android phones.
 *
 * @stability experimental
 */
export const MEDIA_SYNC_SETTINGS_PATH = '/settings/media-sync';

/**
 * One card of a settings hub, as data. Structurally the platform's `SettingsCardDef`
 * (title, description, `Icon`, `path`, `permission`, `feature`), declared here so the
 * package imports no platform package; the app spreads it into its registries.
 *
 * @typeParam Feature - the feature keys the card may name; none by default.
 *
 * @remarks
 * `permission` is the exact string the API controller enforces, never invented;
 * `feature` hides the card while that feature is off.
 *
 * @stability experimental
 */
export interface MemoriahubSettingsCard<Feature extends string = never> {
  /** The card title. */
  title: string;
  /** One line under the title. */
  description: string;
  /** The icon, as a component (the hub renders it at 40px and the rail at 20px). */
  Icon: SvgIconComponent;
  /** The route the card opens. */
  path: string;
  /** The permission string the API enforces; the card is hidden without it. */
  permission?: string;
  /** The feature the card needs on; a card with none leaves it out (`Feature` defaults to `never`, so a card with a gate names it: `MemoriahubSettingsCard<'ai'>`). */
  feature?: Feature;
}

/**
 * The per-user settings cards of the domain, grouped by the hub group they join
 * (`apps/web/src/config/userSettingsSections.tsx` spreads each group after its own
 * cards, which keeps the registry's append order).
 *
 * @remarks
 * `Media sync` is behind `media:read`, the string `media-sync.controller.ts` enforces
 * on `GET /api/media-sync/devices`.
 *
 * @stability experimental
 */
export const memoriahubUserSettingsCards: Readonly<{ android: readonly MemoriahubSettingsCard[] }> = {
  android: [
    {
      title: 'Media sync',
      description: 'See and manage the phones that back up their photos and videos to this server.',
      Icon: PhonelinkRingIcon,
      path: MEDIA_SYNC_SETTINGS_PATH,
      permission: 'media:read',
    },
  ],
};
