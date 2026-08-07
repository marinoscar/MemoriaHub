import { Module } from '@nestjs/common';
import { AdminBootstrapService } from './services/admin-bootstrap.service';
import { RbacReconcileService } from './services/rbac-reconcile.service';

@Module({
  providers: [AdminBootstrapService, RbacReconcileService],
  exports: [AdminBootstrapService, RbacReconcileService],
})
export class CommonModule {}
