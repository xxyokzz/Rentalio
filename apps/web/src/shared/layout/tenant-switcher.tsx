"use client";

import { useSession } from "@/shared/auth/session";
import { Select } from "@/shared/ui/select";

export function TenantSwitcher({ compact }: { compact?: boolean }) {
  const { tenants, tenantId, selectTenant, tenant } = useSession();

  if (tenants.length === 0) return null;

  if (tenants.length === 1) {
    return (
      <span className="text-sm text-muted">
        {tenant?.name ?? tenants[0]?.name ?? "Tenant"}
      </span>
    );
  }

  return (
    <label className="field" style={{ minWidth: compact ? "10rem" : "14rem" }}>
      <span className="sr-only">Pilih tenant</span>
      <Select
        className="select"
        value={tenantId ?? ""}
        onChange={(event) => selectTenant(event.target.value)}
      >
        {tenants.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name ?? item.slug ?? "Tenant"}
            {item.role ? ` · ${item.role}` : ""}
          </option>
        ))}
      </Select>
    </label>
  );
}
