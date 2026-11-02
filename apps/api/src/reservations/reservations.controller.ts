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
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ReservationsService } from './reservations.service.js';
import {
  AvailabilityQueryDto,
  CancelReservationDto,
  ConfirmReservationDto,
  CreateReservationDto,
  RejectReservationDto,
} from './reservations.dto.js';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards.js';
import { BlockInRestrictedMode } from '../subscriptions/subscription.decorator.js';
import { SubscriptionGuard } from '../subscriptions/subscription.guard.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

/**
 * Reservasi & ketersediaan — Notion 04 "Booking, POS, dan sewa" +
 * "Inventaris dan ketersediaan":
 *   GET    /tenants/:tenantId/reservations
 *   POST   /tenants/:tenantId/reservations
 *   GET    /tenants/:tenantId/reservations/:reservationId
 *   POST   /tenants/:tenantId/reservations/:reservationId/confirm
 *   POST   /tenants/:tenantId/reservations/:reservationId/reject
 *   POST   /tenants/:tenantId/reservations/:reservationId/cancel
 *   GET    /tenants/:tenantId/availability
 *
 * Semua endpoint memerlukan sesi aktif; mutasi memerlukan CSRF token.
 * Tidak ada PATCH status bebas — transisi hanya lewat command (ADR-001).
 * Konversi ke order (`convert-to-order`) di luar cakupan Sprint 2.
 */
interface AuthedRequest extends Request {
  session?: SessionInfo;
}

@ApiTags('reservation')
@Controller('tenants/:tenantId')
@UseGuards(SessionGuard)
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  // ------------------------------------------------------------------
  // Ketersediaan
  // ------------------------------------------------------------------

  @Get('availability')
  @ApiOperation({ summary: 'Cek ketersediaan produk untuk periode (read-only)' })
  @ApiQuery({ name: 'productId', required: true })
  @ApiQuery({ name: 'startAt', required: true, description: 'ISO 8601' })
  @ApiQuery({ name: 'endAt', required: true, description: 'ISO 8601' })
  async checkAvailability(
    @Param('tenantId') tenantId: string,
    @Query() query: AvailabilityQueryDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.reservationsService.checkAvailability(
        tenantId,
        query,
        this.uid(req),
      ),
    };
  }

  // ------------------------------------------------------------------
  // Reservasi
  // ------------------------------------------------------------------

  @Get('reservations')
  @ApiOperation({ summary: 'Daftar reservasi tenant (diurutkan periode mulai)' })
  async listReservations(
    @Param('tenantId') tenantId: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.reservationsService.listReservations(tenantId, this.uid(req)),
    };
  }

  @Post('reservations')
  @HttpCode(201)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({
    summary: 'Buat reservasi — manual: PENDING_APPROVAL; otomatis: check-and-allocate atomik',
  })
  async createReservation(
    @Param('tenantId') tenantId: string,
    @Body() body: CreateReservationDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'Idempotency-Key harus 8-128 karakter (huruf, angka, titik, garis bawah, titik dua, atau strip).',
      );
    }
    const data = await this.reservationsService.createReservation(tenantId, body, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
      idempotencyKey,
    });
    return { data };
  }

  @Get('reservations/:reservationId')
  @ApiOperation({ summary: 'Detail reservasi beserta item dan alokasi' })
  async getReservation(
    @Param('tenantId') tenantId: string,
    @Param('reservationId') reservationId: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.reservationsService.getReservation(
        tenantId,
        reservationId,
        this.uid(req),
      ),
    };
  }

  @Post('reservations/:reservationId/confirm')
  @HttpCode(200)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({
    summary: 'Konfirmasi reservasi — PENDING_APPROVAL → CONFIRMED (cek ulang ketersediaan)',
  })
  async confirmReservation(
    @Param('tenantId') tenantId: string,
    @Param('reservationId') reservationId: string,
    @Body() body: ConfirmReservationDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.reservationsService.confirmReservation(
      tenantId,
      reservationId,
      body,
      {
        actorUserId: this.uid(req),
        correlationId: req.correlationId,
      },
    );
    return { data };
  }

  @Post('reservations/:reservationId/reject')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Tolak reservasi — PENDING_APPROVAL → REJECTED (OWNER/MANAGER)' })
  async rejectReservation(
    @Param('tenantId') tenantId: string,
    @Param('reservationId') reservationId: string,
    @Body() body: RejectReservationDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.reservationsService.rejectReservation(
      tenantId,
      reservationId,
      body,
      {
        actorUserId: this.uid(req),
        correlationId: req.correlationId,
      },
    );
    return { data };
  }

  @Post('reservations/:reservationId/cancel')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({
    summary: 'Batalkan reservasi — nonterminal → CANCELLED, alokasi dilepas atomik',
  })
  async cancelReservation(
    @Param('tenantId') tenantId: string,
    @Param('reservationId') reservationId: string,
    @Body() body: CancelReservationDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.reservationsService.cancelReservation(
      tenantId,
      reservationId,
      body,
      {
        actorUserId: this.uid(req),
        correlationId: req.correlationId,
      },
    );
    return { data };
  }

  // ------------------------------------------------------------------
  // Helper
  // ------------------------------------------------------------------

  private uid(req: AuthedRequest): string {
    if (!req.session) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    }
    return req.session.userId;
  }
}
