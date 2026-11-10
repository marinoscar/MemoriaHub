// =============================================================================
// The `ai` namespace extension: MemoriaHub's feature selections (RETRO-E1, #595)
// =============================================================================
//
// The `ai` system-settings namespace is the platform AI slice's since RETRO-E1
// (`AI_SYSTEM_SETTINGS`: the kill switch `enabled`, `keyPolicy`, provider
// slots, defaults, limits, ...). MemoriaHub has always stored, in the same `ai`
// block of the `global` row, WHICH provider and model serve each of its AI
// features:
//
//   features.search         agentic search (chat + tools)
//   features.tagging        photo and video AI tagging (vision)
//   features.embedding      semantic-search embeddings (1536-d)
//   features.enhance        the AI Picture Enhancer (image edit)   whole or null
//   features.memories       memory titles (chat)                   whole or null
//   features.transcription  video tagging speech-to-text           whole or null
//
// That one field is added to the platform namespace here
// (`extendSystemSettingsNamespace`, listed in `APP_SYSTEM_SETTINGS_EXTENSIONS`).
// STORED NAMES AND SHAPES ARE THE OLD ONES, field for field: the `ai` key of the
// `global` row is the same row before and after, nothing is rewritten.
//
// MERGE. `/api/admin/memoriahub-ai/features/*` (was `/api/ai/features/*`) writes ONE selection at a time
// (`{ features: { search: {...} } }`), so the merge is per selection, never a
// wholesale replace of `features`; and for `search`, `tagging` and `embedding`
// an explicit `null` provider or model KEEPS the stored value (the old `??`
// semantics). `enhance`, `memories` and `transcription` are whole-or-null: a
// `null` clears the selection.
//
// READ. Each selection falls back to its default ON ITS OWN (`.catch`), so a
// row written before a later selection existed (`transcription`, epic #452)
// keeps every selection an administrator saved. The patch and PUT schemas have
// no `.catch`: an invalid write is a 400, never silently a default.
//
// RETRO-E2 (#601) routes each registered AI feature (`registerAiFeature`, `app-registrations/ai.ts`)
// to its selection through `AI_TARGET_RESOLVER` (`MemoriaHubAiTargetResolver`, which reads these
// fields through `MemoriaHubAiSettings`). This extension STAYS: it is where the platform finds the
// feature -> model choice, and the platform admin pages and the MemoriaHub section edit it.
// ⚠ NO FIELD HERE CAN HOLD A KEY, and none may ever be added (the `settings`
// conformance suite walks every namespace for a secret-named field).
// =============================================================================

import type { SystemSettingsNamespaceExtension } from '@marinoscar/platform-api/settings';
import { z } from 'zod';

const selection = z.object({ provider: z.string().nullable(), model: z.string().nullable() });
// A half-filled provider/model pair is not a valid selection: the object is whole or null.
const pair = z.object({ provider: z.string(), model: z.string() }).nullable();

const EMPTY_SELECTION = { provider: null, model: null };

/** The stored `features` block (strict: what a PUT must carry). */
const featuresSchema = z.object({
  search: selection,
  tagging: selection,
  embedding: selection,
  enhance: pair,
  memories: pair,
  transcription: pair,
});

/** The read view: each selection salvaged on its own. */
const featuresReadSchema = z.object({
  search: selection.catch({ ...EMPTY_SELECTION }),
  tagging: selection.catch({ ...EMPTY_SELECTION }),
  embedding: selection.catch({ ...EMPTY_SELECTION }),
  enhance: pair.catch(null),
  memories: pair.catch(null),
  transcription: pair.catch(null),
});

/** A patch names any subset of the selections; a selection's own fields are optional too. */
const featuresPatchSchema = z.object({
  search: selection.partial().optional(),
  tagging: selection.partial().optional(),
  embedding: selection.partial().optional(),
  enhance: pair.optional(),
  memories: pair.optional(),
  transcription: pair.optional(),
});

export type AiFeatureSelections = z.infer<typeof featuresSchema>;

/** MemoriaHub's view of the `ai` namespace (the platform fields are not typed here). */
export interface AiSettingsValue {
  features: AiFeatureSelections;
}

export const AI_FEATURES_DEFAULTS: AiFeatureSelections = {
  search: { ...EMPTY_SELECTION },
  tagging: { ...EMPTY_SELECTION },
  embedding: { ...EMPTY_SELECTION },
  enhance: null,
  memories: null,
  transcription: null,
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

const KEEP_ON_NULL = ['search', 'tagging', 'embedding'] as const;
const WHOLE_OR_NULL = ['enhance', 'memories', 'transcription'] as const;

/**
 * Merges a `features` patch into the stored block: per selection; `null`
 * provider/model keeps the stored value for the three keep-on-null selections;
 * `undefined` keeps everything. Exported for its spec.
 */
export function mergeAiFeatures(current: unknown, patch: unknown): AiFeatureSelections {
  const cur = featuresReadSchema.parse(isObject(current) ? current : {});
  if (!isObject(patch)) return cur;
  const out: Json = { ...cur };
  for (const key of KEEP_ON_NULL) {
    const incoming = patch[key];
    if (!isObject(incoming)) continue;
    const stored = cur[key];
    out[key] = {
      provider: incoming['provider'] ?? stored.provider,
      model: incoming['model'] ?? stored.model,
    };
  }
  for (const key of WHOLE_OR_NULL) {
    if (patch[key] !== undefined) out[key] = patch[key];
  }
  return out as AiFeatureSelections;
}

export const MEMORIAHUB_AI_SETTINGS_EXTENSION: SystemSettingsNamespaceExtension = {
  key: 'ai',
  storedSchema: z.object({ features: featuresReadSchema }),
  putSchema: z.object({ features: featuresSchema }),
  patchSchema: z.object({ features: featuresPatchSchema.optional() }),
  wirePatchSchema: z.object({ features: featuresPatchSchema.optional() }),
  responseSchema: z.object({ features: featuresSchema }),
  defaults: { features: AI_FEATURES_DEFAULTS },
  merge(current, patch, baseMerge) {
    const merged = (baseMerge(current, patch) ?? {}) as Json;
    return { ...merged, features: mergeAiFeatures(current['features'], patch?.['features']) };
  },
};
