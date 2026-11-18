import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PublicService } from './public.service.js';
import {
  CreatePublicBookingDto,
  PortalExtensionRequestDto,
  PortalInspectionDisputeDto,
  PublicAvailabilityQueryDto,
  PublicHostQueryDto,
} from './public.dto.js';
import { ApiError, ErrorCode } from '../common/errors.js';

/**
 * Endpoint publik penyewa (Notion 14) — tanpa sesi:
 *   GET  /public/resolve-host?host=…      → tenant dari domain kustom
 *   GET  /public/:tenantSlug/catalog
 *   GET  /public/:tenantSlug/catalog-config
 *   GET  /public/:tenantSlug/products/:productId
 *   GET  /public/:tenantSlug/availability
 *   POST /public/:tenantSlug/bookings
 *
 * Semua data berasal dari tenant aktif yang diresolusi lewat slug. Tidak ada
 * tenantId, harga, atau status yang diterima dari client.
 */
@ApiTags('public')
@Controller('public')
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  /**
   * Dipakai halaman publik server-side untuk membuka katalog langsung dari
   * hostname tenant (mis. https://sewa-kamera.com/). Hanya domain yang sudah
   * diverifikasi + aktif; kegagalan apa pun dijawab 404 netral.
   */
  @Get('resolve-host')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Resolusi tenant dari hostname kustom terverifikasi' })
  async resolveHost(@Query() query: PublicHostQueryDto, @Req() req: Request) {
    return { data: await this.publicService.resolveDomain(query.host, this.ip(req)) };
  }

  /**
   * Identitas publik tenant berdasarkan slug subdomain platform.
   * Dipakai web server-side untuk menolak subdomain yang tidak pernah
   * terdaftar, sehingga `{apa-saja}.rentalio.my.id` tidak lagi menampilkan
   * halaman tenant. Tenant non-aktif dijawab 404 netral seperti katalog.
   */
  @Get('tenants/:tenantSlug')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Identitas publik tenant berdasarkan slug subdomain' })
  async tenantBySlug(@Param('tenantSlug') tenantSlug: string, @Req() req: Request) {
    return { data: await this.publicService.getPublicTenantBySlug(tenantSlug, this.ip(req)) };
  }

  @Get(':tenantSlug/catalog')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Katalog publik tenant (produk aktif + kategori)' })
  async catalog(@Param('tenantSlug') tenantSlug: string, @Req() req: Request) {
    return { data: await this.publicService.getCatalog(tenantSlug, this.ip(req)) };
  }

  /**
   * Konfigurasi presentasi katalog yang sudah dipublikasikan tenant
   * (Notion 06 WEB-07). Bila belum ada publish, konfigurasi default dipakai.
   */
  @Get(':tenantSlug/catalog-config')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Konfigurasi presentasi live katalog publik tenant' })
  async catalogConfig(@Param('tenantSlug') tenantSlug: string, @Req() req: Request) {
    return { data: await this.publicService.getCatalogConfig(tenantSlug, this.ip(req)) };
  }

  @Get(':tenantSlug/products/:productId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Detail produk publik yang aktif' })
  async product(
    @Param('tenantSlug') tenantSlug: string,
    @Param('productId') productId: string,
    @Req() req: Request,
  ) {
    return { data: await this.publicService.getProduct(tenantSlug, productId, this.ip(req)) };
  }

  @Get(':tenantSlug/availability')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Cek ketersediaan publik untuk periode [mulai, selesai)' })
  async availability(
    @Param('tenantSlug') tenantSlug: string,
    @Query() query: PublicAvailabilityQueryDto,
    @Req() req: Request,
  ) {
    return {
      data: await this.publicService.checkAvailability(
        tenantSlug,
        query.productId,
        query.startAt,
        query.endAt,
        this.ip(req),
      ),
    };
  }

  @Post(':tenantSlug/bookings')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Booking tamu — manual: PENDING_APPROVAL; otomatis: check-and-allocate',
  })
  async createBooking(
    @Param('tenantSlug') tenantSlug: string,
    @Body() body: CreatePublicBookingDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
  ) {
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'Idempotency-Key harus 8-128 karakter (huruf, angka, titik, garis bawah, titik dua, atau strip).',
      );
    }
    return {
      data: await this.publicService.createBooking(tenantSlug, body, {
        ip: this.ip(req),
        correlationId: req.correlationId,
        idempotencyKey,
      }),
    };
  }

  private ip(req: Request): string {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }
}

/**
 * Portal pesanan tamu — akses hanya dengan token acak pada path.
 * Token tidak pernah masuk log (lihat RequestLoggingMiddleware) dan tidak
 * memberi akses ke resource tenant lain.
 */
@ApiTags('portal')
@Controller('portal')
export class PortalController {
  constructor(private readonly publicService: PublicService) {}

  @Get('orders/:token')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Status pesanan untuk penyewa (token terbatas satu pesanan)' })
  async order(@Param('token') token: string, @Req() req: Request) {
    return {
      data: await this.publicService.getPortalOrder(
        token,
        req.ip || req.socket?.remoteAddress || 'unknown',
      ),
    };
  }

  /**
   * Pengajuan perpanjangan dari penyewa. Biaya dan periode dihitung server;
   * permintaan tetap PENDING_APPROVAL dan tidak mengubah jadwal sampai
   * diputuskan staff lewat command approve/reject internal.
   */
  @Post('orders/:token/inspections/:inspectionId/dispute')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Sanggah hasil inspeksi lewat token pesanan' })
  async disputeInspection(
    @Param('token') token: string,
    @Param('inspectionId') inspectionId: string,
    @Body() body: PortalInspectionDisputeDto,
    @Req() req: Request,
  ) {
    return {
      data: await this.publicService.disputePortalInspection(token, inspectionId, body, {
        ip: req.ip || req.socket?.remoteAddress || 'unknown',
        correlationId: req.correlationId,
      }),
    };
  }

  @Post('orders/:token/extensions')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Ajukan perpanjangan sewa lewat token pesanan' })
  async requestExtension(
    @Param('token') token: string,
    @Body() body: PortalExtensionRequestDto,
    @Req() req: Request,
  ) {
    return {
      data: await this.publicService.requestPortalExtension(token, body, {
        ip: req.ip || req.socket?.remoteAddress || 'unknown',
        correlationId: req.correlationId,
      }),
    };
  }
}
