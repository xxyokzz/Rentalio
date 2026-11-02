import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Health endpoint: hanya status layanan, tanpa rahasia atau detail internal
 * (dokumen 12 S0-02). /health untuk liveness, /health/ready cek database.
 */
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  @ApiOperation({ summary: 'Liveness — tanpa cek dependensi' })
  health(): { status: string } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  @ApiOperation({ summary: 'Readiness — cek koneksi database' })
  async ready(): Promise<{ status: string; database: string }> {
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'ok' };
    } catch {
      return { status: 'degraded', database: 'unavailable' };
    }
  }
}
