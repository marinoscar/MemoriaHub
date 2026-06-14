import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { StorageObjectStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from '../../storage/providers/storage-provider.interface';
import { LocalDiskStorageProvider } from '../../storage/providers/local/local-disk.provider';
import { TriggerBackupDto } from './dto/trigger-backup.dto';

interface BackupRunMeta {
  scope: string;
  circleId: string | null;
  startedAt: string;
  finishedAt?: string;
  copied?: number;
  skipped?: number;
  failed?: number;
  errors?: string[];
}

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  private readonly localPath: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
    private readonly localProvider: LocalDiskStorageProvider,
    private readonly configService: ConfigService,
  ) {
    this.localPath = this.configService.get<string>(
      'storage.backup.localPath',
      '/tmp/memoriahub-backup',
    );
  }

  async runBackup(
    dto: TriggerBackupDto,
    userId: string,
  ): Promise<{
    runId: string;
    scope: string;
    copied: number;
    skipped: number;
    failed: number;
    errors: string[];
  }> {
    const runId = randomUUID();
    const scope = dto.circleId || 'all';
    const startedAt = new Date().toISOString();

    this.logger.log(`Starting backup run ${runId}, scope: ${scope}`);

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'backup.start',
        targetType: 'backup_run',
        targetId: runId,
        meta: {
          scope,
          circleId: dto.circleId || null,
          startedAt,
        },
      },
    });

    const mediaItems = await this.prisma.mediaItem.findMany({
      where: {
        deletedAt: null,
        storageObject: { status: StorageObjectStatus.ready },
        ...(dto.circleId ? { circleId: dto.circleId } : {}),
      },
      include: {
        storageObject: {
          select: {
            storageKey: true,
            storageProvider: true,
            size: true,
            mimeType: true,
          },
        },
      },
    });

    let copied = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    // Track items by circle for manifest writing
    const circleItems = new Map<
      string,
      Array<{
        id: string;
        originalFilename: string | null;
        type: string;
        capturedAt: Date | null;
        storageKey: string;
        size: number;
      }>
    >();

    for (const item of mediaItems) {
      if (!item.storageObject) {
        skipped++;
        continue;
      }

      try {
        const stream = await this.storageProvider.download(
          item.storageObject.storageKey,
        );

        await this.localProvider.upload(item.storageObject.storageKey, stream, {
          mimeType: item.storageObject.mimeType,
          contentLength: Number(item.storageObject.size),
        });

        copied++;

        // Add to circle manifest tracking
        const circleArr = circleItems.get(item.circleId) || [];
        circleArr.push({
          id: item.id,
          originalFilename: item.originalFilename,
          type: item.type,
          capturedAt: item.capturedAt,
          storageKey: item.storageObject.storageKey,
          size: Number(item.storageObject.size),
        });
        circleItems.set(item.circleId, circleArr);
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${item.id}: ${msg}`);
        this.logger.warn(`Failed to copy item ${item.id}: ${msg}`);
      }
    }

    // Write per-circle manifest JSON files
    const manifestsDir = path.join(this.localPath, 'manifests');
    fs.mkdirSync(manifestsDir, { recursive: true });

    for (const [circleId, items] of circleItems.entries()) {
      const manifestPath = path.join(manifestsDir, `${circleId}.json`);
      const manifest = {
        circleId,
        exportedAt: new Date().toISOString(),
        items,
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      this.logger.debug(`Wrote manifest for circle ${circleId}: ${items.length} items`);
    }

    const finishedAt = new Date().toISOString();

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'backup.complete',
        targetType: 'backup_run',
        targetId: runId,
        meta: {
          scope,
          circleId: dto.circleId || null,
          startedAt,
          finishedAt,
          copied,
          skipped,
          failed,
          errors: errors.slice(0, 50),
        },
      },
    });

    this.logger.log(
      `Backup run ${runId} complete: copied=${copied}, skipped=${skipped}, failed=${failed}`,
    );

    return { runId, scope, copied, skipped, failed, errors };
  }

  async getRecentRuns(limit = 20): Promise<
    Array<{
      runId: string;
      completedAt: Date;
      actorUserId: string | null;
      scope: string;
      circleId: string | null;
      startedAt: string;
      finishedAt: string;
      copied: number;
      skipped: number;
      failed: number;
      errors: string[];
    }>
  > {
    const events = await this.prisma.auditEvent.findMany({
      where: {
        targetType: 'backup_run',
        action: 'backup.complete',
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        targetId: true,
        meta: true,
        createdAt: true,
        actorUserId: true,
      },
    });

    return events.map((e) => {
      const meta = (e.meta as unknown as BackupRunMeta) || {};
      return {
        runId: e.targetId,
        completedAt: e.createdAt,
        actorUserId: e.actorUserId,
        scope: meta.scope || 'unknown',
        circleId: meta.circleId || null,
        startedAt: meta.startedAt || '',
        finishedAt: meta.finishedAt || '',
        copied: meta.copied || 0,
        skipped: meta.skipped || 0,
        failed: meta.failed || 0,
        errors: meta.errors || [],
      };
    });
  }

  async getRunStatus(runId: string): Promise<{
    runId: string;
    status: 'completed' | 'started' | 'unknown';
    startEvent?: Record<string, unknown>;
    completeEvent?: Record<string, unknown>;
  }> {
    const events = await this.prisma.auditEvent.findMany({
      where: {
        targetType: 'backup_run',
        targetId: runId,
      },
      orderBy: { createdAt: 'asc' },
    });

    const startEvent = events.find((e) => e.action === 'backup.start');
    const completeEvent = events.find((e) => e.action === 'backup.complete');

    const status = completeEvent
      ? 'completed'
      : startEvent
        ? 'started'
        : 'unknown';

    return {
      runId,
      status,
      startEvent: startEvent
        ? {
            id: startEvent.id,
            meta: startEvent.meta,
            createdAt: startEvent.createdAt,
          }
        : undefined,
      completeEvent: completeEvent
        ? {
            id: completeEvent.id,
            meta: completeEvent.meta,
            createdAt: completeEvent.createdAt,
          }
        : undefined,
    };
  }

  async listObjects(circleId?: string): Promise<{
    items: Array<{
      mediaItemId: string;
      storageKey: string;
      downloadUrl: string;
      originalFilename: string | null;
      mimeType: string;
      size: number;
      circleId: string;
    }>;
  }> {
    const mediaItems = await this.prisma.mediaItem.findMany({
      where: {
        deletedAt: null,
        storageObject: { status: StorageObjectStatus.ready },
        ...(circleId ? { circleId } : {}),
      },
      include: {
        storageObject: {
          select: {
            storageKey: true,
            size: true,
            mimeType: true,
          },
        },
      },
    });

    const items = await Promise.all(
      mediaItems
        .filter((item) => item.storageObject)
        .map(async (item) => {
          const downloadUrl = await this.storageProvider.getSignedDownloadUrl(
            item.storageObject!.storageKey,
          );
          return {
            mediaItemId: item.id,
            storageKey: item.storageObject!.storageKey,
            downloadUrl,
            originalFilename: item.originalFilename,
            mimeType: item.storageObject!.mimeType,
            size: Number(item.storageObject!.size),
            circleId: item.circleId,
          };
        }),
    );

    return { items };
  }
}
