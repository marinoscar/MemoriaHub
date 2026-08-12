# API Documentation

> Epic [#414](https://github.com/marinoscar/MemoriaHub/issues/414). Implemented in
> `apps/api/src/openapi/`.

The interactive API reference at `/api/docs` and the OpenAPI document at
`/api/openapi.json`: how they are built, which decisions are load-bearing, and
what stops them rotting.

---

## 1. What was wrong

`/api/docs` shipped as the scaffold left it. The document was titled
**"Enterprise App API"** at a hardcoded version `1.0`, rendered by an
unconfigured stock Swagger UI over roughly 65 tags in no order, with three
admin-tag naming conventions coexisting (`Admin - X`, `Admin — X`, `Admin: X`)
so the sidebar read as three unrelated families. There was no way to obtain a
token from the page: Google OAuth is a browser redirect Swagger UI cannot drive,
and the PAT and device flows existed but were undocumented as auth options.

Two problems were less visible and more damaging:

- **Fifteen controllers called `@ApiBearerAuth()` with no scheme name**, which
  emits `security: [{ bearer: [] }]` against a scheme the document never
  defined. Not cosmetic: an undefined scheme gives the Authorize dialog nothing
  to attach, so a reader who had authorized still got `401` from every one of
  those operations.
- **Almost every documented response shape was wrong.** `TransformInterceptor`
  is a global `APP_INTERCEPTOR` that wraps every handler return value in
  `{ data, meta }`, while `@ApiResponse({ type: Dto })` describes what the
  handler returns — so the published schema was consistently one level off from
  the wire.

---

## 2. Shape of the solution

Everything that shapes the document lives in `apps/api/src/openapi/`, not in
`main.ts`. The reason is concrete: the spec is now asserted by tests and dumped
by a CI script, and neither can boot a listening server. A pure
`buildOpenApiConfig()` / `createOpenApiDocument(app)` pair is callable from the
test harness, from `scripts/dump-openapi.ts`, and from `main.ts` alike — so the
document CI lints is the document users get.

| File | Responsibility |
| --- | --- |
| `document.ts` | `DocumentBuilder` config, security schemes, operation ids, and the pass pipeline |
| `description.ts` | The Markdown getting-started guide baked into `info.description` |
| `tags.ts` | Every tag name, its description, and its `x-tagGroups` section |
| `rbac-docs.ts` | Renders the `x-rbac` extension into operation descriptions |
| `data-envelope.ts` | Applies the `{ data: … }` wrapper the global interceptor produces |
| `nullable.ts` | Rewrites 3.0 `nullable` into 3.1 type unions |
| `docs-page.ts` | The Scalar page, including one-click session pre-authorization |
| `version.ts` | Resolves the application version |
| `types.ts` | Structural types and the shared operation walker |

`createOpenApiDocument` runs Nest's introspection, then `cleanupOpenApiDoc`
(nestjs-zod's recommended post-processing, so zod DTOs emit real JSON Schema),
then five passes in a fixed order.

---

## 3. Self-documenting RBAC

`@Auth()` already knows the roles and permissions it is about to enforce. It now
records them as an `x-rbac` vendor extension, and `applyRbacDocs` renders that
into the operation description:

> **Requires:** authentication, plus system role `admin`, permission
> `media:write` and per-circle role `collaborator` or higher.

**Why metadata plus a later pass, rather than writing the description in the
decorator.** Decorators evaluate bottom-up and `@nestjs/swagger` merges
operation metadata shallowly. A decorator that set `description` directly would
race the controller's own `@ApiOperation({ description })`, and whichever ran
last would silently clobber the other. Post-processing appends, so hand-written
prose and generated requirements coexist. The pass is idempotent: an operation
whose description already carries the marker is skipped.

**Per-circle roles are declared, not inferred.** There is no per-circle guard to
read — membership is checked inside the services — so `@Auth({ circleRole })`
exists to state it where a route enforces one. It is opt-in per route rather
than derived, which is the honest position: the decorator cannot know.

A handful of routes (chiefly on the auth controller) compose
`@UseGuards(JwtAuthGuard)` with a bare `@ApiBearerAuth('JWT-auth')` instead of
`@Auth()`, because the RBAC guards would have nothing to check. Those declare a
security requirement and nothing more, and get the authentication-only line.

---

## 4. The `{ data: … }` envelope

The audit found the drift was structural rather than a handful of endpoints, so
the fix is structural too: `applyDataEnvelope` performs on the document exactly
the transformation `TransformInterceptor` performs on the response.

A handler documented as returning `Dto` is published as `{ data: Dto }`. A
handler that already returns `{ data: Dto }` is published unchanged — mirroring
the interceptor's own passthrough rule, which skips any object already carrying
a `data` key.

Deliberately untouched:

- **Non-2xx responses.** `HttpExceptionFilter` writes errors straight to the
  reply, bypassing every interceptor, so they are not enveloped.
- **Responses with no `application/json` schema** — `204`, redirects, and the
  byte-proxy / SSE / CSV-export routes that take `@Res()` and write the reply
  themselves. None declares a JSON schema, so filtering on that is exactly the
  right rule and needs no allowlist to maintain.
- **Schemas that already declare `data`**, resolved one level through `$ref` —
  double-wrapping one would publish `{ data: { data: … } }`.

Editing ~70 controllers instead would have been a large, error-prone sweep that
the next new endpoint immediately reopens. `ApiDataResponse(Dto)` exists for
declaring the envelope explicitly where that reads better, but the pass is what
makes the whole surface correct.

---

## 5. OpenAPI 3.1, and the `nullable` trap it opens

The document is published as **3.1**, not the 3.0 default: zod v4 emits JSON
Schema 2020-12, which 3.1 adopts wholesale and 3.0 rejects. Under 3.0 the
zod-derived DTOs published numeric `exclusiveMinimum` and `propertyNames`
keywords that are invalid there.

Switching versions leaves one gap. `@ApiProperty({ nullable: true })` emits the
3.0 spelling — a sibling `nullable: true` next to `type` — and 3.1 removed that
keyword. A 3.1 consumer does not "mostly ignore" it: it reads `type: "string"`
and generates a non-nullable field, wrong about exactly the values most likely
to break a client.

`applyNullableFor31` rewrites every occurrence into 3.1's spelling,
`type: ["string", "null"]`, and a nullable `$ref` into a `oneOf` (the only form
3.1 honours, since a `$ref` sibling keyword is ignored in 3.0 and merged in
3.1 — neither dependable). It walks the whole document rather than being fixed
at each `@ApiProperty` call site, because the next one written will use the 3.0
spelling too: that is what the decorator's own types document.

---

## 6. The reference page

`/api/docs` serves a [Scalar](https://scalar.com) reference: sectioned
searchable sidebar, built-in request client, generated code samples, dark mode,
native OpenAPI 3.1. `/api/openapi.json` remains the canonical machine-readable
document; the page fetches it rather than inlining it, so the HTML stays small.

Both are registered as raw Fastify routes rather than through
`SwaggerModule.setup`, which would additionally mount the stock Swagger UI on
the same path. Registering directly also keeps them outside the Nest guard
pipeline — matching what `SwaggerModule.setup` already did, and keeping the
reference readable during maintenance mode.

### 6.1 One-click session auth

Landing on `/api/docs` while signed in leaves the client already authorized. The
page `POST`s to `/api/auth/refresh` with `credentials: 'include'`, and hands the
returned access token to Scalar as pre-authorization before mounting it. A
reload re-runs it, which is what makes authorization survive one.

Two constraints shaped this:

- **It cannot be done server-side.** The refresh cookie is scoped to
  `path=/api/auth` and is therefore never sent to `/api/docs`. The exchange has
  to happen in the browser.
- **It cannot be done after mount.** Handing Scalar a token as configuration is
  clean; poking it into Scalar's internal store afterwards is not. So the fetch
  must complete *before* `createApiReference` is called — which is precisely the
  seam `@scalar/nestjs-api-reference`'s fixed template does not expose, since its
  last statement is that call. Hence a small template of our own rather than
  string-surgery on generated HTML.

### 6.2 Which schemes an operation offers

`@Auth()` can only name the session scheme. But a PAT authenticates every
authenticated route, and a `nod_` credential authenticates `/api/nodes/*` —
both facts a reader needs. `applyAlternativeAuthSchemes` derives them from the
path and the guard marker, so the claim stays accurate as routes are added,
where a hand-applied `@ApiSecurity()` would quietly go stale. Multiple entries
in `security` are alternatives, so appending never tightens a requirement.

### 6.3 The CDN

The Scalar bundle loads from a CDN, matching Scalar's own default. For a
self-hosted product that is a real constraint, so `API_DOCS_CDN` points the page
at a self-hosted copy; the page is otherwise unchanged.

---

## 7. Quality gates

**Tag taxonomy.** `tags.ts` is the single declaration of every tag. Two rules
are asserted rather than reviewed: one admin-tag convention (`Admin: X`), and no
undeclared or orphaned tags — a tag a controller uses but nobody declares
renders undescribed and ungrouped, and a tag nobody uses renders an empty
section. Tags no operation uses are pruned from `tags` and `x-tagGroups`, which
is what lets one static taxonomy be correct in both environments: the
`Test Authentication` module is registered only outside production.

**Operation ids.** `buildOperationId` produces `media_listMedia` rather than
Nest's default `MediaController_listMedia` — the controller stays a namespace,
so two `list` handlers cannot collide, without the noise a generator would bake
into every SDK method name. Uniqueness is asserted.

**Tests.** `test/openapi/openapi-document.spec.ts` boots the real `AppModule`
and asserts the finished document; `src/openapi/*.spec.ts` cover the pure passes.

**CI.** `scripts/dump-openapi.ts` writes the document to a file, booting the app
in Nest's **preview mode** — every module loaded and every controller's metadata
read, no provider instantiated — so it runs on a bare checkout with no database,
no credentials, and no cron or worker loops started. `NODE_ENV` is forced to
production so the dumped spec is the one a deployment publishes.

The `openapi` CI job generates the spec, lints it with Spectral (errors fail the
build; the ruleset in `.spectral.yaml` records a reason for every override), and
on a pull request posts a diff against the base branch into the job summary. The
diff is best-effort by construction — it borrows the checkout's `node_modules`
for the base worktree, which dependency drift can invalidate — and never fails a
PR over information.

Locally:

```bash
npm run openapi:dump    # writes ./openapi.json
npm run openapi:lint    # Spectral
```

---

## 8. Out of scope

- Generating and publishing client SDKs. Stable operation ids and a valid 3.1
  document make it possible; it is tracked separately.
- A hosted developer portal. The reference stays same-origin at `/api/docs`.
- Behavioral changes to any endpoint, auth flow, or permission. The only
  additive runtime behavior is the docs page's token helper.
- Converting the remaining class-based `@ApiProperty` DTOs to zod. Converge
  opportunistically, not as a sweep.
