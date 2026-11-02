import { redirect } from "next/navigation";
import { getAdminSession } from "@/shared/api/server";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  const session = await getAdminSession().catch(() => null);
  redirect(session ? "/tenants" : "/login");
}
