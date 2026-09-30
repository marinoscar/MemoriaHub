/**
 * Is this string safe to hand to a navigation as an in-app destination?
 *
 * Issue #482, epic #481. Used by the service worker's `notificationclick`
 * handler (`src/sw.ts`), which feeds a push payload's `link` straight into
 * `clients.openWindow()` — a real navigation. The API is expected to write
 * only root-relative links, but a worker that trusts that on faith turns any
 * row written by an older build, seeded by hand, or restored from an old
 * backup into an open redirect.
 *
 * ACCEPTS: exactly root-relative paths — `/duplicates`, `/admin/settings/jobs?status=failed`.
 * REJECTS: everything else, including `//host` (protocol-relative — a browser
 * reads it as "same scheme, ANY host"), `https://…`, `javascript:…`, and bare
 * relative paths like `settings`, which resolve differently per current route.
 */
export function isInternalLink(link: unknown): link is string {
  if (typeof link !== 'string' || link === '') return false;
  // A protocol-relative URL also starts with a single `/`, so checking only
  // the leading slash would let `//evil.example` through.
  return link.startsWith('/') && !link.startsWith('//') && !link.startsWith('/\\');
}
