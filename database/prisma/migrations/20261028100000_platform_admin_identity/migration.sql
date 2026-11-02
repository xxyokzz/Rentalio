-- Platform Admin identity is deliberately separate from tenant users/memberships.
CREATE TYPE "PlatformAdminStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TABLE "platform_admin_users" (
  "id" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "status" "PlatformAdminStatus" NOT NULL DEFAULT 'ACTIVE',
  "totpSecretEncrypted" TEXT,
  "mfaEnrolledAt" TIMESTAMP(3),
  "lastTotpStep" BIGINT,
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_admin_users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_admin_users_email_key" ON "platform_admin_users"("email");

CREATE TABLE "platform_roles" (
  "id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_roles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_roles_code_key" ON "platform_roles"("code");

CREATE TABLE "platform_permissions" (
  "id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_permissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_permissions_code_key" ON "platform_permissions"("code");

CREATE TABLE "platform_admin_roles" (
  "id" UUID NOT NULL,
  "adminUserId" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  "assignedByAdminId" UUID,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "platform_admin_roles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_admin_roles_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "platform_admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_admin_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "platform_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "platform_admin_roles_assignedByAdminId_fkey" FOREIGN KEY ("assignedByAdminId") REFERENCES "platform_admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "platform_admin_roles_adminUserId_roleId_key" ON "platform_admin_roles"("adminUserId", "roleId");
CREATE INDEX "platform_admin_roles_roleId_revokedAt_idx" ON "platform_admin_roles"("roleId", "revokedAt");

CREATE TABLE "platform_role_permissions" (
  "id" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  "permissionId" UUID NOT NULL,
  CONSTRAINT "platform_role_permissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "platform_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "platform_permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "platform_role_permissions_roleId_permissionId_key" ON "platform_role_permissions"("roleId", "permissionId");

CREATE TABLE "platform_admin_login_challenges" (
  "id" UUID NOT NULL,
  "adminUserId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "csrfTokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "pendingTotpSecretEncrypted" TEXT,
  "setupIssuedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_admin_login_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_admin_login_challenges_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "platform_admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "platform_admin_login_challenges_tokenHash_key" ON "platform_admin_login_challenges"("tokenHash");
CREATE INDEX "platform_admin_login_challenges_adminUserId_createdAt_idx" ON "platform_admin_login_challenges"("adminUserId", "createdAt");
CREATE INDEX "platform_admin_login_challenges_expiresAt_idx" ON "platform_admin_login_challenges"("expiresAt");

CREATE TABLE "platform_admin_sessions" (
  "id" UUID NOT NULL,
  "adminUserId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "csrfTokenHash" TEXT NOT NULL,
  "idleExpiresAt" TIMESTAMP(3) NOT NULL,
  "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "mfaAuthenticatedAt" TIMESTAMP(3) NOT NULL,
  "reauthenticatedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_admin_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_admin_sessions_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "platform_admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "platform_admin_sessions_tokenHash_key" ON "platform_admin_sessions"("tokenHash");
CREATE INDEX "platform_admin_sessions_adminUserId_revokedAt_idx" ON "platform_admin_sessions"("adminUserId", "revokedAt");

CREATE TABLE "platform_admin_recovery_codes" (
  "id" UUID NOT NULL,
  "adminUserId" UUID NOT NULL,
  "codeHash" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_admin_recovery_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_admin_recovery_codes_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "platform_admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "platform_admin_recovery_codes_adminUserId_codeHash_key" ON "platform_admin_recovery_codes"("adminUserId", "codeHash");
CREATE INDEX "platform_admin_recovery_codes_adminUserId_usedAt_idx" ON "platform_admin_recovery_codes"("adminUserId", "usedAt");

CREATE TABLE "platform_audit_events" (
  "id" UUID NOT NULL,
  "actorAdminId" UUID,
  "action" TEXT NOT NULL,
  "targetType" TEXT,
  "targetId" TEXT,
  "reason" TEXT,
  "outcome" TEXT NOT NULL DEFAULT 'SUCCESS',
  "correlationId" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_audit_events_actorAdminId_fkey" FOREIGN KEY ("actorAdminId") REFERENCES "platform_admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "platform_audit_events_createdAt_id_idx" ON "platform_audit_events"("createdAt", "id");
CREATE INDEX "platform_audit_events_actorAdminId_createdAt_idx" ON "platform_audit_events"("actorAdminId", "createdAt");
CREATE INDEX "platform_audit_events_targetType_targetId_createdAt_idx" ON "platform_audit_events"("targetType", "targetId", "createdAt");
CREATE INDEX "platform_audit_events_correlationId_idx" ON "platform_audit_events"("correlationId");

CREATE FUNCTION prevent_platform_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_events is append-only';
END;
$$;
CREATE TRIGGER platform_audit_events_append_only
  BEFORE UPDATE OR DELETE ON "platform_audit_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_platform_audit_mutation();

-- Seed the approved role/permission matrix; runtime authorization uses these rows.
INSERT INTO "platform_roles" ("id", "code", "name", "description")
VALUES
  ('10000000-0000-4000-8000-000000000001', 'PLATFORM_SUPER_ADMIN', 'Super Admin', 'Platform-wide administrative access'),
  ('10000000-0000-4000-8000-000000000002', 'PLATFORM_SUPPORT', 'Support', 'Tenant and account support metadata'),
  ('10000000-0000-4000-8000-000000000003', 'PLATFORM_BILLING', 'Billing', 'Subscription and promotion operations'),
  ('10000000-0000-4000-8000-000000000004', 'PLATFORM_COMMUNICATIONS', 'Communications', 'Platform announcements');

INSERT INTO "platform_permissions" ("id", "code", "description", "createdAt")
SELECT ('20000000-0000-4000-8000-' || lpad(to_hex(row_number), 12, '0'))::uuid, code, description, CURRENT_TIMESTAMP
FROM (VALUES
  (1, 'platform.dashboard.read', 'Read platform dashboard'),
  (2, 'platform.tenants.list', 'List tenant metadata'),
  (3, 'platform.tenants.read_summary', 'Read minimum tenant summary'),
  (4, 'platform.users.list', 'List minimum account metadata'),
  (5, 'platform.users.read_summary', 'Read minimum account summary'),
  (6, 'platform.tenants.suspend', 'Suspend tenants with reason'),
  (7, 'platform.tenants.reactivate', 'Reactivate tenants with reason'),
  (8, 'platform.subscriptions.read', 'Read subscription metadata'),
  (9, 'platform.subscriptions.manage', 'Manage approved billing operations'),
  (10, 'platform.promotions.read', 'Read subscription promotions'),
  (11, 'platform.promotions.create', 'Create subscription promotion drafts'),
  (12, 'platform.promotions.update_draft', 'Update draft subscription promotions'),
  (13, 'platform.promotions.activate', 'Activate/deactivate promotions'),
  (14, 'platform.announcements.read', 'Read platform announcements'),
  (15, 'platform.announcements.create', 'Create announcements'),
  (16, 'platform.announcements.update_draft', 'Update draft announcements'),
  (17, 'platform.announcements.publish', 'Publish announcements'),
  (18, 'platform.announcements.withdraw', 'Withdraw announcements'),
  (19, 'platform.announcements.resolve', 'Resolve incident announcements'),
  (20, 'platform.audit.read', 'Read permitted platform audit events'),
  (21, 'platform.roles.read', 'Read platform role assignments'),
  (22, 'platform.roles.assign', 'Assign platform roles'),
  (23, 'platform.roles.revoke', 'Revoke platform roles'),
  (24, 'platform.security.mfa_recovery', 'Use audited MFA recovery workflow')
) AS permissions(row_number, code, description);

-- Runtime role needs access to the global admin tables; these tables are
-- deliberately NOT tenant-scoped and carry no RLS policy. Tenant isolation is
-- unaffected because no tenant-scoped table is joined or exposed here.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "platform_admin_users", "platform_roles", "platform_permissions",
  "platform_admin_roles", "platform_role_permissions",
  "platform_admin_login_challenges", "platform_admin_sessions",
  "platform_admin_recovery_codes", "platform_audit_events"
TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "platform_admin_users", "platform_roles", "platform_permissions",
  "platform_admin_roles", "platform_role_permissions",
  "platform_admin_login_challenges", "platform_admin_sessions",
  "platform_admin_recovery_codes", "platform_audit_events"
TO sewain_migrator;

INSERT INTO "platform_role_permissions" ("id", "roleId", "permissionId")
SELECT gen_random_uuid(), r."id", p."id"
FROM "platform_roles" r CROSS JOIN "platform_permissions" p
WHERE r."code" = 'PLATFORM_SUPER_ADMIN';

INSERT INTO "platform_role_permissions" ("id", "roleId", "permissionId")
SELECT gen_random_uuid(), r."id", p."id"
FROM "platform_roles" r JOIN "platform_permissions" p ON p."code" = ANY(ARRAY[
  'platform.dashboard.read', 'platform.tenants.list', 'platform.tenants.read_summary',
  'platform.users.list', 'platform.users.read_summary', 'platform.subscriptions.read',
  'platform.announcements.read', 'platform.audit.read'
]) WHERE r."code" = 'PLATFORM_SUPPORT';

INSERT INTO "platform_role_permissions" ("id", "roleId", "permissionId")
SELECT gen_random_uuid(), r."id", p."id"
FROM "platform_roles" r JOIN "platform_permissions" p ON p."code" = ANY(ARRAY[
  'platform.dashboard.read', 'platform.tenants.list', 'platform.tenants.read_summary',
  'platform.users.list', 'platform.users.read_summary', 'platform.subscriptions.read',
  'platform.subscriptions.manage', 'platform.promotions.read', 'platform.promotions.create',
  'platform.promotions.update_draft', 'platform.promotions.activate',
  'platform.announcements.read', 'platform.audit.read'
]) WHERE r."code" = 'PLATFORM_BILLING';

INSERT INTO "platform_role_permissions" ("id", "roleId", "permissionId")
SELECT gen_random_uuid(), r."id", p."id"
FROM "platform_roles" r JOIN "platform_permissions" p ON p."code" = ANY(ARRAY[
  'platform.dashboard.read', 'platform.tenants.list', 'platform.tenants.read_summary',
  'platform.announcements.read', 'platform.announcements.create',
  'platform.announcements.update_draft', 'platform.announcements.publish',
  'platform.announcements.withdraw', 'platform.announcements.resolve'
]) WHERE r."code" = 'PLATFORM_COMMUNICATIONS';
