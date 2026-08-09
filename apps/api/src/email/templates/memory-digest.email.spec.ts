/**
 * Rendering tests for the memory digest email (epic #300, issue #311).
 *
 * Two things are asserted here that a human eyeballing a screenshot would not
 * reliably catch:
 *
 *   1. THE EMAIL-CLIENT CONSTRAINTS ACTUALLY HOLD. Outlook for Windows renders
 *      through the Word HTML engine — no flexbox, no grid, no <head> styles
 *      that matter, no reliable background-image — so the layout must be tables
 *      with inline styles. A future edit that reaches for `display:flex`
 *      because it looks fine in Gmail would ship a broken email to every
 *      Outlook user, and nothing else in the pipeline would notice.
 *   2. THE UNSUBSCRIBE CONTRACT IS INTACT. The RFC 2369 / RFC 8058 header pair
 *      is what makes a mail client's own unsubscribe button work; losing it
 *      silently degrades deliverability rather than failing loudly.
 *
 * Pure rendering — no network, no email, no database.
 */

import { memoryDigestEmail, memoryDigestSubject } from './memory-digest.email';
import { MemoryDigestEmailData, MemoryDigestItemData } from '../types/email.types';

function item(overrides: Partial<MemoryDigestItemData> = {}): MemoryDigestItemData {
  return {
    id: 'm1',
    type: 'trip',
    typeLabel: 'Trip',
    title: 'Trip to Guanacaste',
    subtitle: 'March 2023',
    narrative: null,
    itemCount: 24,
    imageUrl: 'https://app.test/api/public/memories/digest-image/tok',
    url: 'https://app.test/memories/m1',
    ...overrides,
  };
}

function data(overrides: Partial<MemoryDigestEmailData> = {}): MemoryDigestEmailData {
  return {
    circleName: 'Familia',
    recipientName: 'Oscar',
    memories: [item()],
    memoriesUrl: 'https://app.test/memories',
    unsubscribeUrl: 'https://app.test/api/public/memories/digest-unsubscribe/tok',
    ...overrides,
  };
}

describe('memory digest subject', () => {
  it('counts memories when nothing is anchored to today', () => {
    expect(memoryDigestSubject(data({ memories: [item(), item({ id: 'm2' })] }))).toBe(
      '2 new memories from Familia',
    );
  });

  it('is singular for one memory', () => {
    expect(memoryDigestSubject(data())).toBe('1 new memory from Familia');
  });

  it('leads with an on_this_day memory when one is present', () => {
    const subject = memoryDigestSubject(
      data({
        memories: [
          item({ id: 'a', type: 'on_this_day', title: 'Six years ago' }),
          item({ id: 'b' }),
          item({ id: 'c' }),
        ],
      }),
    );
    expect(subject).toBe('On this day: Six years ago — and 2 more memories');
  });

  it('drops the "and N more" tail when the anchor is the only memory', () => {
    expect(
      memoryDigestSubject(
        data({ memories: [item({ type: 'on_this_day', title: 'Six years ago' })] }),
      ),
    ).toBe('On this day: Six years ago');
  });
});

describe('memory digest email', () => {
  it('renders a subject, an HTML part and a plaintext part', () => {
    const rendered = memoryDigestEmail(data());

    expect(rendered.subject).toBeTruthy();
    expect(rendered.html).toContain('<!doctype html>');
    // A multipart mail with an empty text part scores worse for spam than one
    // with none, and the text part is all a terminal client ever sees.
    expect(rendered.text.length).toBeGreaterThan(0);
    expect(rendered.text).toContain('Trip to Guanacaste');
    expect(rendered.text).toContain('https://app.test/memories/m1');
    expect(rendered.text).toContain('Unsubscribe');
  });

  // -------------------------------------------------------------------------
  // Email-client constraints
  // -------------------------------------------------------------------------

  describe('renders within the Outlook/Word constraints', () => {
    const html = memoryDigestEmail(
      data({ memories: [item(), item({ id: 'm2' }), item({ id: 'm3' })] }),
    ).html;

    it('uses no flexbox and no grid anywhere', () => {
      expect(html).not.toMatch(/display\s*:\s*flex/i);
      expect(html).not.toMatch(/display\s*:\s*(inline-)?grid/i);
      expect(html).not.toMatch(/grid-template/i);
    });

    it('lays out with presentation tables', () => {
      expect(html).toContain('role="presentation"');
      expect((html.match(/<table/g) ?? []).length).toBeGreaterThan(4);
    });

    it('loads no web font, no script and no external stylesheet', () => {
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/@font-face/i);
      expect(html).not.toMatch(/<link[^>]+stylesheet/i);
      expect(html).toContain('-apple-system');
    });

    it('keeps the <head> style block to the mobile stacking query only', () => {
      // Gmail strips everything else from <head>, so nothing in there may be
      // load-bearing.
      const styleBlock = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
      expect(styleBlock).toContain('@media only screen');
      expect(styleBlock.replace(/@media[\s\S]*$/, '').trim()).toBe('');
    });

    it('paints a solid colour under the gradient band', () => {
      // Outlook ignores linear-gradient; without the solid bgcolor first the
      // header would render as a white void.
      expect(html).toMatch(/bgcolor="#[0-9a-f]{6}"[^>]*background-color:#[0-9a-f]{6}/i);
    });

    it('gives every image explicit dimensions and alt text', () => {
      const imgs = html.match(/<img[^>]*>/g) ?? [];
      expect(imgs.length).toBeGreaterThan(0);
      for (const img of imgs) {
        expect(img).toMatch(/\swidth="\d+"/);
        expect(img).toMatch(/\sheight="\d+"/);
        // Remote images are blocked by default in Outlook, so alt text is what
        // most Outlook readers actually see.
        expect(img).toMatch(/\salt="[^"]+"/);
      }
    });

    it('uses bulletproof buttons — a padded cell, not a styled anchor', () => {
      expect(html).toMatch(/<td[^>]*bgcolor="#[0-9a-f]{6}"[^>]*>\s*<a /i);
    });

    it('stays within the 600px body width', () => {
      expect(html).toContain('max-width:600px');
    });

    it('carries a hidden preheader', () => {
      expect(html).toContain('Your memories from Familia');
    });
  });

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  it('renders the hero narrative but not one per card', () => {
    const html = memoryDigestEmail(
      data({
        memories: [
          item({ narrative: 'HERO NARRATIVE' }),
          item({ id: 'm2', narrative: 'CARD NARRATIVE' }),
        ],
      }),
    ).html;

    expect(html).toContain('HERO NARRATIVE');
    expect(html).not.toContain('CARD NARRATIVE');
  });

  it('renders a same-size placeholder when a memory has no cover', () => {
    const html = memoryDigestEmail(data({ memories: [item({ imageUrl: null })] })).html;

    expect(html).not.toContain('<img');
    // The placeholder keeps the hero's dimensions so a coverless memory cannot
    // shuffle everything below it.
    expect(html).toMatch(/height="338"/);
  });

  it('escapes hostile text in every interpolated field', () => {
    const html = memoryDigestEmail(
      data({
        circleName: '<script>alert(1)</script>',
        recipientName: '"><img src=x onerror=alert(1)>',
        memories: [
          item({
            title: '<b>bold</b>',
            subtitle: '<i>i</i>',
            narrative: '<u>u</u>',
            typeLabel: '<em>em</em>',
          }),
        ],
      }),
    ).html;

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<b>bold</b>');
    // The payload survives as inert TEXT (so `onerror=` is still a substring),
    // but never as a tag, and never as a quote that could break out of an
    // attribute.
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('&quot;&gt;&lt;img');
  });

  it('renders every memory it is given, hero plus cards', () => {
    const html = memoryDigestEmail(
      data({
        memories: [
          item({ id: 'a', title: 'AAA' }),
          item({ id: 'b', title: 'BBB' }),
          item({ id: 'c', title: 'CCC' }),
          item({ id: 'd', title: 'DDD' }),
          item({ id: 'e', title: 'EEE' }),
        ],
      }),
    ).html;

    for (const title of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']) {
      expect(html).toContain(title);
    }
  });

  // -------------------------------------------------------------------------
  // Unsubscribe contract
  // -------------------------------------------------------------------------

  it('sets the RFC 2369 + RFC 8058 unsubscribe headers', () => {
    const rendered = memoryDigestEmail(data());

    expect(rendered.headers?.['List-Unsubscribe']).toBe(
      '<https://app.test/api/public/memories/digest-unsubscribe/tok>',
    );
    expect(rendered.headers?.['List-Unsubscribe-Post']).toBe(
      'List-Unsubscribe=One-Click',
    );
  });

  it('also links unsubscribe visibly in the footer', () => {
    const rendered = memoryDigestEmail(data());

    expect(rendered.html).toContain(
      'https://app.test/api/public/memories/digest-unsubscribe/tok',
    );
    expect(rendered.html).toContain('Unsubscribe');
    expect(rendered.html).toContain("you're a member of Familia");
  });
});
