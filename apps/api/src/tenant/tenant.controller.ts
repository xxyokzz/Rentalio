import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { TenantService } from './tenant.service.js';
import {
  CreateTenantDto,
  InviteMemberDto,
  UpdateMemberDto,
  UpdateTenantSettingsDto,
} from './tenant.dto.js';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

/**
 * Endpoint Tenant — kontrak Notion 04 kelompok "Auth dan tenant":
 *   GET    /tenants               — daftar tenant actor
 *   POST   /tenants               — buat tenant baru (OWNER baru)
 *   GET    /tenants/:id           — detail tenant (member aktif)
 *   PATCH  /tenants/:id/settings  — ubah pengaturan booking/katalog (OWNER)
 *   GET    /tenants/:id/members   — daftar member (OWNER)
 *   POST   /tenants/:id/members   — undang staf (OWNER)
 *   PATCH  /tenants/:id/members/:userId — update role/status member (OWNER)
 */
interface AuthedRequest extends Request {
  session?: SessionInfo;
}

@ApiTags('tenants')
@Controller('tenants')
@UseGuards(SessionGuard)
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Get()
  @ApiOperation({ summary: 'Daftar tenant actor (berdasarkan membership aktif)' })
  async listMyTenants(@Req() req: AuthedRequest) {
    const actorUserId = this.requireSession(req);
    return { data: await this.tenantService.listMyTenants(actorUserId) };
  }

  @Post()
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Buat tenant baru — actor menjadi OWNER, trial 72 jam' })
  async createTenant(
    @Body() body: CreateTenantDto,
    @Req() req: AuthedRequest,
  ) {
    const actorUserId = this.requireSession(req);
    const tenant = await this.tenantService.createTenant(body, {
      actorUserId,
      correlationId: req.correlationId,
    });
    return { data: tenant };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detail tenant (member aktif)' })
  async getTenant(@Param('id') id: string, @Req() req: AuthedRequest) {
    const actorUserId = this.requireSession(req);
    return { data: await this.tenantService.getTenant(id, actorUserId) };
  }

  @Patch(':id/settings')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Perbarui pengaturan booking/katalog tenant (OWNER)' })
  async updateSettings(
    @Param('id') id: string,
    @Body() body: UpdateTenantSettingsDto,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const actorUserId = this.requireSession(req);
    await this.tenantService.updateTenantSettings(id, body, {
      actorUserId,
      correlationId: req.correlationId,
    });
  }

  @Get(':id/members')
  @ApiOperation({ summary: 'Daftar member tenant (OWNER)' })
  async listMembers(@Param('id') id: string, @Req() req: AuthedRequest) {
    const actorUserId = this.requireSession(req);
    return { data: await this.tenantService.listMembers(id, actorUserId) };
  }

  @Post(':id/members')
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Undang staf ke tenant (OWNER)' })
  async inviteMember(
    @Param('id') id: string,
    @Body() body: InviteMemberDto,
    @Req() req: AuthedRequest,
  ) {
    const actorUserId = this.requireSession(req);
    const result = await this.tenantService.inviteMember(id, body, {
      actorUserId,
      correlationId: req.correlationId,
    });
    return { data: result };
  }

  @Patch(':id/members/:userId')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Update role/status member (OWNER)' })
  async updateMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: UpdateMemberDto,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    const actorUserId = this.requireSession(req);
    await this.tenantService.updateMember(id, userId, body, {
      actorUserId,
      correlationId: req.correlationId,
    });
  }

  private requireSession(req: AuthedRequest): string {
    if (!req.session) throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    return req.session.userId;
  }
}
