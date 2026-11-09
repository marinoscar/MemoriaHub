import {
  renderGroupInvitationEmail,
  type GroupInvitationNotificationData,
} from '@marinoscar/platform-api/sharing';

import {
  SafeHtml,
  TRANSACTIONAL_EMAIL_HEADERS,
  formatEmailDate,
  formatEmailDateTime,
  html,
  plainText,
  renderLayout,
  resolveEmailRenderContext,
  type EmailRenderContext,
  type RenderedEmail,
} from '@marinoscar/platform-api/email';

// =============================================================================
// "Invitation to a group" (template `group-invitation`, event `groups.invitation`; RETRO-I1, #562)
// =============================================================================
//
// The words are the sharing slice's (`renderGroupInvitationEmail` in
// `@marinoscar/platform-api/sharing`); the layout, the escaping `html` tag and
// the plain-text renderer are the email slice's, rendered with MemoriaHub's
// render context (app name, brand), so the message looks like every other one
// this app sends. User-typed text (a group name, a record title) goes through
// `html`, which escapes it, and stays out of the subject. The template name is
// permanent (it keys the email template registry and the delivery records).
// =============================================================================

/** Everything the template renders. */
export type GroupInvitationEmailData = GroupInvitationNotificationData;

/** Render `group-invitation`. */
export function groupInvitationEmail(data: GroupInvitationEmailData, ctx?: EmailRenderContext): RenderedEmail {
  const context = resolveEmailRenderContext(ctx);
  return renderGroupInvitationEmail(data, {
    appName: context.appName,
    html,
    empty: SafeHtml.EMPTY,
    renderLayout: (options) => renderLayout({ ...options, bodyHtml: options.bodyHtml as SafeHtml }, context),
    plainText: (options) => plainText(options, context),
    headers: TRANSACTIONAL_EMAIL_HEADERS,
    formatDate: (value) => formatEmailDate(value, context),
    formatDateTime: (value) => formatEmailDateTime(value, context),
  });
}
