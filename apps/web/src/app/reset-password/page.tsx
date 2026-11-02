import { Suspense } from "react";
import type { Metadata } from "next";
import { ResetPasswordPage } from "@/features/auth/reset-password-page";
import { LoadingBlock } from "@/shared/ui/states";

export const metadata: Metadata = { title: "Atur kata sandi baru" };

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="auth-shell">
          <div className="auth-card">
            <LoadingBlock rows={2} />
          </div>
        </div>
      }
    >
      <ResetPasswordPage />
    </Suspense>
  );
}
