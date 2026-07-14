// =============================================================================
// Email Layout — responsive, inline-CSS, table-based HTML shell
// =============================================================================
//
// System-generated rich HTML (no template engine, no external assets/images).
// Uses inline styles + nested tables so it renders consistently across email
// clients (Gmail, Outlook, Apple Mail). Dark-mode-friendly neutral palette.
// =============================================================================

const APP_NAME = 'MemoriaHub';
const BRAND_COLOR = '#4f46e5'; // indigo
const BG_COLOR = '#f4f5f7';
const CARD_COLOR = '#ffffff';
const TEXT_COLOR = '#1f2937';
const MUTED_COLOR = '#6b7280';
const BORDER_COLOR = '#e5e7eb';

/** HTML-escape a string for safe interpolation into email HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderLayoutOptions {
  /** Heading shown at the top of the body card. */
  title: string;
  /** Hidden preheader text shown in inbox previews. */
  previewText?: string;
  /** Pre-built, escaped body HTML (paragraphs etc.). */
  bodyHtml: string;
  /** Optional call-to-action button label. */
  ctaLabel?: string;
  /** Optional call-to-action button URL. */
  ctaUrl?: string;
}

/**
 * Render the full HTML document for an email given its inner body content.
 */
export function renderLayout(opts: RenderLayoutOptions): string {
  const { title, previewText, bodyHtml, ctaLabel, ctaUrl } = opts;

  const preheader = previewText
    ? `<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${escapeHtml(
        previewText,
      )}</span>`
    : '';

  const ctaBlock =
    ctaLabel && ctaUrl
      ? `
      <tr>
        <td align="center" style="padding: 8px 0 24px 0;">
          <a href="${escapeHtml(ctaUrl)}"
             style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;line-height:20px;padding:12px 28px;border-radius:8px;font-family:Arial,Helvetica,sans-serif;">
            ${escapeHtml(ctaLabel)}
          </a>
        </td>
      </tr>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BG_COLOR};">
  ${preheader}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG_COLOR};padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
          <!-- Header -->
          <tr>
            <td align="center" style="padding: 0 0 20px 0;">
              <span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:800;letter-spacing:-0.3px;color:${BRAND_COLOR};">
                📸 ${escapeHtml(APP_NAME)}
              </span>
            </td>
          </tr>
          <!-- Body card -->
          <tr>
            <td style="background:${CARD_COLOR};border:1px solid ${BORDER_COLOR};border-radius:12px;padding:32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;color:${TEXT_COLOR};padding:0 0 16px 0;">
                    ${escapeHtml(title)}
                  </td>
                </tr>
                <tr>
                  <td style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:${TEXT_COLOR};">
                    ${bodyHtml}
                  </td>
                </tr>
                ${ctaBlock}
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="center" style="padding: 20px 12px 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${MUTED_COLOR};">
              You received this email from ${escapeHtml(APP_NAME)}.<br>
              If you weren't expecting it, you can safely ignore this message.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Build a plain-text fallback body from a title, an array of paragraph lines,
 * and an optional CTA. Kept deliberately simple.
 */
export function plainText(opts: {
  title: string;
  lines: string[];
  ctaLabel?: string;
  ctaUrl?: string;
}): string {
  const parts: string[] = [APP_NAME, '', opts.title, ''];
  parts.push(...opts.lines);
  if (opts.ctaLabel && opts.ctaUrl) {
    parts.push('', `${opts.ctaLabel}: ${opts.ctaUrl}`);
  }
  parts.push('', `— ${APP_NAME}`);
  return parts.join('\n');
}
