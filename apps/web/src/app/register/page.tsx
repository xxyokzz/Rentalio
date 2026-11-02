import type { Metadata } from "next";
import { AuthSplit } from "@/features/auth/auth-split";
import { RegisterForm } from "@/features/auth/register-form";

export const metadata: Metadata = { title: "Daftar owner" };

export default function Page() {
  return (
    <AuthSplit
      eyebrow="Daftar owner"
      title="Mulai operasional rental yang bisa ditelusuri."
      lede="Buat akun, verifikasi email, lalu aktifkan tenant. Trial 72 jam dihitung sejak tenant aktif."
      points={[
        "Verifikasi email dengan kode OTP 6 digit, berlaku 10 menit.",
        "Tidak meminta nomor telepon, alamat, atau data pajak di awal.",
        "Setelah trial berakhir, transaksi baru dibatasi sampai langganan aktif.",
      ]}
      asideFoot="Kata sandi disimpan sebagai hash oleh backend dan tidak dikirim ke analytics atau log."
    >
      <RegisterForm />
    </AuthSplit>
  );
}
