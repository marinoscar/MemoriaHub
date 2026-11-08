/**
 * `config/userSettingsSections.tsx` (RETRO-B5, #621): the per-user hub's
 * registry. The platform suites (`conformance.test.ts`) pin the generic shape;
 * this file pins MemoriaHub's own cards.
 */
import { describe, expect, it } from 'vitest';
import { identityUserSettingsSections } from '@marinoscar/platform-web/identity/ui';
import { webhooksUserSettingsSections } from '@marinoscar/platform-web/webhooks/ui';
import { visibleSettingsSections } from '@marinoscar/platform-web/settings/ui';
import { USER_HUB_PATH, USER_SETTINGS_SECTIONS } from '../../config/userSettingsSections';

const cards = USER_SETTINGS_SECTIONS.flatMap((section) => section.cards);
const titlesFor = (permissions: string[]) =>
  visibleSettingsSections(USER_SETTINGS_SECTIONS, (p) => permissions.includes(p)).flatMap((s) =>
    s.cards.map((c) => c.title),
  );

describe('USER_SETTINGS_SECTIONS', () => {
  it('holds every section the stacked /settings page used to stack, in hub order', () => {
    expect(cards.map((c) => c.path)).toEqual([
      '/settings/profile',
      '/settings/appearance',
      '/settings/time-zone',
      '/settings/notifications',
      '/settings/memories',
      '/settings/search',
      '/settings/android-app',
      '/settings/media-sync',
      '/settings/tokens',
      // RETRO-H4 (#603): the Integrations section, appended.
      '/settings/webhooks',
    ]);
  });

  it('spreads the webhooks slice’s per-user card under Integrations, gated on webhooks:read', () => {
    const integrations = USER_SETTINGS_SECTIONS.find((section) => section.label === 'Integrations')!;
    expect(integrations.cards.map((c) => [c.path, c.permission])).toEqual(
      webhooksUserSettingsSections.integrations.map((c) => [c.path, c.permission]),
    );
    expect(integrations.cards.map((c) => [c.path, c.permission])).toEqual([['/settings/webhooks', 'webhooks:read']]);
  });

  it('spreads the identity slice’s per-user cards (Access Tokens)', () => {
    for (const card of identityUserSettingsSections.security) {
      expect(cards.filter((c) => c.path === card.path)).toHaveLength(1);
    }
  });

  it('gates only Media sync (media:read) and Webhooks (webhooks:read), each on its controller’s string', () => {
    const gated = cards.filter((c) => c.permission !== undefined);
    expect(gated.map((c) => [c.path, c.permission])).toEqual([
      ['/settings/media-sync', 'media:read'],
      ['/settings/webhooks', 'webhooks:read'],
    ]);
  });

  it('shows Media sync and Webhooks only to holders of their permission; every other card to everyone', () => {
    expect(titlesFor([])).not.toContain('Media sync');
    expect(titlesFor(['media:read'])).toContain('Media sync');
    expect(titlesFor(['webhooks:read'])).toContain('Webhooks');
    expect(titlesFor([])).toHaveLength(cards.length - 2);
  });

  it('routes every card under the hub', () => {
    for (const card of cards) expect(card.path?.startsWith(`${USER_HUB_PATH}/`)).toBe(true);
  });
});
