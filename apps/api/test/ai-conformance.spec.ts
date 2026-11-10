// =============================================================================
// The platform AI runtime conformance suites, run against MemoriaHub (RETRO-E4, #607)
// =============================================================================
//
// Five suites drive the real router over the AI runtime harness (`./conformance/ai-fixture.ts`):
//
//   ai-kill-switch      with `ai.enabled = false` every `/api/ai/*` route except the probe answers
//                       403 `AI_DISABLED`, `/api/admin/ai/*` stays reachable, and every `ai.*` job
//                       makes zero provider calls.
//   ai-rbac-matrix      every AI route x every role is granted or denied exactly as the seeded
//                       catalog says; a personal access token inherits its owner's grants.
//   ai-secret-egress    no key (a user's, the deployment's, another user's, an organization's)
//                       appears in a response, header, log line, audit row, usage row or run row.
//   ai-key-policy       `byok` never spends the deployment key; `byok_with_org_fallback` only for a
//                       caller with no key of their own.
//   ai-jobs-server-only no `ai.*` job type is node-eligible.
//
// The two source scans (`ai-no-sdk-leak`, `ai-orchestration-boundary`) need no app and run in
// `conformance.spec.ts` with the other scans. This file boots the app once per suite, so jest runs
// it on its own.
//
// SCOPE, WRITTEN DOWN: these suites cover the PLATFORM AI surface (`/api/ai/*`, `/api/admin/ai/*`,
// the `ai.*` jobs). MemoriaHub's own AI features (tagging, video tagging, search, memories, the
// enhancer, transcription) are registered AI features called through `AiService` (RETRO-E2, #601);
// their job types `auto_tagging`, `video_auto_tagging` and `picture_enhancement` are server-only
// native handlers (RETRO-C4) and are neither `ai.*` types nor `/api/ai` routes, so no suite here
// sees them (their pins: test/jobs, src/*/ specs). The worker-node credential branch for `geocode`
// (and the dead AI branches) is PLATFORM-ADOPTION-SHIM(#1083), pinned by
// src/nodes/nodes.service.credentials.spec.ts, until RETRO-C10.
// =============================================================================

import { join } from 'node:path';

import '@marinoscar/platform-api/ai/testing';
import { runPlatformConformance } from '@marinoscar/platform-api/testing';

import '../src/app-registrations/permission-manifest';
import { aiConformanceFixture } from './conformance/ai-fixture';

runPlatformConformance({
  sourceRoots: [join(__dirname, '..', 'src')],
  suites: {
    aiKillSwitch: { fixture: aiConformanceFixture, minAiRoutes: 10, minAdminAiRoutes: 5, minAiJobTypes: 3 },
    aiRbacMatrix: { fixture: aiConformanceFixture, minRoutes: 15, minPermissionedRoutes: 10 },
    aiSecretEgress: { fixture: aiConformanceFixture },
    aiKeyPolicy: { fixture: aiConformanceFixture },
    aiJobsServerOnly: { fixture: aiConformanceFixture, minAiJobTypes: 3 },
  },
});
