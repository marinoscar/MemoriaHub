// =============================================================================
// Shared Fastify server setup
// =============================================================================
//
// The HTTP-layer configuration that BOTH `main.ts` and the integration test
// harness (`test/helpers/test-app.helper.ts`) must apply, in one place.
//
// It exists because of a bug the split between those two files hid perfectly:
// Fastify's default `maxParamLength` is **100 characters**, and a route
// parameter longer than that is rejected with `414 URI Too Long` before the
// handler is ever entered. Every digest capability token (epic #300, issue
// #311) is comfortably longer than 100 characters — a base64url JSON payload
// plus a base64url SHA-256 signature — so with the default in place EVERY cover
// image and EVERY unsubscribe link in a delivered email is dead, and no
// controller unit test can see it, because a unit test calls the method
// directly and never crosses the router.
//
// Keeping the value here rather than inline in `main.ts` is the point: an
// integration test that boots its own adapter with different options is not
// testing the server the users get.
// =============================================================================


/**
 * Maximum length of a single route parameter.
 *
 * Sized for the digest tokens (§7.7 of docs/specs/memories.md), with headroom:
 * the longest today is the unsubscribe token at roughly 150 characters, and a
 * future payload addition must not silently re-break the same links. Kept
 * bounded rather than raised arbitrarily — this is a router-level input limit,
 * and the routes that need it accept exactly one signed blob.
 *
 * `verify()` in digest-token.util.ts independently rejects anything over 4096
 * characters, so this is a first bound, not the only one.
 */
export const MAX_ROUTE_PARAM_LENGTH = 512;

/**
 * Options every FastifyAdapter in this app must be constructed with.
 *
 * `maxParamLength` is set BOTH at the top level and under `routerOptions`:
 * Fastify 5 moved router settings into `routerOptions` (FSTDEP022 deprecates
 * reading the flat form, removed in Fastify 6), while the installed
 * `@nestjs/platform-fastify` still forwards the flat one. Setting both means
 * the limit survives whichever of the two moves first.
 */
export function fastifyAdapterOptions(extra: Record<string, unknown> = {}) {
  return {
    maxParamLength: MAX_ROUTE_PARAM_LENGTH,
    routerOptions: { maxParamLength: MAX_ROUTE_PARAM_LENGTH },
    ...extra,
  };
}

// -----------------------------------------------------------------------------
// A note on `application/x-www-form-urlencoded`, so nobody adds it back
// -----------------------------------------------------------------------------
// RFC 8058 one-click unsubscribe (issue #311) POSTs `List-Unsubscribe=One-Click`
// as `application/x-www-form-urlencoded`. Bare Fastify parses only JSON and
// `text/plain`, so it is tempting to register a parser for it here (or to pull
// in `@fastify/formbody`).
//
// DO NOT. `@nestjs/platform-fastify`'s adapter already registers both a JSON and
// a urlencoded body parser during `app.init()` (`registerParserMiddleware` →
// `registerUrlencodedContentParser`), and Fastify throws
// `Content type parser 'application/x-www-form-urlencoded' already present`
// when a second one is added — which fails application startup outright, not
// just the one route. The integration spec `memory-digest-public.integration`
// covers the one-click POST end to end, so a regression here surfaces as a test
// failure rather than a dead unsubscribe button.
