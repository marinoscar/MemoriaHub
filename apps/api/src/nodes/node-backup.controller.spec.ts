/**
 * Unit tests for NodeBackupController (issue #312) — thin delegation layer:
 * every handler passes the caller's user id + the :id node param straight to
 * NodeBackupService, which owns ownership/validation. Also asserts the
 * class-level jobs:write auth metadata is present (mirrors nodes.controller).
 */

import { Test, TestingModule } from '@nestjs/testing';
import { NodeBackupController } from './node-backup.controller';
import { NodeBackupService } from './node-backup.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequestUser } from '../auth/interfaces/authenticated-user.interface';

const USER = { id: 'user-1' } as RequestUser;
const NODE_ID = 'node-1';
const RUN_ID = 'run-1';

describe('NodeBackupController', () => {
  let controller: NodeBackupController;
  let service: Record<string, jest.Mock>;

  beforeEach(async () => {
    service = {
      getConfig: jest.fn().mockResolvedValue({ config: null }),
      updateConfig: jest.fn().mockResolvedValue({ config: {} }),
      startRun: jest.fn().mockResolvedValue({ run: {} }),
      getChanges: jest.fn().mockResolvedValue({ items: [] }),
      ack: jest.fn().mockResolvedValue({ ok: true }),
      finishRun: jest.fn().mockResolvedValue({ ok: true }),
      listRuns: jest.fn().mockResolvedValue({ runs: [] }),
      getManifest: jest.fn().mockResolvedValue({ items: [] }),
      getDimensions: jest.fn().mockResolvedValue({ albums: [] }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NodeBackupController],
      providers: [{ provide: NodeBackupService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(NodeBackupController);
  });

  it('GET config delegates with (userId, nodeId)', async () => {
    await expect(controller.getConfig(USER, NODE_ID)).resolves.toEqual({
      config: null,
    });
    expect(service.getConfig).toHaveBeenCalledWith('user-1', NODE_ID);
  });

  it('PUT config delegates with the dto', async () => {
    const dto = { enabled: false } as any;
    await controller.updateConfig(USER, NODE_ID, dto);
    expect(service.updateConfig).toHaveBeenCalledWith('user-1', NODE_ID, dto);
  });

  it('POST runs delegates with the dto', async () => {
    const dto = { kind: 'incremental', trigger: 'manual', cliVersion: '1.2.0' } as any;
    await controller.startRun(USER, NODE_ID, dto);
    expect(service.startRun).toHaveBeenCalledWith('user-1', NODE_ID, dto);
  });

  it('GET changes delegates with the query dto', async () => {
    const query = { runId: RUN_ID, limit: 50 } as any;
    await controller.getChanges(USER, NODE_ID, query);
    expect(service.getChanges).toHaveBeenCalledWith('user-1', NODE_ID, query);
  });

  it('POST ack delegates with the dto', async () => {
    const dto = { runId: RUN_ID } as any;
    await controller.ack(USER, NODE_ID, dto);
    expect(service.ack).toHaveBeenCalledWith('user-1', NODE_ID, dto);
  });

  it('POST runs/:runId/finish delegates with runId and dto', async () => {
    const dto = { status: 'completed' } as any;
    await controller.finishRun(USER, NODE_ID, RUN_ID, dto);
    expect(service.finishRun).toHaveBeenCalledWith('user-1', NODE_ID, RUN_ID, dto);
  });

  it('GET runs delegates with the limit', async () => {
    await controller.listRuns(USER, NODE_ID, { limit: 30 } as any);
    expect(service.listRuns).toHaveBeenCalledWith('user-1', NODE_ID, 30);
  });

  it('GET manifest delegates with the query dto', async () => {
    const query = { runId: RUN_ID } as any;
    await controller.getManifest(USER, NODE_ID, query);
    expect(service.getManifest).toHaveBeenCalledWith('user-1', NODE_ID, query);
  });

  it('GET dimensions delegates with (userId, nodeId)', async () => {
    await controller.getDimensions(USER, NODE_ID);
    expect(service.getDimensions).toHaveBeenCalledWith('user-1', NODE_ID);
  });

  it('carries the class-level jobs:write permission metadata', () => {
    const permissions = Reflect.getMetadata('permissions', NodeBackupController);
    expect(permissions).toEqual(['jobs:write']);
  });
});
