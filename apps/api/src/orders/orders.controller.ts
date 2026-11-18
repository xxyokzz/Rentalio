import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { OrdersService } from './orders.service.js';
import {
  CompleteOrderDto,
  CreateCollateralDto,
  CreateOrderDto,
  DepositDecisionDto,
  CreateOrderPenaltyDto,
  DepositDeductionDto,
  DepositReceiptDto,
  DepositRefundDto,
  HandoverDto,
  ListOrdersQueryDto,
  ReadyForHandoverDto,
  RecordPaymentDto,
  RefundDecisionDto,
  RefundResultDto,
  RequestRefundDto,
  ReturnCollateralDto,
  ReverseDepositMovementDto,
  VoidOrderPenaltyDto,
  VoidPaymentDto,
} from './orders.dto.js';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards.js';
import { BlockInRestrictedMode } from '../subscriptions/subscription.decorator.js';
import { SubscriptionGuard } from '../subscriptions/subscription.guard.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

/**
 * Order, pembayaran manual, dan deposit — Notion 04:
 *   POST /reservations/:id/convert-to-order
 *   GET/POST /orders
 *   GET /orders/:id
 *   POST /orders/:id/ready-for-handover
 *   POST /orders/:id/handover
 *   POST /orders/:id/complete
 *   GET/POST /orders/:id/payments
 *   POST /payments/:id/void
 *   GET/POST /orders/:id/refunds
 *   POST /refunds/:id/approve | /record-result
 *   GET/POST /orders/:id/deposits
 *   POST /orders/:id/deposit-deductions
 *   POST /deposit-deductions/:id/approve | /reject
 *   POST /orders/:id/deposit-refunds
 *   POST /orders/:id/deposit-movements/:movementId/reverse
 *
 * Tidak ada PATCH status bebas: semua transisi lewat command + audit.
 */
interface AuthedRequest extends Request {
  session?: SessionInfo;
}

@ApiTags('order')
@Controller('tenants/:tenantId')
@UseGuards(SessionGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get('orders')
  @ApiOperation({ summary: 'Daftar order tenant (paginasi + filter status)' })
  async listOrders(
    @Param('tenantId') tenantId: string,
    @Query() query: ListOrdersQueryDto,
    @Req() req: AuthedRequest,
  ) {
    return this.ordersService.listOrders(tenantId, query, this.uid(req));
  }

  @Post('orders')
  @HttpCode(201)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Buat order dari reservasi CONFIRMED (idempoten per reservasi)' })
  async createOrder(
    @Param('tenantId') tenantId: string,
    @Body() body: CreateOrderDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.createOrder(tenantId, body, this.ctx(req)),
    };
  }

  @Get('orders/:orderId')
  @ApiOperation({ summary: 'Detail order, pembayaran, dan saldo/ledger deposit' })
  async getOrder(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Req() req: AuthedRequest,
  ) {
    return { data: await this.ordersService.getOrder(tenantId, orderId, this.uid(req)) };
  }

  @Post('reservations/:reservationId/convert-to-order')
  @HttpCode(201)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Konversi reservasi CONFIRMED → order (tidak boleh duplikat)' })
  async convertReservation(
    @Param('tenantId') tenantId: string,
    @Param('reservationId') reservationId: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.convertReservation(
        tenantId,
        reservationId,
        this.ctx(req),
      ),
    };
  }

  @Post('orders/:orderId/ready-for-handover')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Tandai siap serah-terima — CONFIRMED → READY_FOR_HANDOVER' })
  async readyForHandover(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Body() body: ReadyForHandoverDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.readyForHandover(tenantId, orderId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  @Post('orders/:orderId/handover')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Serah-terima — READY_FOR_HANDOVER → ACTIVE (wajib audit kondisi)' })
  async handover(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Body() body: HandoverDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.handover(tenantId, orderId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  @Post('orders/:orderId/complete')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Selesaikan order — RETURN_IN_PROGRESS → COMPLETED' })
  async completeOrder(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Body() body: CompleteOrderDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.completeOrder(tenantId, orderId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  // ------------------------------------------------------------------
  // Pembayaran manual
  // ------------------------------------------------------------------

  @Get('orders/:orderId/whatsapp-messages')
  @ApiOperation({
    summary: 'Histori snapshot pesan WhatsApp order (body + versi template yang dipakai)',
  })
  async listWhatsAppMessages(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.ordersService.listWhatsAppMessages(tenantId, orderId, this.uid(req));
  }

  @Get('orders/:orderId/payments')
  @ApiOperation({ summary: 'Daftar pembayaran order (termasuk yang VOIDED)' })
  async listPayments(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.ordersService.listPayments(tenantId, orderId, this.uid(req));
  }

  @Post('orders/:orderId/payments')
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Catat pembayaran manual — status awal RECORDED (append-only)' })
  async recordPayment(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Body() body: RecordPaymentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.recordPayment(tenantId, orderId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  @Post('payments/:paymentId/void')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Void pembayaran — koreksi tercatat, histori tidak dihapus' })
  async voidPayment(
    @Param('tenantId') tenantId: string,
    @Param('paymentId') paymentId: string,
    @Body() body: VoidPaymentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.voidPayment(tenantId, paymentId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  // ------------------------------------------------------------------
  // Refund pembayaran sewa
  // ------------------------------------------------------------------

  @Get('orders/:orderId/refunds')
  @ApiOperation({ summary: 'Daftar refund order beserta sisa nilai refundable per payment' })
  async listRefunds(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.ordersService.listRefunds(tenantId, orderId, this.uid(req));
  }

  @Post('orders/:orderId/refunds')
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Ajukan refund pembayaran — REQUESTED, batas dihitung server' })
  async requestRefund(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Body() body: RequestRefundDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.requestRefund(tenantId, orderId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  @Post('refunds/:refundId/approve')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Setujui refund — REQUESTED → APPROVED' })
  async approveRefund(
    @Param('tenantId') tenantId: string,
    @Param('refundId') refundId: string,
    @Body() body: RefundDecisionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.approveRefund(tenantId, refundId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  @Post('refunds/:refundId/record-result')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Catat hasil refund manual — SUCCEEDED | FAILED' })
  async recordRefundResult(
    @Param('tenantId') tenantId: string,
    @Param('refundId') refundId: string,
    @Body() body: RefundResultDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.recordRefundResult(tenantId, refundId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  // ------------------------------------------------------------------
  // Deposit ledger
  // ------------------------------------------------------------------

  @Get('orders/:orderId/deposits')
  @ApiOperation({ summary: 'Saldo deposit + ledger movement + permintaan potongan' })
  async getDeposit(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Req() req: AuthedRequest,
  ) {
    return { data: await this.ordersService.getDeposit(tenantId, orderId, this.uid(req)) };
  }

  @Post('orders/:orderId/deposits')
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Terima deposit — movement RECEIPT (append-only)' })
  async receiveDeposit(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Body() body: DepositReceiptDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.receiveDeposit(tenantId, orderId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  @Post('orders/:orderId/penalties')
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({
    summary: 'Catat denda kerusakan dari inspeksi APPROVED sebagai tagihan order',
  })
  async createPenalty(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Body() body: CreateOrderPenaltyDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.createPenalty(tenantId, orderId, body, this.ctx(req)),
    };
  }

  @Post('orders/:orderId/penalties/:penaltyId/void')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({
    summary: 'Batalkan denda order yang salah tagih (VOIDED + alasan + audit)',
  })
  async voidPenalty(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Param('penaltyId') penaltyId: string,
    @Body() body: VoidOrderPenaltyDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.voidPenalty(
        tenantId,
        orderId,
        penaltyId,
        body,
        this.ctx(req),
      ),
    };
  }

  @Post('orders/:orderId/deposit-deductions')
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Ajukan potongan deposit — PENDING, belum mengubah saldo' })
  async requestDeduction(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Body() body: DepositDeductionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.requestDeduction(tenantId, orderId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  @Post('deposit-deductions/:requestId/approve')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Setujui potongan deposit — aktor berbeda, saldo dicek ulang' })
  async approveDeduction(
    @Param('tenantId') tenantId: string,
    @Param('requestId') requestId: string,
    @Body() body: DepositDecisionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.approveDeduction(tenantId, requestId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  @Post('deposit-deductions/:requestId/reject')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Tolak potongan deposit — PENDING → REJECTED (aktor berbeda)' })
  async rejectDeduction(
    @Param('tenantId') tenantId: string,
    @Param('requestId') requestId: string,
    @Body() body: DepositDecisionDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.rejectDeduction(tenantId, requestId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  @Post('orders/:orderId/deposit-refunds')
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Refund deposit — movement REFUND, tidak menimpa payment sewa' })
  async refundDeposit(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Body() body: DepositRefundDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.refundDeposit(tenantId, orderId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  @Post('orders/:orderId/deposit-movements/:movementId/reverse')
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Reversal movement deposit — sekali per movement, saldo tak negatif' })
  async reverseMovement(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Param('movementId') movementId: string,
    @Body() body: ReverseDepositMovementDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.reverseMovement(tenantId, orderId, movementId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  // ------------------------------------------------------------------
  // Jaminan (collateral) — non-uang; jaminan uang tetap di ledger deposit
  // ------------------------------------------------------------------

  @Get('orders/:orderId/collaterals')
  @ApiOperation({ summary: 'Daftar jaminan order — ID card (utama) + jaminan lain (opsional)' })
  async listCollaterals(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.listCollaterals(tenantId, orderId, this.uid(req)),
    };
  }

  @Post('orders/:orderId/collaterals')
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({
    summary: 'Catat jaminan baru (HELD) — ID_CARD maksimal satu aktif; OTHER bebas jumlah',
  })
  async createCollateral(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Body() body: CreateCollateralDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.createCollateral(tenantId, orderId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  @Post('collaterals/:collateralId/return')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Tandai jaminan sudah dikembalikan — HELD → RETURNED (riwayat tetap)' })
  async returnCollateral(
    @Param('tenantId') tenantId: string,
    @Param('collateralId') collateralId: string,
    @Body() body: ReturnCollateralDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.ordersService.returnCollateral(tenantId, collateralId, body, {
        ...this.ctx(req),
        idempotencyKey: this.idempotencyKey(key),
      }),
    };
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private uid(req: AuthedRequest): string {
    return req.session!.userId;
  }

  private ctx(req: AuthedRequest) {
    return {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    };
  }

  private idempotencyKey(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'Idempotency-Key harus 8-128 karakter (huruf, angka, titik, garis bawah, titik dua, atau strip).',
      );
    }
    return value;
  }
}
