// PLATFORM-ADOPTION-SHIM(RETRO-C10): the old name of `AiPortModule` (RETRO-E2, #601). Only
// `nodes/nodes.module.ts` still imports it (for `AiSettingsService.resolveCredentials`, the
// worker-node credential broker); RETRO-C10 removes the node AI executors and this file.
export { AiPortModule as LegacyAiModule } from './ai-port.module';
