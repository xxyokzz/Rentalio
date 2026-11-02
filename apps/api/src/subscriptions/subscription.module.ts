import { Global, Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module.js';
import { SubscriptionPolicyService } from './subscription-policy.service.js';
import { SubscriptionGuard } from './subscription.guard.js';

/**
 * Policy subscription bersifat lintas modul: seluruh endpoint tenant-scoped
 * harus memakai satu aturan entitlement yang sama (dokumen 04/10).
 *
 * Reconciler TIDAK didaftarkan di sini: proses API harus stateless, sehingga
 * job periodik hanya hidup di proses worker (`WorkerModule`).
 */
@Global()
@Module({
  imports: [TenantModule],
  providers: [SubscriptionPolicyService, SubscriptionGuard],
  exports: [SubscriptionPolicyService, SubscriptionGuard],
})
export class SubscriptionModule {}
