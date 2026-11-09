// The AI provider ids MemoriaHub registers with the platform AI slice (RETRO-E1, #595): the two
// vendors it has always offered. A leaf file (no import), so the RETRO-E3 key import (#605) can
// read it without loading the application graph.
export const MEMORIAHUB_AI_PROVIDER_IDS = ['openai', 'anthropic'] as const;
export type MemoriaHubAiProviderId = (typeof MEMORIAHUB_AI_PROVIDER_IDS)[number];
