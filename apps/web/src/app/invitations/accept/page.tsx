import { Suspense } from "react";
import type { Metadata } from "next";
import { InvitationPage } from "@/features/auth/invitation-page";
import { LoadingBlock } from "@/shared/ui/states";

export const metadata: Metadata = { title: "Terima undangan staf" };

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
      <InvitationPage />
    </Suspense>
  );
}
