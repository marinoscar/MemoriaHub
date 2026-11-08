import { validatePort, type EnvSpecFragment } from '@marinoscar/platform-cli/core';

// =============================================================================
// The environment keys only MemoriaHub has  (issue #577, RETRO-F3)
// =============================================================================
//
// The platform's deploy wizard knows its own keys. The keys of
// `infra/compose/app.env.example` that are this app's own get validation here so
// a wrong answer (`--answer`, `--answers-file`) is refused by the wizard instead
// of failing the API at start-up. Keys the platform owns are not repeated: a key
// with two owners is an error at `createCli`.
// =============================================================================

function validatePositiveInteger(value: string): string | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? undefined : 'must be a whole number above 0';
}

function validateBoolean(value: string): string | undefined {
  return value === 'true' || value === 'false' ? undefined : 'must be true or false';
}

function oneOf(...allowed: string[]): (value: string) => string | undefined {
  return (value) => (allowed.includes(value) ? undefined : `must be one of: ${allowed.join(', ')}`);
}

export const APP_ENV_SPEC: EnvSpecFragment = {
  id: 'memoriahub',
  metadata: {
    APP_BIND_PORT: { validate: validatePort },
    DB_CONNECTION_LIMIT: { validate: validatePositiveInteger },
    DEVICE_PAT_TTL_DAYS: { validate: validatePositiveInteger },
    FACE_VECTOR_BACKEND: { validate: oneOf('pgvector', 'app') },
    GEO_PROVIDER: { validate: oneOf('offline', 'nominatim') },
    GEO_FORWARD_SEARCH_ENABLED: { validate: validateBoolean },
    AUTO_TAG_ENABLED: { validate: validateBoolean },
  },
};
