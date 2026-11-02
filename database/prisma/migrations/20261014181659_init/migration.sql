-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'MANAGER', 'STAFF', 'CASHIER');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'RESTRICTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING_APPROVAL', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'CONVERTED_TO_ORDER');

-- CreateEnum
CREATE TYPE "RentalOrderStatus" AS ENUM ('CONFIRMED', 'READY_FOR_HANDOVER', 'ACTIVE', 'RETURN_IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('RECORDED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'QRIS');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DepositMovementType" AS ENUM ('RECEIPT', 'DEDUCTION', 'REFUND', 'REVERSAL');

-- CreateEnum
CREATE TYPE "BookingMode" AS ENUM ('MANUAL', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "CatalogPolicy" AS ENUM ('CHECK_AVAILABILITY', 'SKIP_AVAILABILITY');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'MAINTENANCE', 'DAMAGED', 'RETIRED');

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('ACTIVE', 'RELEASED');

-- CreateEnum
CREATE TYPE "ProductStockMode" AS ENUM ('QUANTITY', 'INDIVIDUAL_UNITS');

-- CreateEnum
CREATE TYPE "VerificationPurpose" AS ENUM ('OWNER_SIGNUP_EMAIL_VERIFICATION');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "emailVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfTokenHash" TEXT NOT NULL,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_challenges" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "VerificationPurpose" NOT NULL,
    "otpHash" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "nextResendAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_challenges" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_counters" (
    "id" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "bookingMode" "BookingMode" NOT NULL DEFAULT 'MANUAL',
    "catalogPolicy" "CatalogPolicy" NOT NULL DEFAULT 'CHECK_AVAILABILITY',
    "rentalExtensionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "activatedAt" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_memberships" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByUserId" UUID,
    "activatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_member_invitations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_member_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_domains" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceAmount" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "activatedAt" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "graceStartedAt" TIMESTAMP(3),
    "graceEndsAt" TIMESTAMP(3),
    "providerRef" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadMeta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "isGuest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "categoryId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "stockMode" "ProductStockMode" NOT NULL DEFAULT 'QUANTITY',
    "capacity" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'AVAILABLE',
    "conditionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "perDayAmount" BIGINT NOT NULL,
    "perWeekAmount" BIGINT,
    "perMonthAmount" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_maintenance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_maintenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "customerId" UUID,
    "status" "ReservationStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "bookingMode" "BookingMode" NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "holdExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "priceSnapshot" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_allocations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "assetId" UUID,
    "reservationId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "AllocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_orders" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "sourceReservationId" UUID,
    "customerId" UUID,
    "status" "RentalOrderStatus" NOT NULL DEFAULT 'CONFIRMED',
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "totalAmount" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rental_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "assetId" UUID,
    "quantity" INTEGER NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "priceSnapshot" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rental_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'RECORDED',
    "reference" TEXT,
    "voidReason" TEXT,
    "voidedByUserId" UUID,
    "voidedAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "requestedByUserId" UUID,
    "approvedByUserId" UUID,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_movements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "depositId" UUID NOT NULL,
    "type" "DepositMovementType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "reason" TEXT,
    "reversesId" UUID,
    "actorUserId" UUID,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "fromState" TEXT,
    "toState" TEXT,
    "reason" TEXT,
    "correlationId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_tokenHash_key" ON "auth_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_sessions_userId_idx" ON "auth_sessions"("userId");

-- CreateIndex
CREATE INDEX "email_verification_challenges_email_purpose_idx" ON "email_verification_challenges"("email", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_challenges_tokenHash_key" ON "password_reset_challenges"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_challenges_userId_idx" ON "password_reset_challenges"("userId");

-- CreateIndex
CREATE INDEX "rate_limit_counters_windowEnd_idx" ON "rate_limit_counters"("windowEnd");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_counters_bucket_identifier_windowStart_key" ON "rate_limit_counters"("bucket", "identifier", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenant_memberships_userId_status_idx" ON "tenant_memberships"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_memberships_tenantId_userId_key" ON "tenant_memberships"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_member_invitations_tokenHash_key" ON "tenant_member_invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "tenant_member_invitations_email_idx" ON "tenant_member_invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_member_invitations_tenantId_email_key" ON "tenant_member_invitations"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domains_hostname_key" ON "tenant_domains"("hostname");

-- CreateIndex
CREATE INDEX "tenant_domains_tenantId_idx" ON "tenant_domains"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "plans_tenantId_code_key" ON "plans"("tenantId", "code");

-- CreateIndex
CREATE INDEX "subscriptions_tenantId_status_idx" ON "subscriptions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "subscription_events_subscriptionId_idx" ON "subscription_events"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_events_provider_providerEventId_key" ON "subscription_events"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "customers_tenantId_idx" ON "customers"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenantId_id_key" ON "customers"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenantId_id_key" ON "categories"("tenantId", "id");

-- CreateIndex
CREATE INDEX "products_tenantId_categoryId_idx" ON "products"("tenantId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenantId_id_key" ON "products"("tenantId", "id");

-- CreateIndex
CREATE INDEX "assets_tenantId_productId_status_idx" ON "assets"("tenantId", "productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "assets_tenantId_code_key" ON "assets"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "assets_tenantId_id_key" ON "assets"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rates_tenantId_productId_key" ON "rates"("tenantId", "productId");

-- CreateIndex
CREATE INDEX "asset_maintenance_tenantId_assetId_startAt_endAt_idx" ON "asset_maintenance"("tenantId", "assetId", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "reservations_tenantId_status_startAt_endAt_idx" ON "reservations"("tenantId", "status", "startAt", "endAt");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_tenantId_id_key" ON "reservations"("tenantId", "id");

-- CreateIndex
CREATE INDEX "reservation_items_tenantId_reservationId_idx" ON "reservation_items"("tenantId", "reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_items_tenantId_id_key" ON "reservation_items"("tenantId", "id");

-- CreateIndex
CREATE INDEX "reservation_allocations_tenantId_productId_status_startAt_e_idx" ON "reservation_allocations"("tenantId", "productId", "status", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "reservation_allocations_tenantId_assetId_status_startAt_end_idx" ON "reservation_allocations"("tenantId", "assetId", "status", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "reservation_allocations_tenantId_reservationId_idx" ON "reservation_allocations"("tenantId", "reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_allocations_tenantId_id_key" ON "reservation_allocations"("tenantId", "id");

-- CreateIndex
CREATE INDEX "rental_orders_tenantId_status_idx" ON "rental_orders"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rental_orders_tenantId_id_key" ON "rental_orders"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rental_orders_tenantId_orderNumber_key" ON "rental_orders"("tenantId", "orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "rental_orders_tenantId_sourceReservationId_key" ON "rental_orders"("tenantId", "sourceReservationId");

-- CreateIndex
CREATE INDEX "rental_items_tenantId_orderId_idx" ON "rental_items"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "rental_items_tenantId_id_key" ON "rental_items"("tenantId", "id");

-- CreateIndex
CREATE INDEX "payments_tenantId_orderId_idx" ON "payments"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenantId_id_key" ON "payments"("tenantId", "id");

-- CreateIndex
CREATE INDEX "refunds_tenantId_status_idx" ON "refunds"("tenantId", "status");

-- CreateIndex
CREATE INDEX "refunds_tenantId_orderId_idx" ON "refunds"("tenantId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_tenantId_id_key" ON "refunds"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_tenantId_id_key" ON "deposits"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_tenantId_orderId_key" ON "deposits"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "deposit_movements_tenantId_depositId_idx" ON "deposit_movements"("tenantId", "depositId");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_movements_tenantId_idempotencyKey_key" ON "deposit_movements"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "audit_logs"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_correlationId_idx" ON "audit_logs"("correlationId");

-- CreateIndex
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_tenantId_scope_key_key" ON "idempotency_records"("tenantId", "scope", "key");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_createdAt_idx" ON "outbox_events"("publishedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_challenges" ADD CONSTRAINT "email_verification_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_challenges" ADD CONSTRAINT "password_reset_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_member_invitations" ADD CONSTRAINT "tenant_member_invitations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_member_invitations" ADD CONSTRAINT "tenant_member_invitations_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "categories"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rates" ADD CONSTRAINT "rates_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_maintenance" ADD CONSTRAINT "asset_maintenance_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "assets"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_maintenance" ADD CONSTRAINT "asset_maintenance_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_items" ADD CONSTRAINT "reservation_items_tenantId_reservationId_fkey" FOREIGN KEY ("tenantId", "reservationId") REFERENCES "reservations"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_items" ADD CONSTRAINT "reservation_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_allocations" ADD CONSTRAINT "reservation_allocations_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_allocations" ADD CONSTRAINT "reservation_allocations_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "assets"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_allocations" ADD CONSTRAINT "reservation_allocations_tenantId_reservationId_fkey" FOREIGN KEY ("tenantId", "reservationId") REFERENCES "reservations"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_orders" ADD CONSTRAINT "rental_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_orders" ADD CONSTRAINT "rental_orders_tenantId_sourceReservationId_fkey" FOREIGN KEY ("tenantId", "sourceReservationId") REFERENCES "reservations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_orders" ADD CONSTRAINT "rental_orders_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_items" ADD CONSTRAINT "rental_items_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "rental_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_items" ADD CONSTRAINT "rental_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "rental_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "rental_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenantId_paymentId_fkey" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "payments"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "rental_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_movements" ADD CONSTRAINT "deposit_movements_tenantId_depositId_fkey" FOREIGN KEY ("tenantId", "depositId") REFERENCES "deposits"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
