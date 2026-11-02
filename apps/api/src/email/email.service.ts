import { Inject, Injectable } from '@nestjs/common';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resend } from 'resend';
import type { AppConfig } from '../config/env.validation.js';
import { ResendEmailAdapter } from './resend.adapter.js';

/**
 * Adapter email. MVP: dev-file (tulis ke .dev-mailbox) dan in-memory (test).
 * Provider produksi (SMTP/API) menyusul di balik interface yang sama —
 * domain logic tidak mengetahui provider (dokumen 10).
 *
 * PENTING: body email berisi OTP/token. Jangan pernah mencatat isi email
 * ke application log (dokumen 10: jangan mencatat OTP/token mentah di log).
 * File .dev-mailbox hanya untuk development lokal dan masuk .gitignore.
 */
export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  /**
   * Template provider (nama/alias template Resend) + variabelnya. Adapter yang
   * tidak mendukung template memakai `body` polos, jadi jalur dev/test tetap
   * menampilkan kode yang sama tanpa bergantung pada Resend.
   */
  template?: {
    name: string;
    variables: Record<string, string | number>;
  };
}

export interface EmailAdapter {
  send(email: OutgoingEmail): Promise<void>;
}

export class InMemoryEmailAdapter implements EmailAdapter {
  readonly sent: OutgoingEmail[] = [];

  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }

  /** Ambil OTP terakhir yang dikirim ke alamat tertentu (untuk test). */
  lastOtpFor(to: string): string | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].to.toLowerCase() === to.toLowerCase()) {
        const m = this.sent[i].body.match(/\b\d{6}\b/);
        if (m) return m[0];
      }
    }
    return null;
  }
}

export class DevFileEmailAdapter implements EmailAdapter {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async send(email: OutgoingEmail): Promise<void> {
    const line = JSON.stringify({ ...email, sentAt: new Date().toISOString() });
    appendFileSync(join(this.dir, 'outbox.jsonl'), line + '\n');
  }
}

export interface OtpEmailInput {
  to: string;
  code: string;
  /** Nama penerima untuk sapaan di template; jatuh ke bagian lokal email. */
  recipientName?: string | null;
  expiresInMinutes: number;
}

/**
 * Subjek email OTP. Template Resend juga punya subjek; nilainya sengaja
 * disamakan agar klien yang memakai teks polos (dev-file) melihat subjek yang
 * sama dengan produksi.
 */
const OTP_SUBJECT = 'Kode verifikasi Rentalio';

@Injectable()
export class EmailService {
  private readonly adapter: EmailAdapter;
  private readonly inMemory: InMemoryEmailAdapter | null;
  /** Nama/alias template OTP di provider; string kosong = pakai body polos. */
  private readonly otpTemplateName: string;

  constructor(@Inject('APP_CONFIG') config: AppConfig) {
    this.otpTemplateName = config.RESEND_OTP_TEMPLATE?.trim() ?? '';
    if (config.EMAIL_PROVIDER === 'in-memory') {
      const mem = new InMemoryEmailAdapter();
      this.adapter = mem;
      this.inMemory = mem;
    } else if (config.EMAIL_PROVIDER === 'resend') {
      // Validasi env sudah memastikan RESEND_API_KEY terisi saat provider ini
      // dipilih, jadi tidak perlu fallback diam-diam ke adapter lain.
      this.adapter = new ResendEmailAdapter(
        new Resend(config.RESEND_API_KEY),
        config.EMAIL_FROM,
      );
      this.inMemory = null;
    } else {
      this.adapter = new DevFileEmailAdapter(join(process.cwd(), '.dev-mailbox'));
      this.inMemory = null;
    }
  }

  send(email: OutgoingEmail): Promise<void> {
    return this.adapter.send(email);
  }

  /**
   * Email OTP verifikasi. Satu tempat menyusun isi teks + variabel template
   * (nama template dari konfigurasi), sehingga alur registrasi dan test e2e
   * memakai komposisi yang persis sama.
   */
  sendOtp(input: OtpEmailInput): Promise<void> {
    const recipientName = input.recipientName?.trim() || input.to.split('@')[0];
    return this.adapter.send({
      to: input.to,
      subject: OTP_SUBJECT,
      body:
        `Kode verifikasi Anda: ${input.code}. Berlaku ${input.expiresInMinutes} menit. ` +
        'Jangan bagikan kode ini kepada siapa pun.',
      template: this.otpTemplateName
        ? {
            name: this.otpTemplateName,
            variables: {
              user_name: recipientName,
              otp_code: input.code,
              otp_expiry_minutes: input.expiresInMinutes,
            },
          }
        : undefined,
    });
  }

  /** Hanya untuk test. */
  get testAdapter(): InMemoryEmailAdapter | null {
    return this.inMemory;
  }
}
