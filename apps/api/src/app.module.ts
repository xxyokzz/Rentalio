import { Global, Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuditModule } from './audit/audit.module.js';
import { EmailModule } from './email/email.module.js';
import { RateLimitModule } from './rate-limit/rate-limit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { TenantModule } from './tenant/tenant.module.js';
import { SubscriptionModule } from './subscriptions/subscription.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { ReturnsModule } from './returns/returns.module.js';
import { ReservationsModule } from './reservations/reservations.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { PaymentSettingsModule } from './payment-settings/payment-settings.module.js';
import { WhatsAppTemplatesModule } from './whatsapp-templates/whatsapp-templates.module.js';
import { CatalogConfigModule } from './catalog-config/catalog-config.module.js';
import { ExtensionsModule } from './extensions/extensions.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { PublicModule } from './public/public.module.js';
import { SessionCookieMiddleware } from './auth/session-cookie.middleware.js';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware.js';
import { RequestLoggingMiddleware } from './common/request-logging.middleware.js';
import { StructuredLogger } from './common/logger.service.js';
import { HttpErrorFilter } from './common/http-error.filter.js';
import { ApiFailureAlertService } from './monitoring/api-failure-alert.service.js';
import { HealthController } from './health/health.controller.js';
import { CronController } from './internal/cron.controller.js';
import { StorageModule } from './storage/storage.module.js';
import { PlatformAdminModule } from './platform-admin/platform-admin.module.js';
import { BillingModule } from './billing/billing.module.js';
import { ReportsModule } from './reports/reports.module.js';

@Global()
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuditModule,
    EmailModule,
    RateLimitModule,
    AuthModule,
    TenantModule,
    SubscriptionModule,
    CatalogModule,
    ReturnsModule,
    ReservationsModule,
    OrdersModule,
    PaymentSettingsModule,
    WhatsAppTemplatesModule,
    CatalogConfigModule,
    ExtensionsModule,
    CustomersModule,
    PublicModule,
    StorageModule,
    PlatformAdminModule,
    BillingModule,
    ReportsModule,
  ],
  controllers: [HealthController, CronController],
  providers: [StructuredLogger, ApiFailureAlertService, HttpErrorFilter],
  exports: [StructuredLogger],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Urutan penting: correlation ID dulu (dipakai filter error & audit),
    // lalu resolve sesi dari cookie, baru log akses (butuh userId).
    consumer
      .apply(
        CorrelationIdMiddleware,
        SessionCookieMiddleware,
        RequestLoggingMiddleware,
      )
      .forRoutes('*');
  }
}
