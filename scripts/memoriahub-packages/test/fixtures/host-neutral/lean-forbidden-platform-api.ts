// Fixture for rule `host-neutral`: importing @marinoscar/platform-api, bare or the
// old /ai subpath, from memoriahub-ai or memoriahub-eval is a violation. The test copies it
// into packages/<memoriahub-ai|memoriahub-eval>/src/runtime.
import { AiError } from '@marinoscar/platform-api/ai';
import '@marinoscar/platform-api';

export const ERROR = AiError;
