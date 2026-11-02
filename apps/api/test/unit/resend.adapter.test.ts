import { describe, expect, it, vi } from 'vitest';
import type { Resend } from 'resend';
import { ResendEmailAdapter } from '../../src/email/resend.adapter.js';

function fakeResend(send: ReturnType<typeof vi.fn>): Resend {
  return { emails: { send } } as unknown as Resend;
}

describe('ResendEmailAdapter', () => {
  it('mengirim email lewat SDK dengan from yang dikonfigurasi', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    const adapter = new ResendEmailAdapter(
      fakeResend(send),
      'Rentalio <no-reply@rentalio.my.id>',
    );

    await adapter.send({ to: 'owner@contoh.com', subject: 'OTP', body: '123456' });

    expect(send).toHaveBeenCalledWith({
      from: 'Rentalio <no-reply@rentalio.my.id>',
      to: 'owner@contoh.com',
      subject: 'OTP',
      text: '123456',
    });
  });

  it('melempar error tanpa membocorkan isi email saat provider menolak', async () => {
    const send = vi.fn().mockResolvedValue({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'too many requests' },
    });
    const adapter = new ResendEmailAdapter(fakeResend(send), 'a@rentalio.my.id');

    await expect(
      adapter.send({ to: 'owner@contoh.com', subject: 'OTP', body: '654321' }),
    ).rejects.toThrow(/rate_limit_exceeded/);

    await expect(
      adapter.send({ to: 'owner@contoh.com', subject: 'OTP', body: '654321' }),
    ).rejects.not.toThrow(/654321/);
  });

  it('mengirim lewat template Resend bila template disertakan', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'msg_2' }, error: null });
    const adapter = new ResendEmailAdapter(fakeResend(send), 'admin@rentalio.my.id');

    await adapter.send({
      to: 'owner@contoh.com',
      subject: 'Kode verifikasi Rentalio',
      body: 'diabaikan saat memakai template',
      template: {
        name: 'verifrentalio-resend',
        variables: { user_name: 'Budi', otp_code: '123456', otp_expiry_minutes: 10 },
      },
    });

    expect(send).toHaveBeenCalledWith({
      from: 'admin@rentalio.my.id',
      to: 'owner@contoh.com',
      subject: 'Kode verifikasi Rentalio',
      template: {
        id: 'verifrentalio-resend',
        variables: { user_name: 'Budi', otp_code: '123456', otp_expiry_minutes: 10 },
      },
    });
  });
});
