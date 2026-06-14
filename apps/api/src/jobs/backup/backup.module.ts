import { Module } from '@nestjs/common';
import { BackupService } from './backup.service';
import { BackupController } from './backup.controller';
import { StorageProvidersModule } from '../../storage/providers/storage-providers.module';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [StorageProvidersModule, PrismaModule],
  providers: [BackupService],
  controllers: [BackupController],
  exports: [BackupService],
})
export class BackupModule {}
