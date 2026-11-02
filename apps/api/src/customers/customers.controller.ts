import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CustomersService } from './customers.service.js';
import { CreateCustomerDto, ListCustomersQueryDto } from './customers.dto.js';
import { CsrfGuard, SessionGuard } from '../auth/auth.guards.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

/**
 * Direktori pelanggan tenant — kontrak Notion 04:
 *   GET  /tenants/:tenantId/customers   → customer.read
 *   POST /tenants/:tenantId/customers   → customer.write
 *
 * Tenant berasal dari path dan diverifikasi lewat membership; tidak ada
 * endpoint lintas tenant.
 */
interface AuthedRequest extends Request {
  session?: SessionInfo;
}

@ApiTags('customer')
@Controller('tenants/:tenantId/customers')
@UseGuards(SessionGuard)
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  @ApiOperation({ summary: 'Daftar pelanggan tenant (pencarian nama/email/nomor)' })
  async listCustomers(
    @Param('tenantId') tenantId: string,
    @Query() query: ListCustomersQueryDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.customersService.listCustomers(
        tenantId,
        query,
        this.requireSession(req),
      ),
    };
  }

  @Post()
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Tambah pelanggan tenant — email/nomor unik per tenant' })
  async createCustomer(
    @Param('tenantId') tenantId: string,
    @Body() body: CreateCustomerDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.customersService.createCustomer(tenantId, body, {
        actorUserId: this.requireSession(req),
        correlationId: req.correlationId,
      }),
    };
  }

  private requireSession(req: AuthedRequest): string {
    if (!req.session) throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    return req.session.userId;
  }
}
