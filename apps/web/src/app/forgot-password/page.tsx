import type { Metadata } from "next";
import { PasswordResetRequestForm } from "@/features/auth/password-reset-forms";

export const metadata: Metadata = { title: "Lupa kata sandi" };

export default function Page() {
  return (
    <div className="auth-shell">
      <PasswordResetRequestForm />
    </div>
  );
}
