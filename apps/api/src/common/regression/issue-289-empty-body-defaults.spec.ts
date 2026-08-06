/**
 * Schema-level regression tests for GitHub issue #289.
 *
 * THE BUG: Fastify leaves `request.body` as `undefined` for a request that
 * carries no body at all (e.g. `fetch(url, { method: 'POST' })` — no
 * Content-Type, no payload). Nest's `@Body()` hands that `undefined` straight
 * to the global `ZodValidationPipe`, and `z.object({...}).parse(undefined)`
 * throws a Zod `invalid_type` error regardless of how optional every one of
 * the object's fields is. Any endpoint whose DTO documented an empty body as
 * "use the defaults" therefore 400'd on a genuinely bodyless request.
 *
 * THE FIX (commit 3f5d88f): a top-level `.default({})` (or, where an inner
 * field carries its OWN default, `.prefault({})` — see the ReprocessFailedBodyDto
 * block below) on all 34 affected body schemas, placed LAST in the chain
 * after any `.strict()`/`.refine()`. See `app.module.ts` for the full
 * convention writeup and its two caveats.
 *
 * WHY THIS FILE EXISTS — the critical point from the issue: the pre-existing
 * `ResetStuckDto` spec (`enrichment-admin.controller.spec.ts`) never caught
 * this bug because it calls `controller.resetStuck({} as ResetStuckDto)`
 * DIRECTLY — a hand-constructed DTO that never goes near the
 * `ZodValidationPipe`, and `{}` was always valid input anyway (the crash only
 * happens on `undefined`, not `{}`). A test that constructs a DTO by hand or
 * invokes a controller method directly is WORTHLESS for this bug class. Every
 * assertion below therefore calls `schema.parse(...)` (or the `ZodDto`'s
 * static `.schema.parse(...)` — `createZodDto` attaches the real schema as a
 * static property even on DTO classes whose local schema `const` isn't
 * exported) — i.e. the exact same code path the real `ZodValidationPipe`
 * invokes. `parse(undefined)` is the assertion that would have thrown before
 * commit 3f5d88f; everything else pins that the fix did not loosen
 * validation. For a genuine end-to-end proof through the real pipe + a real
 * Fastify HTTP round trip (no `request.body` at all, not a simulated
 * `parse(undefined)` call), see `issue-289-bodyless-post.spec.ts` in this
 * same directory.
 *
 * This does not attempt all 34 fixed schemas — it picks a representative
 * spread: a plain `.default({})` case, a `.strict()` case, a `.refine()`
 * case, a nested/complex settings-patch case, and (via the pipe-level
 * companion file) the one case that additionally needed `.prefault({})`
 * because it has its own inner field default. It also pins the ONE
 * deliberate exclusion (`TriggerBackupSchema`) as a guard against a future
 * sweep "helpfully" adding `.default({})` there.
 */

import { randomUUID } from 'crypto';
import { ResetStuckDto, RetryAllFailedDto } from '../../enrichment/enrichment-admin.controller';
import { updateWorkflowSchema, UpdateWorkflowDto } from '../../workflows/dto/update-workflow.dto';
import { updatePersonSchema, UpdatePersonDto } from '../../face/dto/people.dto';
import { ReprocessFailedBodyDto } from '../../media/media-reprocess.controller';
import { patchUserSettingsSchema, PatchUserSettingsDto } from '../../settings/dto/update-user-settings.dto';
import { AcceptLocationSuggestionDto } from '../../location-inference/dto/accept-location-suggestion.dto';
import { TriggerBackupSchema } from '../../jobs/backup/dto/trigger-backup.dto';

describe('issue #289 — top-level .default({}) contract on all-optional Zod body schemas', () => {
  // ===========================================================================
  // ResetStuckDto — the DTO named explicitly in the issue.
  // POST /api/admin/jobs/reset-stuck body { olderThanMinutes? }
  // `resetStuckSchema` itself is not exported from enrichment-admin.controller.ts,
  // so we reach it via the ZodDto's static `.schema` — createZodDto attaches the
  // real schema instance there regardless of whether the local const is exported.
  // ===========================================================================
  describe('ResetStuckDto (apps/api/src/enrichment/enrichment-admin.controller.ts)', () => {
    const schema = ResetStuckDto.schema;

    it('parse(undefined) -> {} — THE #289 REGRESSION ASSERTION: this threw ZodError before commit 3f5d88f', () => {
      expect(schema.parse(undefined)).toEqual({});
    });

    it('parse({}) -> {} (unchanged pre-existing behavior)', () => {
      expect(schema.parse({})).toEqual({});
    });

    it('a valid populated body round-trips', () => {
      expect(schema.parse({ olderThanMinutes: 15 })).toEqual({ olderThanMinutes: 15 });
    });

    it('an invalid field value still throws — the fix must not have loosened validation', () => {
      expect(() => schema.parse({ olderThanMinutes: 0 })).toThrow();
      expect(() => schema.parse({ olderThanMinutes: -5 })).toThrow();
      expect(() => schema.parse({ olderThanMinutes: 15.5 })).toThrow();
      expect(() => schema.parse({ olderThanMinutes: 'soon' })).toThrow();
    });
  });

  // ===========================================================================
  // RetryAllFailedDto — ResetStuckDto's sibling in the same controller/commit hunk.
  // POST /api/admin/jobs/retry-failed body { type? }
  // ===========================================================================
  describe('RetryAllFailedDto (apps/api/src/enrichment/enrichment-admin.controller.ts)', () => {
    const schema = RetryAllFailedDto.schema;

    it('parse(undefined) -> {} — would have thrown before commit 3f5d88f', () => {
      expect(schema.parse(undefined)).toEqual({});
    });

    it('parse({}) -> {} (unchanged)', () => {
      expect(schema.parse({})).toEqual({});
    });

    it('a valid populated body round-trips', () => {
      expect(schema.parse({ type: 'auto_tagging' })).toEqual({ type: 'auto_tagging' });
    });

    it('an invalid field value still throws', () => {
      expect(() => schema.parse({ type: '' })).toThrow(); // min(1)
      expect(() => schema.parse({ type: 123 })).toThrow(); // wrong type
    });
  });

  // ===========================================================================
  // UpdateWorkflowDto — the .strict() case. `.default({})` is placed LAST,
  // after `.strict()`, so a bodyless request still parses as {} while an
  // unknown key on a REAL body still throws.
  // ===========================================================================
  describe('UpdateWorkflowDto (apps/api/src/workflows/dto/update-workflow.dto.ts) — .strict() case', () => {
    it('parse(undefined) -> {} — would have thrown before commit 3f5d88f', () => {
      expect(updateWorkflowSchema.parse(undefined)).toEqual({});
    });

    it('parse({}) -> {} (unchanged)', () => {
      expect(updateWorkflowSchema.parse({})).toEqual({});
    });

    it('a valid populated body round-trips', () => {
      const result = updateWorkflowSchema.parse({ name: 'Archive old screenshots', enabled: true });
      expect(result).toEqual({ name: 'Archive old screenshots', enabled: true });
    });

    it('an invalid field value still throws', () => {
      expect(() => updateWorkflowSchema.parse({ enabled: 'yes' })).toThrow();
      expect(() => updateWorkflowSchema.parse({ trigger: 'on_full_moon' })).toThrow();
    });

    it('an unknown key still throws — .strict() survives the added .default({})', () => {
      expect(() => updateWorkflowSchema.parse({ notARealField: 'x' })).toThrow();
    });

    it('UpdateWorkflowDto.schema is the same schema instance exercised above', () => {
      expect(UpdateWorkflowDto.schema).toBe(updateWorkflowSchema);
    });
  });

  // ===========================================================================
  // UpdatePersonDto — the .refine() case. `.default({})` is placed LAST, after
  // `.refine()`, so the refine is skipped ONLY for the literal {} default value
  // (harmless here — both fields absent trivially satisfies the refine) but
  // still runs, and still rejects, any REAL populated body that violates it.
  // ===========================================================================
  describe('UpdatePersonDto (apps/api/src/face/dto/people.dto.ts) — .refine() case', () => {
    it('parse(undefined) -> {} — would have thrown before commit 3f5d88f', () => {
      expect(updatePersonSchema.parse(undefined)).toEqual({});
    });

    it('parse({}) -> {} (unchanged) — refine trivially satisfied (both fields absent)', () => {
      expect(updatePersonSchema.parse({})).toEqual({});
    });

    it('a valid populated body round-trips', () => {
      expect(updatePersonSchema.parse({ name: 'Grandma Rose' })).toEqual({ name: 'Grandma Rose' });
    });

    it('an invalid field value still throws', () => {
      expect(() => updatePersonSchema.parse({ name: '' })).toThrow(); // min(1)
      expect(() => updatePersonSchema.parse({ coverFaceId: 'not-a-uuid' })).toThrow();
    });

    it('the .refine() is still enforced on a real populated body (fix did not bypass it)', () => {
      // profileMediaItemId without profileCrop must still be rejected.
      expect(() =>
        updatePersonSchema.parse({ profileMediaItemId: randomUUID() }),
      ).toThrow(/must both be provided or both be null/);
      // profileCrop without profileMediaItemId must still be rejected.
      expect(() =>
        updatePersonSchema.parse({ profileCrop: { x: 0, y: 0, w: 1, h: 1 } }),
      ).toThrow(/must both be provided or both be null/);
      // both together is valid.
      expect(
        updatePersonSchema.parse({
          profileMediaItemId: randomUUID(),
          profileCrop: { x: 0, y: 0, w: 1, h: 1 },
        }),
      ).toMatchObject({ profileCrop: { x: 0, y: 0, w: 1, h: 1 } });
    });

    it('UpdatePersonDto.schema is the same schema instance exercised above', () => {
      expect(UpdatePersonDto.schema).toBe(updatePersonSchema);
    });
  });

  // ===========================================================================
  // ReprocessFailedBodyDto — stand-in "admin-backfill clone" representative.
  //
  // The task named `AdminMetadataBackfillDto` (apps/api/src/metadata/admin-metadata.controller.ts)
  // as the canonical admin-backfill example, but BOTH its local schema const
  // (`adminMetadataBackfillSchema`) AND the DTO class itself are declared
  // without `export` — there is no way to import either without changing
  // production code, which the task explicitly says not to do here.
  // `ReprocessFailedBodyDto` (apps/api/src/media/media-reprocess.controller.ts,
  // `POST /api/admin/media/reprocess-failed` body `{ limit? }`) is fixed by the
  // exact same commit, follows the exact same top-level `.default({})`
  // pattern, lives in the same "admin bulk-operation" family, and — unlike
  // the *-backfill controllers — IS exported, so it stands in as the
  // representative here without touching production code.
  //
  // The genuinely `.prefault({})`-flavored case (an inner field default that
  // must survive the top-level default — e.g. AdminMetadataBackfillDto's
  // `force: z.boolean().optional().default(false)`) is instead exercised
  // end-to-end through the real HTTP route in issue-289-bodyless-post.spec.ts,
  // which never needs to import the unexported class/schema by name.
  // ===========================================================================
  describe('ReprocessFailedBodyDto (apps/api/src/media/media-reprocess.controller.ts) — admin-backfill-clone stand-in', () => {
    const schema = ReprocessFailedBodyDto.schema;

    it('parse(undefined) -> {} — would have thrown before commit 3f5d88f', () => {
      expect(schema.parse(undefined)).toEqual({});
    });

    it('parse({}) -> {} (unchanged)', () => {
      expect(schema.parse({})).toEqual({});
    });

    it('a valid populated body round-trips', () => {
      expect(schema.parse({ limit: 50 })).toEqual({ limit: 50 });
    });

    it('an invalid field value still throws', () => {
      expect(() => schema.parse({ limit: -1 })).toThrow(); // positive()
      expect(() => schema.parse({ limit: 1.5 })).toThrow(); // int()
    });
  });

  // ===========================================================================
  // PatchUserSettingsDto — nested/complex settings-patch case (JSON Merge
  // Patch style, multiple optional nested objects).
  // ===========================================================================
  describe('PatchUserSettingsDto (apps/api/src/settings/dto/update-user-settings.dto.ts)', () => {
    it('parse(undefined) -> {} — would have thrown before commit 3f5d88f', () => {
      expect(patchUserSettingsSchema.parse(undefined)).toEqual({});
    });

    it('parse({}) -> {} (unchanged)', () => {
      expect(patchUserSettingsSchema.parse({})).toEqual({});
    });

    it('a valid populated body round-trips', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'dark',
        profile: { displayName: 'Oscar' },
      });
      expect(result).toEqual({ theme: 'dark', profile: { displayName: 'Oscar' } });
    });

    it('an invalid field value still throws', () => {
      expect(() => patchUserSettingsSchema.parse({ theme: 'purple' })).toThrow();
      expect(() =>
        patchUserSettingsSchema.parse({ profile: { customImageUrl: 'not-a-url' } }),
      ).toThrow();
    });

    it('PatchUserSettingsDto.schema is the same schema instance exercised above', () => {
      expect(PatchUserSettingsDto.schema).toBe(patchUserSettingsSchema);
    });
  });

  // ===========================================================================
  // AcceptLocationSuggestionDto — a second plain `.default({})` case (numeric
  // optional fields) rounding out the spread.
  // ===========================================================================
  describe('AcceptLocationSuggestionDto (apps/api/src/location-inference/dto/accept-location-suggestion.dto.ts)', () => {
    const schema = AcceptLocationSuggestionDto.schema;

    it('parse(undefined) -> {} — accept-unmodified is the documented bodyless use case', () => {
      expect(schema.parse(undefined)).toEqual({});
    });

    it('parse({}) -> {} (unchanged)', () => {
      expect(schema.parse({})).toEqual({});
    });

    it('a valid populated body (adjusted accept) round-trips', () => {
      expect(schema.parse({ lat: 9.93, lng: -84.08 })).toEqual({ lat: 9.93, lng: -84.08 });
    });

    it('an invalid field value still throws', () => {
      expect(() => schema.parse({ lat: 999 })).toThrow(); // max(90)
      expect(() => schema.parse({ lng: -999 })).toThrow(); // min(-180)
    });
  });

  // ===========================================================================
  // TriggerBackupSchema — the DELIBERATE EXCLUSION guard.
  //
  // Every key on this schema is optional, so it pattern-matches every other
  // schema fixed in this sweep — but its top-level `.refine()` is what makes a
  // bodyless request semantically INVALID (a backup must name a circle or
  // opt into "all"), and `.default({})` BYPASSES a top-level `.refine()` for
  // the default value it substitutes in. Adding `.default({})` here would
  // therefore silently ACCEPT an empty body that this endpoint must reject.
  //
  // This test is the guardrail: it fails loudly if a future "helpful" sweep
  // adds `.default({})` to TriggerBackupSchema, because a bodyless request
  // must keep throwing.
  // ===========================================================================
  describe('TriggerBackupSchema (apps/api/src/jobs/backup/dto/trigger-backup.dto.ts) — deliberately excluded', () => {
    it('parse(undefined) still throws — do NOT add .default({}) here (see file-level comment)', () => {
      expect(() => TriggerBackupSchema.parse(undefined)).toThrow();
    });

    it('parse({}) still throws — the refine (circleId or all:true required) is not bypassable', () => {
      expect(() => TriggerBackupSchema.parse({})).toThrow(/Provide either circleId or all/);
    });

    it('a body satisfying the refine still parses correctly', () => {
      expect(TriggerBackupSchema.parse({ all: true })).toEqual({ all: true });
      const circleId = randomUUID();
      expect(TriggerBackupSchema.parse({ circleId })).toEqual({ circleId });
    });
  });
});
