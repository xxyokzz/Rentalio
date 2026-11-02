import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { BillingService } from './billing.service.js';
import { BillingSettlementService } from './billing-settlement.service.js';
import { BillingController } from './billing.controller.js';
import { QrisService } from './qris.service.js';

/**
 * Billing langganan platform (QRIS dinamis). Terpisah dari `payment-settings`
 * yang mengatur metode pembayaran tenant ke penyewanya: modul ini menangani
 * pembayaran tenant ke Rentalio.
 *
 * Tidak ada job periodik di sini: QRIS tidak punya status yang bisa ditarik,
 * sehingga API tetap stateless dan proses worker tidak memuat modul billing.
 */
@Module({
  // PrismaService, APP_CONFIG, dan AuditService bersifat global; AuthModule
  // dibutuhkan CsrfGuard pada endpoint pembuatan tagihan.
  imports: [AuthModule, TenantModule],
  controllers: [BillingController],
  providers: [BillingService, BillingSettlementService, QrisService],
  exports: [BillingSettlementService],
})
export class BillingModule {}
