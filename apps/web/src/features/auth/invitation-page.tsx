"use client";

import { useSearchParams } from "next/navigation";
import { InvitationForm } from "./invitation-form";

export function InvitationPage() {
  const params = useSearchParams();
  const token = params.get("token");
  return (
    <div className="auth-shell">
      <InvitationForm token={token} />
    </div>
  );
}
