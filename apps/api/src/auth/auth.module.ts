import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { EmailModule } from '../email/email.module.js';
import { RateLimitModule } from '../rate-limit/rate-limit.module.js';
import { AuthService } from './auth.service.js';
import { AccountController, AuthController } from './auth.controller.js';
import { CsrfGuard, SessionGuard } from './auth.guards.js';

@Module({
  imports: [ConfigModule, PrismaModule, AuditModule, EmailModule, RateLimitModule],
  controllers: [AuthController, AccountController],
  providers: [AuthService, SessionGuard, CsrfGuard],
  exports: [AuthService],
})
export class AuthModule {}
