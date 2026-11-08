// =============================================================================
// MemoriaHub's AI features (RETRO-E1, #595: stub)
// =============================================================================
//
// Every place this product calls a model becomes a registered AI feature
// (`registerAiFeature`): the platform stamps the feature id on the usage row (so
// `GET /api/admin/ai/usage` groups by it), checks the feature's `needs` against
// the chosen model's capabilities, and lists it at `GET /api/ai/features`.
//
// EMPTY IN RETRO-E1. The call sites (search, tagging, video tagging, embeddings,
// the picture enhancer, transcription, memory titles) still run on the legacy
// provider adapter (`src/ai-port/`); RETRO-E2 registers one feature per call site
// here and moves each call to `AiService.forUser(userId, { orgId, feature })`.
//
// ⚠ A FEATURE ID IS PERMANENT once usage rows carry it. Lower snake case.
//
// Imported once, from `platform/ai/ai.config.ts`, at module load: the registry
// freezes when the application bootstraps, so a registration from a service
// would fail with `FROZEN`.
// =============================================================================

export {};
