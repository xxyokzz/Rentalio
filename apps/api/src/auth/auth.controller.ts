import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import {
  AuthService,
  SESSION_COOKIE,
  type SessionInfo,
} from './auth.service.js';
import { CsrfGuard } from './auth.guards.js';
import {
  AcceptInvitationDto,
  CompletePasswordResetDto,
  LoginDto,
  RegisterDto,
  RequestPasswordResetDto,
  ResendOtpDto,
  VerifyEmailDto,
} from './auth.dto.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { AppConfig } from '../config/env.validation.js';

/**
 * Kontrak endpoint auth (dikunci, dokumen 03 bagian "Kontrak OpenAPI"):
 * POST   /auth/registrations
 * POST   /auth/registrations/verify-email
 * POST   /auth/registrations/resend-otp
 * POST   /auth/sessions
 * GET    /auth/sessions/current
 * GET    /auth/csrf
 * DELETE /auth/sessions/current
 * POST   /auth/password-resets
 * POST   /auth/password-resets/complete
 *
 * Cookie sesi: rentalio_session; HttpOnly; Secure; SameSite=Lax; Path=/;
 * Domain mengikuti SESSION_COOKIE_DOMAIN bila di-set (production: domain
 * platform) agar sesi tetap berlaku saat pengguna dipindah ke subdomain tenant;
 * kosong berarti host-only (localhost). Mutasi sesi wajib X-CSRF-Token +
 * validasi Origin.
 */

interface AuthedRequest extends Request {
  session?: SessionInfo;
  csrfOk?: boolean;
}

/** Bentuk `user` pada respons login & sesi aktif (SessionResponse). */
type SessionUser = {
  email: string;
  ownerName: string | null;
  tenantName: string | null;
  tenantSlug: string | null;
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  @Post('registrations')
  @HttpCode(202)
  @ApiOperation({ summary: 'Daftar OWNER — kirim OTP email, respons generik' })
  async register(
    @Body() body: RegisterDto,
    @Req() req: AuthedRequest,
  ): Promise<{ status: 202 }> {
    return this.auth.register(
      {
        email: body?.email,
        password: body?.password,
        ownerName: body?.ownerName,
        tenantName: body?.tenantName,
        tenantSlug: body?.tenantSlug,
        termsVersion: body?.termsVersion,
        privacyVersion: body?.privacyVersion,
      },
      { ip: req.ip ?? 'unknown', correlationId: req.correlationId },
    );
  }

  @Post('registrations/verify-email')
  @HttpCode(204)
  @ApiOperation({ summary: 'Verifikasi kode OTP — tidak otomatis login' })
  async verifyEmail(
    @Body() body: VerifyEmailDto,
    @Req() req: AuthedRequest,
  ): Promise<{ status: 204 }> {
    return this.auth.verifyEmail(
      { email: body?.email, code: body?.code },
      { ip: req.ip ?? 'unknown', correlationId: req.correlationId },
    );
  }

  @Post('registrations/resend-otp')
  @HttpCode(202)
  @ApiOperation({ summary: 'Kirim ulang OTP — respons generik' })
  async resendOtp(
    @Body() body: ResendOtpDto,
    @Req() req: AuthedRequest,
  ): Promise<{ status: 202 }> {
    return this.auth.resendOtp(
      { email: body?.email },
      { ip: req.ip ?? 'unknown', correlationId: req.correlationId },
    );
  }

  @Post('sessions')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login — rotasi session ID, Set-Cookie' })
  async login(
    @Body() body: LoginDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: SessionUser }> {
    const issued = await this.auth.login(
      { email: body?.email, password: body?.password },
      { ip: req.ip ?? 'unknown', correlationId: req.correlationId },
    );
    res.cookie(SESSION_COOKIE, issued.token, {
      ...this.sessionCookieOptions(),
      expires: issued.absoluteExpiresAt,
    });
    // CSRF token dikirim via header agar mudah dibaca frontend.
    res.setHeader('X-CSRF-Token', issued.csrfToken);
    return {
      user: {
        email: body.email.trim().toLowerCase(),
        ownerName: issued.profile.ownerName,
        tenantName: issued.profile.tenantName,
        tenantSlug: issued.profile.tenantSlug,
      },
    };
  }

  @Get('sessions/current')
  @ApiOperation({ summary: 'Sesi aktif' })
  async current(@Req() req: AuthedRequest): Promise<{ user: SessionUser }> {
    if (!req.session) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Sesi tidak valid.');
    }
    return {
      user: {
        email: req.session.email,
        ownerName: req.session.ownerName,
        tenantName: req.session.tenantName,
        tenantSlug: req.session.tenantSlug,
      },
    };
  }

  @Get('csrf')
  @ApiOperation({ summary: 'Terbitkan token CSRF baru untuk sesi aktif' })
  async csrf(@Req() req: AuthedRequest): Promise<{ csrfToken: string }> {
    if (!req.session) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Sesi tidak valid.');
    }
    // Token terikat sesi: hash disimpan di authSession, token mentah hanya
    // dikembalikan ke klien. Penerbitan baru membatalkan token sebelumnya.
    return { csrfToken: await this.auth.rotateCsrf(req.session.id) };
  }

  @Delete('sessions/current')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Logout — cabut sesi (wajib X-CSRF-Token)' })
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 204 }> {
    if (!req.session) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Sesi tidak valid.');
    }
    await this.auth.logout(req.session.id, req.correlationId);
    res.clearCookie(SESSION_COOKIE, this.sessionCookieOptions());
    return { status: 204 };
  }

  @Post('password-resets')
  @HttpCode(202)
  @ApiOperation({ summary: 'Minta tautan reset — respons generik' })
  async requestReset(
    @Body() body: RequestPasswordResetDto,
    @Req() req: AuthedRequest,
  ): Promise<{ status: 202 }> {
    return this.auth.requestPasswordReset(
      { email: body?.email },
      { ip: req.ip ?? 'unknown', correlationId: req.correlationId },
    );
  }

  @Post('password-resets/complete')
  @HttpCode(204)
  @ApiOperation({ summary: 'Selesaikan reset — konsumsi token, cabut sesi' })
  async completeReset(
    @Body() body: CompletePasswordResetDto,
    @Req() req: AuthedRequest,
  ): Promise<{ status: 204 }> {
    return this.auth.completePasswordReset(
      { token: body?.token, newPassword: body?.newPassword },
      { ip: req.ip ?? 'unknown', correlationId: req.correlationId },
    );
  }

  @Post('invitations/accept')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Terima undangan staf — tukar token sekali pakai menjadi akun + membership',
  })
  async acceptInvitation(
    @Body() body: AcceptInvitationDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.auth.acceptInvitation(
        { token: body.token, password: body.password },
        { ip: req.ip ?? 'unknown', correlationId: req.correlationId },
      ),
    };
  }

  private cookieSecure(): boolean {
    // Ikuti konfigurasi; secure=false hanya untuk http lokal dev/test.
    return process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  }

  /** Opsi cookie sesi; dipakai saat menetapkan maupun menghapus (harus sama). */
  private sessionCookieOptions(): CookieOptions {
    const domain = this.config.SESSION_COOKIE_DOMAIN;
    return {
      httpOnly: true,
      secure: this.cookieSecure(),
      sameSite: 'lax',
      path: '/',
      ...(domain ? { domain } : {}),
    };
  }
}

/**
 * Endpoint akun self-service di root path (kontrak `GET /me`). Ditempatkan di
 * modul auth karena hanya membaca identitas sesi yang sudah divalidasi
 * middleware; tidak ada parameter yang bisa dipakai membaca akun lain.
 */
@ApiTags('account')
@Controller()
export class AccountController {
  constructor(private readonly auth: AuthService) {}

  @Get('me')
  @ApiOperation({ summary: 'Profil akun pengguna aktif (self-service)' })
  async me(@Req() req: AuthedRequest): Promise<{ data: unknown }> {
    if (!req.session) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Sesi tidak valid.');
    }
    return { data: await this.auth.getAccount(req.session.userId) };
  }
}
