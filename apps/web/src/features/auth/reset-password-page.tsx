"use client";

import { useSearchParams } from "next/navigation";
import { PasswordResetCompleteForm } from "./password-reset-forms";

export function ResetPasswordPage() {
  const params = useSearchParams();
  const token = params.get("token");
  return (
    <div className="auth-shell">
      <PasswordResetCompleteForm token={token} />
    </div>
  );
}
