import { Module } from '@nestjs/common';
import { PublicController, PortalController } from './public.controller.js';
import { PublicService } from './public.service.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { SubscriptionModule } from '../subscriptions/subscription.module.js';
import { CatalogConfigModule } from '../catalog-config/catalog-config.module.js';
import { ExtensionsModule } from '../extensions/extensions.module.js';

@Module({
  imports: [ReservationsModule, SubscriptionModule, CatalogConfigModule, ExtensionsModule],
  controllers: [PublicController, PortalController],
  providers: [PublicService],
})
export class PublicModule {}
