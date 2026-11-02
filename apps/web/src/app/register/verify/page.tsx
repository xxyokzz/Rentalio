import type { Metadata } from "next";
import { OtpForm } from "@/features/auth/otp-form";

export const metadata: Metadata = { title: "Verifikasi email" };

export default function Page() {
  return (
    <div className="auth-shell">
      <OtpForm />
    </div>
  );
}
