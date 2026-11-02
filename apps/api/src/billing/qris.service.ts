import { Inject, Injectable, Logger } from '@nestjs/common';
import QRCode from 'qrcode';
import type { AppConfig } from '../config/env.validation.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import { convertQRIS, parseQRIS, validateQRIS } from './qris/index.js';

/**
 * QRIS dinamis untuk pembayaran langganan tenant → Rentalio.
 *
 * Platform menyimpan **satu QRIS statis** milik merchant Rentalio
 * (`PLATFORM_QRIS_STATIC_PAYLOAD`). Untuk setiap tagihan, string itu diubah
 * menjadi QRIS dinamis yang sudah memuat nominal — penyewa cukup memindai dan
 * membayar, tanpa mengetik ulang nominal.
 *
 * Tidak ada panggilan jaringan dan tidak ada webhook: QRIS dinamis hanya
 * membawa data, bukan status pembayaran. Karena itu status lunas **tidak pernah**
 * ditetapkan otomatis; operator platform menandainya lewat Admin Platform
 * setelah dana terverifikasi (lihat `BillingSettlementService.settle`).
 *
 * Konversi memakai library `qris-dinamis` (MIT) yang di-port ke `./qris/`.
 */
@Injectable()
export class QrisService {
  private readonly logger = new Logger(QrisService.name);
  /** Nama merchant dari payload statis; di-cache setelah validasi pertama. */
  private merchantName: string | null = null;

  constructor(@Inject('APP_CONFIG') private readonly config: AppConfig) {}

  /** Pembayaran QRIS hanya bisa dibuat bila QRIS statis platform tersedia. */
  get configured(): boolean {
    return Boolean(this.config.PLATFORM_QRIS_STATIC_PAYLOAD);
  }

  /** Nama merchant yang tertanam pada QRIS statis (null bila belum/tidak valid). */
  get merchant(): string | null {
    return this.merchantName;
  }

  /**
   * Bangun QRIS dinamis + gambar QR (data URL PNG) untuk satu nominal.
   *
   * Payload statis divalidasi (header, CRC, tag wajib) sebelum dikonversi;
   * payload yang rusak tidak pernah menghasilkan QR yang bisa dipindai —
   * kegagalan konfigurasi dijawab `503 BILLING_NOT_CONFIGURED`, bukan QR
   * setengah jadi.
   */
  async render(amount: number): Promise<{ payload: string; imageDataUrl: string }> {
    const staticPayload = this.config.PLATFORM_QRIS_STATIC_PAYLOAD?.trim();
    if (!staticPayload) {
      throw new ApiError(
        ErrorCode.BILLING_NOT_CONFIGURED,
        'Pembayaran QRIS belum diaktifkan. Hubungi tim Rentalio.',
      );
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new ApiError(
        ErrorCode.BILLING_NOT_CONFIGURED,
        'Harga langganan belum diatur. Hubungi tim Rentalio.',
      );
    }

    if (!this.merchantName) {
      const validation = validateQRIS(staticPayload);
      if (!validation.valid) {
        // Alasan teknis hanya masuk log; klien mendapat pesan operasional.
        this.logger.error(
          `PLATFORM_QRIS_STATIC_PAYLOAD tidak valid: ${validation.errors.join('; ')}`,
        );
        throw new ApiError(
          ErrorCode.BILLING_NOT_CONFIGURED,
          'Konfigurasi QRIS platform tidak valid. Hubungi tim Rentalio.',
        );
      }
      this.merchantName = parseQRIS(staticPayload).merchantName || null;
    }

    let payload: string;
    try {
      payload = convertQRIS(staticPayload, { amount });
    } catch (error) {
      this.logger.error(
        `gagal mengubah QRIS statis menjadi dinamis: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ApiError(
        ErrorCode.BILLING_NOT_CONFIGURED,
        'Konfigurasi QRIS platform tidak valid. Hubungi tim Rentalio.',
      );
    }

    const imageDataUrl = await QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 512,
      color: { dark: '#111111', light: '#ffffff' },
    });

    return { payload, imageDataUrl };
  }
}
