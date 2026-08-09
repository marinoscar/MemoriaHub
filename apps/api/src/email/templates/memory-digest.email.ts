// =============================================================================
// Memory Digest Email (epic #300, issue #311)
// =============================================================================
//
// "Your memories from {circle}" — the one email in this app whose job is to be
// beautiful rather than merely correct. It has to survive Gmail (web + app),
// Apple Mail, and Outlook, and OUTLOOK IS THE BINDING CONSTRAINT: Outlook for
// Windows renders through the Word HTML engine, which has no flexbox, no grid,
// no `max-width` on a `div`, no reliable `background-image`, and no
// `border-radius`. Everything below follows from that:
//
//   - TABLES FOR LAYOUT, never divs. Nested `<table role="presentation">` with
//     explicit pixel widths is the only structure all three engines agree on.
//   - INLINE STYLES on every element. Gmail strips `<head><style>` for
//     everything except media queries, so any style that must apply is inline;
//     the `<style>` block carries ONLY the mobile stacking rules, which are a
//     progressive enhancement (their absence leaves the desktop two-column
//     layout, which is legible on a phone at 600px anyway).
//   - NO WEB FONTS. A system font stack — Outlook would fall back mid-render.
//   - NO JAVASCRIPT, NO SVG, NO EXTERNAL CSS. All stripped or blocked.
//   - EVERY `<img>` CARRIES width, height AND alt. Fixed dimensions stop the
//     layout collapsing while images load, and alt text is what most Outlook
//     users actually see, since remote images are blocked by default there.
//   - BULLETPROOF BUTTONS: a padded `<td>` with a background colour wrapping an
//     `<a>`, not a styled anchor. A styled anchor loses its background in
//     Outlook and becomes invisible text.
//   - GRADIENTS DEGRADE. The golden-hour header band sets a solid
//     `background-color` FIRST and the `linear-gradient` second, so Outlook
//     shows the solid warm tone rather than a white void.
//   - `border-radius` is used freely and is simply ignored by Outlook — squared
//     corners are an accepted, documented degradation.
//
// LIGHT MODE ONLY. `prefers-color-scheme` handling in email is a minefield
// (Outlook.com and Gmail both rewrite colours in dark mode in ways that fight
// any author-side scheme), so this design commits to one look. Known
// limitation, documented in docs/specs/memories.md §7.
//
// REUSE. `escapeHtml` and `plainText` come from `layout.ts`. `renderLayout`
// deliberately does NOT: it renders a single centred body card with one heading
// and one CTA, which cannot express a full-bleed hero image, a gradient band, a
// two-column card grid, or a footer that must carry an unsubscribe link.
// Bending it into that shape would have meant reworking the shell that the two
// existing transactional emails depend on.
// =============================================================================

import { escapeHtml, plainText } from './layout';
import {
  MemoryDigestEmailData,
  MemoryDigestItemData,
  RenderedEmail,
} from '../types/email.types';

const APP_NAME = 'MemoriaHub';

// --- Palette ----------------------------------------------------------------
// "Golden hour": a warm band at the top, a calm neutral page beneath it.
const GRADIENT_FROM = '#f6d365';
const GRADIENT_TO = '#fda085';
/** Solid fallback painted under the gradient for Outlook / Word. */
const GRADIENT_FALLBACK = '#fbb975';
const PAGE_BG = '#f4f5f7';
const CARD_BG = '#ffffff';
const TEXT = '#1f2937';
const MUTED = '#6b7280';
const FAINT = '#9ca3af';
const BORDER = '#e5e7eb';
const CTA_BG = '#4f46e5';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Email body width. 600px is the widest every major client renders un-scaled. */
const WIDTH = 600;
const HERO_W = 600;
const HERO_H = 338; // 16:9
const CARD_W = 268;
const CARD_H = 151; // 16:9

/**
 * Per-type chip colours. Falls back to the neutral pair for a type this build
 * does not know — a newer API can add a `MemoryType` without breaking the mail.
 */
const CHIP_COLORS: Record<string, { bg: string; fg: string }> = {
  on_this_day: { bg: '#fef3c7', fg: '#92400e' },
  trip: { bg: '#dbeafe', fg: '#1e40af' },
  person_highlights: { bg: '#fce7f3', fg: '#9d174d' },
  person_over_years: { bg: '#fce7f3', fg: '#9d174d' },
  theme: { bg: '#ede9fe', fg: '#5b21b6' },
  seasonal: { bg: '#d1fae5', fg: '#065f46' },
  year_in_review: { bg: '#e0e7ff', fg: '#3730a3' },
};
const CHIP_FALLBACK = { bg: '#f3f4f6', fg: '#374151' };

// -----------------------------------------------------------------------------
// Fragments
// -----------------------------------------------------------------------------

function chip(item: MemoryDigestItemData, fontSize: number): string {
  const c = CHIP_COLORS[item.type] ?? CHIP_FALLBACK;
  // A padded table cell, not a styled span: Outlook drops padding on inline
  // elements, which would collapse the pill into plain coloured text.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
    <tr><td style="background:${c.bg};border-radius:999px;padding:4px 10px;font-family:${FONT};font-size:${fontSize}px;line-height:${
      fontSize + 2
    }px;font-weight:700;color:${c.fg};letter-spacing:0.02em;text-transform:uppercase;">${escapeHtml(
      item.typeLabel,
    )}</td></tr>
  </table>`;
}

/**
 * A cover image, or a warm placeholder block of the same dimensions when the
 * memory has no usable cover. Keeping the placeholder the SAME size is what
 * stops a coverless memory from shuffling every card below it.
 */
function cover(item: MemoryDigestItemData, w: number, h: number, radius: number): string {
  const alt = escapeHtml(item.title);
  if (item.imageUrl) {
    return `<img src="${escapeHtml(item.imageUrl)}" width="${w}" height="${h}" alt="${alt}"
      style="display:block;width:${w}px;height:${h}px;max-width:100%;border:0;outline:none;text-decoration:none;border-radius:${radius}px;object-fit:cover;background:${BORDER};" />`;
  }
  return `<table role="presentation" width="${w}" height="${h}" cellpadding="0" cellspacing="0" border="0" style="width:${w}px;height:${h}px;background-color:${GRADIENT_FALLBACK};background-image:linear-gradient(135deg, ${GRADIENT_FROM} 0%, ${GRADIENT_TO} 100%);border-radius:${radius}px;">
    <tr><td align="center" valign="middle" style="font-family:${FONT};font-size:13px;color:#7c4a03;">${alt}</td></tr>
  </table>`;
}

/** Bulletproof CTA — a padded `<td>`, never a styled `<a>`. See the header. */
function button(label: string, url: string, opts: { small?: boolean } = {}): string {
  const pad = opts.small ? '8px 16px' : '12px 26px';
  const size = opts.small ? 13 : 15;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
    <tr><td align="center" bgcolor="${CTA_BG}" style="background:${CTA_BG};border-radius:8px;padding:${pad};">
      <a href="${escapeHtml(url)}" style="display:inline-block;font-family:${FONT};font-size:${size}px;line-height:${
        size + 5
      }px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;
}

/** The lead memory: full-bleed cover, big title, narrative, primary CTA. */
function heroBlock(item: MemoryDigestItemData): string {
  const subtitle = item.subtitle
    ? `<tr><td style="padding:6px 0 0 0;font-family:${FONT};font-size:14px;line-height:21px;color:${MUTED};">${escapeHtml(
        item.subtitle,
      )}</td></tr>`
    : '';
  // The AI narrative is hero-only: it is a paragraph, and four of them stacked
  // in the card grid below would turn a glanceable digest into an essay.
  const narrative = item.narrative
    ? `<tr><td style="padding:14px 0 0 0;font-family:${FONT};font-size:15px;line-height:24px;color:${TEXT};">${escapeHtml(
        item.narrative,
      )}</td></tr>`
    : '';

  return `<tr>
    <td style="background:${CARD_BG};border:1px solid ${BORDER};border-radius:14px;padding:0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding:0;font-size:0;line-height:0;">${cover(
          item,
          HERO_W - 2,
          HERO_H,
          14,
        )}</td></tr>
        <tr><td style="padding:22px 24px 24px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="padding:0 0 10px 0;">${chip(item, 10)}</td></tr>
            <tr><td style="font-family:${FONT};font-size:24px;line-height:31px;font-weight:700;color:${TEXT};">${escapeHtml(
              item.title,
            )}</td></tr>
            ${subtitle}
            ${narrative}
            <tr><td style="padding:12px 0 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:${FAINT};">${
              item.itemCount
            } ${item.itemCount === 1 ? 'photo' : 'photos'}</td></tr>
            <tr><td style="padding:18px 0 0 0;">${button('Relive this memory →', item.url)}</td></tr>
          </table>
        </td></tr>
      </table>
    </td>
  </tr>`;
}

/** One of the smaller cards in the two-column grid. */
function cardBlock(item: MemoryDigestItemData): string {
  const subtitle = item.subtitle
    ? `<tr><td style="padding:4px 0 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(
        item.subtitle,
      )}</td></tr>`
    : '';

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CARD_BG};border:1px solid ${BORDER};border-radius:12px;">
    <tr><td style="padding:0;font-size:0;line-height:0;">${cover(item, CARD_W - 2, CARD_H, 12)}</td></tr>
    <tr><td style="padding:14px 16px 16px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding:0 0 8px 0;">${chip(item, 9)}</td></tr>
        <tr><td style="font-family:${FONT};font-size:16px;line-height:22px;font-weight:600;color:${TEXT};">${escapeHtml(
          item.title,
        )}</td></tr>
        ${subtitle}
        <tr><td style="padding:12px 0 0 0;">${button('Relive this memory →', item.url, {
          small: true,
        })}</td></tr>
      </table>
    </td></tr>
  </table>`;
}

/**
 * The remaining memories as a two-column grid.
 *
 * Each row is one `<tr>` with two `<td class="stack">` cells. The `<style>`
 * block's media query turns those cells into full-width blocks under 480px in
 * clients that honour it; where it is ignored (Outlook desktop, some Gmail
 * paths) the layout simply stays two columns, which is the intended desktop
 * rendering anyway — so nothing depends on the query being applied.
 */
function cardGrid(items: MemoryDigestItemData[]): string {
  if (items.length === 0) return '';

  const rows: string[] = [];
  for (let i = 0; i < items.length; i += 2) {
    const left = items[i]!;
    const right = items[i + 1];
    rows.push(`<tr>
      <td class="stack" width="${CARD_W}" valign="top" style="width:${CARD_W}px;padding:0 0 16px 0;">${cardBlock(
        left,
      )}</td>
      <td class="gutter" width="24" style="width:24px;font-size:0;line-height:0;">&nbsp;</td>
      <td class="stack" width="${CARD_W}" valign="top" style="width:${CARD_W}px;padding:0 0 16px 0;">${
        right ? cardBlock(right) : '&nbsp;'
      }</td>
    </tr>`);
  }

  return `<tr><td style="padding:24px 0 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="padding:0 0 14px 0;font-family:${FONT};font-size:13px;line-height:18px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};">More to relive</td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${rows.join('\n')}
    </table>
  </td></tr>`;
}

// -----------------------------------------------------------------------------
// Subject line
// -----------------------------------------------------------------------------

/**
 * Subject. A today-anchored `on_this_day` memory leads with its own title —
 * it is the most emotionally specific thing in the mail and the strongest
 * reason to open it — otherwise a plain count.
 */
export function memoryDigestSubject(data: MemoryDigestEmailData): string {
  const anchored = data.memories.find((m) => m.type === 'on_this_day');
  const count = data.memories.length;
  if (anchored) {
    const rest = count - 1;
    return rest > 0
      ? `On this day: ${anchored.title} — and ${rest} more ${rest === 1 ? 'memory' : 'memories'}`
      : `On this day: ${anchored.title}`;
  }
  return `${count} new ${count === 1 ? 'memory' : 'memories'} from ${data.circleName}`;
}

// -----------------------------------------------------------------------------
// Template
// -----------------------------------------------------------------------------

export function memoryDigestEmail(data: MemoryDigestEmailData): RenderedEmail {
  const subject = memoryDigestSubject(data);
  const [hero, ...rest] = data.memories;
  const secondary = rest.slice(0, 4);

  const greeting = data.recipientName
    ? `${escapeHtml(data.recipientName)}, here's what ${escapeHtml(data.circleName)} has been reliving.`
    : `Here's what ${escapeHtml(data.circleName)} has been reliving.`;

  const preheader = `Your memories from ${data.circleName}`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${escapeHtml(subject)}</title>
  <!--
    The ONLY rules in this block are the mobile stacking media query. Gmail
    strips everything else from <head>, so nothing here may be load-bearing —
    without it the grid stays two-column, which is the desktop design anyway.
  -->
  <style>
    @media only screen and (max-width: 480px) {
      .stack { display: block !important; width: 100% !important; max-width: 100% !important; }
      .gutter { display: none !important; }
      .shell { width: 100% !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};-webkit-font-smoothing:antialiased;">
  <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(
    preheader,
  )}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" class="shell" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:${WIDTH}px;max-width:${WIDTH}px;">

        <!-- Golden-hour header band. Solid bgcolor FIRST so Outlook, which
             ignores the gradient, still shows a warm band rather than white. -->
        <tr>
          <td align="center" bgcolor="${GRADIENT_FALLBACK}" style="background-color:${GRADIENT_FALLBACK};background-image:linear-gradient(135deg, ${GRADIENT_FROM} 0%, ${GRADIENT_TO} 100%);border-radius:14px;padding:26px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td align="center" style="font-family:${FONT};font-size:22px;line-height:28px;font-weight:800;letter-spacing:-0.3px;color:#5b3608;">📸 ${escapeHtml(
                APP_NAME,
              )}</td></tr>
              <tr><td align="center" style="padding:6px 0 0 0;font-family:${FONT};font-size:14px;line-height:21px;color:#7c4a03;">Your memories from ${escapeHtml(
                data.circleName,
              )}</td></tr>
            </table>
          </td>
        </tr>

        <tr><td style="padding:22px 4px 18px 4px;font-family:${FONT};font-size:15px;line-height:23px;color:${TEXT};">${greeting}</td></tr>

        ${hero ? heroBlock(hero) : ''}
        ${cardGrid(secondary)}

        <tr><td align="center" style="padding:28px 0 0 0;">${button(
          'See all memories',
          data.memoriesUrl,
        )}</td></tr>

        <!-- Footer -->
        <tr>
          <td align="center" style="padding:26px 16px 0 16px;font-family:${FONT};font-size:11px;line-height:18px;color:${FAINT};">
            You're receiving this because you're a member of ${escapeHtml(
              data.circleName,
            )} on ${escapeHtml(APP_NAME)}.<br>
            <a href="${escapeHtml(
              data.unsubscribeUrl,
            )}" style="color:${FAINT};text-decoration:underline;">Unsubscribe from memory digests</a>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:12px 16px 0 16px;font-family:${FONT};font-size:11px;line-height:18px;color:${FAINT};">
            Curated for you by ${escapeHtml(APP_NAME)}
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // Plaintext alternative. Required for spam-score hygiene (a multipart mail
  // with an empty text part scores worse than one with none), and it is the
  // only thing a screen reader in text mode or a terminal client ever sees.
  const lines: string[] = [greeting.replace(/<[^>]*>/g, ''), ''];
  for (const memory of data.memories) {
    lines.push(`• ${memory.typeLabel}: ${memory.title}`);
    if (memory.subtitle) lines.push(`  ${memory.subtitle}`);
    lines.push(`  ${memory.url}`);
    lines.push('');
  }
  lines.push(`All memories: ${data.memoriesUrl}`);
  lines.push('');
  lines.push(`Unsubscribe from memory digests: ${data.unsubscribeUrl}`);

  const text = plainText({
    title: `Your memories from ${data.circleName}`,
    lines,
  });

  return {
    subject,
    html,
    text,
    headers: {
      // RFC 2369 + RFC 8058. The URL is per-recipient (the token embeds the
      // user id), which is exactly why headers are a per-message property
      // rather than provider configuration. `One-Click` promises the mail
      // client that a bare POST to that URL unsubscribes with no further
      // interaction — which the POST route honours.
      'List-Unsubscribe': `<${data.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
