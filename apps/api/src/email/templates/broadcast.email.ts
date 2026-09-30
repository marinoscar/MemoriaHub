import { renderLayout, plainText, escapeHtml } from './layout';
import { BroadcastEmailData, RenderedEmail } from '../types/email.types';

// =============================================================================
// Admin broadcast email (epic #481, issue #488)
// =============================================================================
//
// The email channel of an administrator's announcement. The body is PLAIN
// TEXT typed by an admin: it is HTML-escaped here, never interpreted, and
// blank-line-separated blocks become paragraphs (single newlines inside a
// block are joined with a space, since email clients reflow anyway).
//
// The CTA URL is absolute — built by the caller from APP_URL plus the
// broadcast's root-relative `link` — because a mail client has no origin to
// resolve `/status` against. A template is a pure function of its input and
// reads no configuration.
// =============================================================================

const PREVIEW_TEXT_MAX_LENGTH = 140;

const CRITICAL_NOTICE =
  'This announcement was marked important by an administrator and is sent to ' +
  'everyone, regardless of notification preferences.';

/** Blank-line-separated paragraphs, each with its internal newlines collapsed. */
export function splitParagraphs(body: string): string[] {
  return body
    .split(/\r?\n\s*\r?\n/)
    .map((p) =>
      p
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(' '),
    )
    .filter((p) => p.length > 0);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function broadcastEmail(data: BroadcastEmailData): RenderedEmail {
  const paragraphs = splitParagraphs(data.body);
  const critical = data.critical === true;
  const ctaLabel = data.ctaUrl ? data.ctaLabel?.trim() || 'Open MemoriaHub' : undefined;

  const bodyHtml =
    paragraphs.map((p) => `<p style="margin:0 0 16px 0;">${escapeHtml(p)}</p>`).join('\n') +
    (critical
      ? `<p style="margin:0;font-size:13px;line-height:20px;color:#6b7280;">${escapeHtml(CRITICAL_NOTICE)}</p>`
      : '');

  const html = renderLayout({
    title: data.title,
    previewText: paragraphs[0] ? truncate(paragraphs[0], PREVIEW_TEXT_MAX_LENGTH) : undefined,
    bodyHtml,
    ctaLabel,
    ctaUrl: data.ctaUrl,
  });

  const lines = paragraphs.flatMap((p, i) => (i === 0 ? [p] : ['', p]));
  if (critical) lines.push('', CRITICAL_NOTICE);

  const text = plainText({ title: data.title, lines, ctaLabel, ctaUrl: data.ctaUrl });

  return { subject: data.title, html, text };
}
