// =============================================================================
// The AI slice's composition (RETRO-E1, #595)
// =============================================================================
//
// `AiModule.forRoot` mounts the platform AI slice: `GET /api/ai/config`, `/api/ai/keys`, the
// responses / embeddings / images / audio / realtime / runs routes, `/api/ai/features`,
// `/api/ai/usage`, `/api/admin/ai/*` (the deployment policy, the model catalogue, deployment and
// organization keys, usage), the `ai.*` job types, the AI Doctor check and the kill switch.
//
// `providers: ['openai', 'anthropic']`: the two vendors MemoriaHub has always offered; the other
// three provider modules stay out of the graph (their settings slots stay, inert).
// `perUserDefaultModel: false`: MemoriaHub uses deployment keys only and picks the model per
// feature (`ai.features.*`), so the platform's per-user default-model picker is hidden (open
// decision 1 of #595; BYOK can be enabled later by settings).
//
// THE KILL SWITCH IS OFF BY DEFAULT (`ai.enabled: false`): every consumer route answers 403
// `AI_DISABLED` until an administrator turns it on. MemoriaHub's own AI features (tagging, search,
// memories, the enhancer, transcription) do NOT go through the platform runtime yet: they call the
// legacy provider adapter (`src/ai-port/`, PLATFORM-ADOPTION-SHIM(#595)) under the legacy keys, so
// they keep working exactly as before. RETRO-E2 registers the features and moves each call to
// `AiService.forUser`; RETRO-E3 imports the keys; RETRO-E4 swaps the admin pages.
//
// ORDER: `app-registrations/ai.ts` registers the AI features, and the registry freezes when the
// application bootstraps, so it is imported HERE, at module load, never from a service. The
// settings registry (which declares the `ai` namespace with MemoriaHub's extension) is imported
// first.
//
// THE CONSTANT BELOW IS A SINGLETON: a module that needs the AI services imports `aiModule` (the
// same dynamic-module object), never a second `AiModule.forRoot()`.
// =============================================================================

import { AiModule } from '@marinoscar/platform-api/ai';

import '../../settings/registry';
import '../../app-registrations/ai';
import { AiHostModule } from './ai-host.module';

export const aiModule = AiModule.forRoot({
  imports: [AiHostModule],
  providers: ['openai', 'anthropic'],
  perUserDefaultModel: false,
});
