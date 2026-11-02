import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service.js';
import { StorageController } from './storage.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SubscriptionModule } from '../subscriptions/subscription.module.js';

@Global()
@Module({
  imports: [TenantModule, AuthModule, SubscriptionModule],
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
