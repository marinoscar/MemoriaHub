import { Module } from '@nestjs/common';

import { LocalStorageDownloadController } from './local-storage-download.controller';

/** The `local` storage driver's signed-download route (RETRO-D1, #563). */
@Module({ controllers: [LocalStorageDownloadController] })
export class LocalStorageDownloadModule {}
