import type { Resend } from 'resend';
import type { EmailAdapter, OutgoingEmail } from './email.service.js';

/**
 * Adapter Resend untuk email transaksional (dokumen 12 — Keputusan standar
 * email transaksional). Modul domain tetap memakai EmailService dan tidak
 * memanggil SDK Resend secara langsung.
 *
 * API key hanya dibaca di server dari environment; tidak pernah dicatat ke log,
 * dikirim ke frontend, atau disimpan di database. Isi email berisi OTP/token
 * sehingga tidak boleh masuk log.
 */
export class ResendEmailAdapter implements EmailAdapter {
  constructor(
    private readonly resend: Resend,
    private readonly from: string,
  ) {}

  async send(email: OutgoingEmail): Promise<void> {
    // Dua bentuk yang saling eksklusif di API Resend: template (id/alias +
    // variabel) atau teks polos. Template dipakai bila domain memintanya;
    // subjek tetap dikirim karena template bisa tidak punya subjek sendiri.
    const { error } = email.template
      ? await this.resend.emails.send({
          from: this.from,
          to: email.to,
          subject: email.subject,
          template: {
            id: email.template.name,
            variables: email.template.variables,
          },
        })
      : await this.resend.emails.send({
          from: this.from,
          to: email.to,
          subject: email.subject,
          text: email.body,
        });

    if (error) {
      // Hanya jenis error provider yang dicatat — bukan isi email/OTP.
      throw new Error(`Resend menolak pengiriman email (${error.name}).`);
    }
  }
}
