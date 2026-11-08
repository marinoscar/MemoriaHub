// Fills core's user-owned-data and model-ownership registries with the
// platform's inventories and MemoriaHub's own (RETRO-B2, issue #611). Imported
// once for its side effect by `prisma/prisma.service.ts`, before bootstrap: the
// registries freeze with the application.
import { registerPlatformModelOwnership, registerPlatformUserOwnedModels } from '@marinoscar/platform-api/manifest';

import { APP_MODEL_OWNERSHIP } from './model-ownership';
import { APP_USER_OWNED_MODELS } from './user-owned-models';

registerPlatformUserOwnedModels(APP_USER_OWNED_MODELS);
registerPlatformModelOwnership(APP_MODEL_OWNERSHIP);
