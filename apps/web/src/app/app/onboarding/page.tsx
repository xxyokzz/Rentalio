import type { Metadata } from "next";
import { OnboardingForm } from "@/features/onboarding/onboarding-form";

export const metadata: Metadata = { title: "Lengkapi data usaha" };

export default function Page() {
  return <OnboardingForm />;
}
