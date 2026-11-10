// =============================================================================
// Digest Unsubscribe Pages (epic #300, issue #311)
// =============================================================================
//
// Two tiny standalone HTML documents served by PublicMemoryDigestController.
// They are deliberately NOT part of the React app: the person clicking this
// link is by definition not logged in, may be in a webmail preview pane or a
// mail client's embedded browser, and must get an answer without loading a SPA
// bundle, hitting an auth redirect, or executing any JavaScript.
//
// NO USER-SUPPLIED STRING APPEARS IN EITHER PAGE. The confirm page interpolates
// exactly one value — a token this server minted and has already verified,
// URL-encoded by the caller — into a form action, and nothing else. There is no
// name, no email address, no circle: nothing to escape, and nothing that
// confirms to a stranger holding a stale link WHO the link belongs to.
//
// The confirm page's form is the only control, and it POSTs. RFC 8058
// one-click bypasses this page entirely by POSTing straight to the same URL
// from the `List-Unsubscribe-Post` header.
// =============================================================================

const STYLE = `
  body { margin:0; padding:0; background:#f4f5f7; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1f2937; }
  .wrap { max-width:520px; margin:0 auto; padding:48px 20px; }
  .card { background:#ffffff; border:1px solid #e5e7eb; border-radius:14px; padding:32px; text-align:center; }
  h1 { margin:0 0 12px 0; font-size:20px; line-height:28px; font-weight:700; }
  p { margin:0 0 20px 0; font-size:15px; line-height:23px; color:#4b5563; }
  .muted { font-size:12px; line-height:18px; color:#9ca3af; margin:0; }
  button { appearance:none; border:0; border-radius:8px; background:#4f46e5; color:#ffffff; font-size:15px; font-weight:600; padding:12px 26px; cursor:pointer; }
`;

function page(bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>MemoriaHub — memory digests</title>
<style>${STYLE}</style>
</head>
<body><div class="wrap"><div class="card">${bodyHtml}</div></div></body>
</html>`;
}

/**
 * Step 1: ask. `token` MUST already be URL-encoded and MUST already have had
 * its signature verified by the caller.
 */
export function unsubscribeConfirmPage(encodedToken: string): string {
  return page(`
    <h1>Stop receiving memory digests?</h1>
    <p>You'll no longer get the periodic email of new memories. Everything in the app stays exactly as it is — nothing is deleted, and you can turn digests back on any time from your MemoriaHub settings.</p>
    <form method="post" action="./${encodedToken}">
      <button type="submit">Unsubscribe me</button>
    </form>
    <p class="muted" style="margin-top:20px;">If you didn't mean to open this, just close the page — nothing has changed yet.</p>
  `);
}

/**
 * The 404 body, served for EVERY failure — malformed token, bad signature,
 * wrong purpose, expired, deleted user.
 *
 * One page for all of them is what keeps the route from being an oracle: it
 * says only that the link no longer works, never why, and never whether the
 * user or resource it names exists. It is HTML rather than the API's JSON error
 * envelope because the reader is a human who just clicked a link in an email
 * client, not a client library.
 */
export function invalidLinkPage(): string {
  return page(`
    <h1>This link is no longer valid</h1>
    <p>Unsubscribe links expire after a while. Open MemoriaHub and turn off "Email me memory digests" in your settings instead.</p>
  `);
}

/** Step 2: done. Reached by the form POST and by RFC 8058 one-click alike. */
export function unsubscribeDonePage(): string {
  return page(`
    <h1>You're unsubscribed</h1>
    <p>We won't email you memory digests any more. Your memories are still waiting for you in the app.</p>
    <p class="muted">Changed your mind? Turn "Email me memory digests" back on in your MemoriaHub settings.</p>
  `);
}
