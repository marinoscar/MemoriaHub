import { describe, expect, it } from 'vitest';
import { identityAdminSections } from '@marinoscar/platform-web/identity/ui';
import { ADMIN_SECTIONS } from '../../config/adminSections';

// The Users & Allowlist card is the identity slice's, spread into the registry
// (RETRO-B2, #611): one declaration, the exact permission the API enforces
// (`users.controller.ts` of @marinoscar/platform-api/identity).
describe('identity cards in ADMIN_SECTIONS', () => {
  const cards = ADMIN_SECTIONS.flatMap((section) => section.cards);

  it('declares every identity access card exactly once', () => {
    for (const card of identityAdminSections.access) {
      expect(cards.filter((c) => c.path === card.path)).toHaveLength(1);
    }
  });

  it('Users & Allowlist is gated on users:read and routes to /admin/settings/users', () => {
    const users = cards.find((c) => c.path === '/admin/settings/users');
    expect(users?.title).toBe('Users & Allowlist');
    expect(users?.permission).toBe('users:read');
  });

  it('does not show the organization cards in single-organization mode', () => {
    const paths = cards.map((c) => c.path);
    expect(paths).not.toContain('/admin/settings/organization');
    expect(paths).not.toContain('/admin/settings/organizations');
  });
});
