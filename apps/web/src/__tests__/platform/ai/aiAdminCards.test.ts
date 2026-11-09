/**
 * The admin AI cards (RETRO-E4, #607): AI rule 5 and the Settings UI Pattern, pinned on
 * MemoriaHub's registry.
 *
 * The platform's `settings-ai-cards` web suite checks exactly this, but also requires a
 * per-user AI card (`ai:use`, the AI Keys page), which MemoriaHub deliberately does not ship:
 * deployment keys only, no user BYOK and no Playground (RETRO-E1 decision; EnterpriseAppBase
 * #1132 asks for a deployment-only key policy). So `conformance.test.ts` skips that suite with
 * this reason, and this file runs its admin half against the same discovery rule (a card with
 * `feature: 'ai'` or an `ai` path segment) and the same generated permission catalog.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ADMIN_HUB_PATH, ADMIN_SECTIONS, visibleAdminSections } from '../../../config/adminSections';
import { USER_SETTINGS_SECTIONS } from '../../../config/userSettingsSections';

const HERE = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(resolve(HERE, '../../../../../api/prisma/catalog/permissions.json'), 'utf8'),
) as { permissions: { name: string }[] };
const KNOWN = new Set(catalog.permissions.map((p) => p.name));

const AI_SEGMENT = /(^|\/)ai(\/|$)/;
type Card = { title: string; path?: string; permission?: string; feature?: string; alwaysShow?: unknown };
const cards = (sections: readonly { cards: readonly unknown[] }[]) =>
  sections.flatMap((s) => s.cards as Card[]);
const isAiCard = (card: Card) => card.feature === 'ai' || (card.path !== undefined && AI_SEGMENT.test(card.path));

const adminAi = cards(ADMIN_SECTIONS).filter(isAiCard);
const userAi = cards(USER_SETTINGS_SECTIONS).filter(isAiCard);
const SWITCH_PATH = `${ADMIN_HUB_PATH}/ai`;

describe('admin AI cards (AI rule 5)', () => {
  it('finds the three platform AI cards: AI, AI Models, AI Usage', () => {
    expect(adminAi.map((card) => card.title).sort()).toEqual(['AI', 'AI Models', 'AI Usage']);
  });

  it('each declares ai_config:read, a permission the generated catalog has', () => {
    for (const card of adminAi) {
      expect(card.permission).toBe('ai_config:read');
      expect(KNOWN.has(card.permission!)).toBe(true);
    }
  });

  it('every AI card is feature-gated on "ai" except the AI card, which switches AI on', () => {
    const switchCard = adminAi.find((card) => card.path === SWITCH_PATH);
    expect(switchCard?.feature).toBeUndefined();
    expect(adminAi.filter((card) => card.path !== SWITCH_PATH).every((card) => card.feature === 'ai')).toBe(true);
    expect(adminAi.some((card) => card.alwaysShow !== undefined)).toBe(false);
  });

  it('an admin holding every other permission sees no AI card', () => {
    const ai = new Set(['ai:use', 'ai_config:read', 'ai_config:write', 'org_ai_config:read', 'org_ai_config:write']);
    const shown = visibleAdminSections((p) => !ai.has(p), '', { ai: true }).flatMap((s) => s.cards.map((c) => c.title));
    expect(adminAi.filter((card) => shown.includes(card.title))).toEqual([]);
  });

  it('AI Models and AI Usage stay hidden while AI is off; the AI card stays visible', () => {
    const shown = visibleAdminSections(() => true, '', { ai: false }).flatMap((s) => s.cards.map((c) => c.title));
    expect(shown).toContain('AI');
    expect(shown).not.toContain('AI Models');
    expect(shown).not.toContain('AI Usage');
  });

  it('there is no per-user AI card (no BYOK, no Playground): why settings-ai-cards is skipped', () => {
    expect(userAi).toEqual([]);
  });

  it('no card names the retired AI settings permission pair', () => {
    const retired = cards(ADMIN_SECTIONS).filter((card) => card.permission?.startsWith('ai_' + 'settings:'));
    expect(retired).toEqual([]);
    expect(KNOWN.has('ai_' + 'settings:read')).toBe(false);
  });
});
