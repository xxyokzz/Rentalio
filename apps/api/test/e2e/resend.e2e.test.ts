/**
 * E2E Resend — memakai template OTP yang sudah dibuat di akun Resend
 * (`verifrentalio-resend`, dapat diubah lewat `RESEND_OTP_TEMPLATE`).
 *
 * Test ini benar-benar memanggil API Resend (bukan mock), jadi:
 * - hanya berjalan bila `RESEND_E2E=1` dan `RESEND_API_KEY` tersedia;
 * - penerima memakai alamat uji Resend `delivered@resend.dev`, bukan inbox
 *   nyata, agar tidak mengirim email ke orang sungguhan.
 *
 * Jalankan: `RESEND_E2E=1 pnpm --filter @rentalio/api test:e2e:resend`
 */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { Resend } from 'resend';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/env.validation.js';
import { EmailService } from '../../src/email/email.service.js';
import { ResendEmailAdapter } from '../../src/email/resend.adapter.js';

// Muat .env root repo; nilai yang sudah ada di environment shell tetap menang.
loadEnv({ path: resolve(process.cwd(), '../../.env') });

const API_KEY = process.env.RESEND_API_KEY?.trim() ?? '';
const TEMPLATE_NAME = process.env.RESEND_OTP_TEMPLATE?.trim() || 'verifrentalio-resend';
const RECIPIENT = 'delivered@resend.dev';
const OTP_CODE = '830471';
const RECIPIENT_NAME = 'Uji E2E Rentalio';
const OTP_SUBJECT = 'Kode verifikasi Rentalio';

const enabled = process.env.RESEND_E2E === '1' && API_KEY !== '';
const describeE2E = enabled ? describe : describe.skip;

/** Konfigurasi nyata dari .env, dipaksa memakai provider Resend. */
function buildConfig() {
  return validateConfig({
    ...process.env,
    // E2E hanya menguji jalur email: matikan aturan production dan isian yang
    // tidak relevan agar kegagalan konfigurasi lain tidak menyamarkan hasil.
    NODE_ENV: 'development',
    EMAIL_PROVIDER: 'resend',
    // Shell induk bisa membawa PORT=0; test ini tidak membuka listener.
    PORT: '3000',
    PLATFORM_QRIS_STATIC_PAYLOAD: '',
    PLATFORM_ADMIN_ENCRYPTION_KEY: '',
  });
}

async function pollEmail(
  resend: Resend,
  predicate: (item: { id: string; subject: string; to: string[]; created_at: string }) => boolean,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: string[] = [];
  while (Date.now() < deadline) {
    const { data, error } = await resend.emails.list({ limit: 20 });
    if (error) throw new Error(`Gagal membaca daftar email Resend (${error.name}).`);
    const match = data?.data?.find(predicate);
    if (match) return match.id;
    lastSeen = (data?.data ?? []).map((e) => `${e.subject} → ${e.to.join(',')}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    `Email e2e tidak muncul di Resend dalam ${timeoutMs} ms. Terakhir terlihat: ` +
      (lastSeen.length > 0 ? lastSeen.slice(0, 5).join(' | ') : '(kosong)'),
  );
}

describeE2E('Resend e2e (template OTP nyata)', () => {
  const config = buildConfig();
  const resend = new Resend(API_KEY);
  const sentAt = new Date();

  it('template OTP ada di akun Resend dan berstatus published', async () => {
    const { data, error } = await resend.templates.get(TEMPLATE_NAME);
    if (error) {
      throw new Error(
        `Template "${TEMPLATE_NAME}" tidak dapat dibaca (${error.name}). ` +
          'Pastikan nama/alias template benar dan API key memiliki akses templates.',
      );
    }
    expect(data?.name).toBe(TEMPLATE_NAME);
    expect(data?.status).toBe('published');
  });

  it('email OTP terkirim lewat template dan tervalidasi Resend sebagai delivered', async () => {
    const email = new EmailService(config);

    await email.sendOtp({
      to: RECIPIENT,
      code: OTP_CODE,
      recipientName: RECIPIENT_NAME,
      expiresInMinutes: 10,
    });

    const id = await pollEmail(
      resend,
      (item) =>
        item.subject === OTP_SUBJECT &&
        item.to.includes(RECIPIENT) &&
        new Date(`${item.created_at}Z`).getTime() >= sentAt.getTime() - 60_000,
      30_000,
    );

    // Tunggu status akhir pengiriman (delivered/bounced) bila masih queued/sent.
    let detail = (await resend.emails.get(id)).data;
    const deadline = Date.now() + 30_000;
    while (
      detail &&
      ['queued', 'scheduled', 'sent'].includes(detail.last_event) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 2_000));
      detail = (await resend.emails.get(id)).data;
    }

    expect(detail?.last_event).toBe('delivered');
    expect(detail?.to).toEqual([RECIPIENT]);
    expect(detail?.from).toBe(config.EMAIL_FROM);
    expect(detail?.subject).toBe(OTP_SUBJECT);

    // Template benar-benar ter-render: OTP dan nama muncul, tanpa placeholder mentah.
    expect(detail?.html).toContain(OTP_CODE);
    expect(detail?.html).toContain(RECIPIENT_NAME);
    expect(detail?.html).not.toContain('{{{');
    // Versi plain-text ikut ter-render (sebelumnya memakai {{{OTP_CODE}}} → kosong).
    expect(detail?.text ?? '').toBeTruthy();
    expect(detail?.text).toContain(OTP_CODE);
    expect(detail?.text).toContain(RECIPIENT_NAME);
    expect(detail?.text).not.toContain('{{{');
  });

  it('API key tidak valid ditolak tanpa membocorkan isi email', async () => {
    const adapter = new ResendEmailAdapter(
      new Resend('re_invalid_key_for_e2e'),
      config.EMAIL_FROM,
    );

    await expect(
      adapter.send({
        to: RECIPIENT,
        subject: OTP_SUBJECT,
        body: `Kode verifikasi Anda: ${OTP_CODE}.`,
        template: {
          name: TEMPLATE_NAME,
          variables: { user_name: RECIPIENT_NAME, otp_code: OTP_CODE, otp_expiry_minutes: 10 },
        },
      }),
    ).rejects.not.toThrow(new RegExp(OTP_CODE));
  });
});
