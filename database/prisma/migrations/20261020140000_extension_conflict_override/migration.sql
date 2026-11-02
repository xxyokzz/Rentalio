-- ============================================================
-- Perpanjangan sewa & override konflik Opsi B (ADR-001 §8)
--
-- 1. Model permintaan/approval perpanjangan, override yang disetujui,
--    dan relasi konflik (sekaligus tugas operasional).
-- 2. Kolom alokasi periode tambahan (`extensionId`) dan penanda override
--    (`overrideId`) yang dijaga trigger sadar-override.
-- 3. Exclusion constraint asset hanya berlaku untuk alokasi NON-override.
--    Trigger PostgreSQL yang diserialisasi per asset/product menolak semua
--    overlap kecuali pasangan yang tercatat di `extension_conflicts` untuk
--    extension Opsi B yang APPROVED. Tidak ada pengecualian global.
-- 4. RLS FORCE untuk tiga tabel baru (fail-closed tanpa app.tenant_id).
-- ============================================================

-- CreateEnum
CREATE TYPE "ExtensionStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');
CREATE TYPE "ExtensionConflictStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterTable: flag operasional (tidak mengubah lifecycle)
ALTER TABLE "reservations" ADD COLUMN "hasOpenConflict" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "rental_orders" ADD COLUMN "hasOpenConflict" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: alokasi periode tambahan & penanda override
ALTER TABLE "reservation_allocations"
  ADD COLUMN "extensionId" UUID,
  ADD COLUMN "overrideId" UUID;

-- CreateTable
CREATE TABLE "order_extensions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "status" "ExtensionStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "previousEndAt" TIMESTAMP(3) NOT NULL,
    "requestedEndAt" TIMESTAMP(3) NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "requestedByUserId" UUID,
    "decidedByUserId" UUID,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_extensions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_extensions_period_valid" CHECK ("previousEndAt" < "requestedEndAt")
);

CREATE TABLE "extension_overrides" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "extensionId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "policy" "CatalogPolicy" NOT NULL,
    "reason" TEXT NOT NULL,
    "riskAcknowledgedAt" TIMESTAMP(3) NOT NULL,
    "actorUserId" UUID,
    "previousEndAt" TIMESTAMP(3) NOT NULL,
    "requestedEndAt" TIMESTAMP(3) NOT NULL,
    "amountSnapshot" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "conflictCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extension_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "extension_overrides_conflict_count_non_negative" CHECK ("conflictCount" > 0)
);

CREATE TABLE "extension_conflicts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "extensionId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "conflictingAllocationId" UUID NOT NULL,
    "conflictingReservationId" UUID,
    "conflictingOrderId" UUID,
    "status" "ExtensionConflictStatus" NOT NULL DEFAULT 'OPEN',
    "summary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extension_conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_extensions_tenantId_orderId_status_idx"
  ON "order_extensions"("tenantId", "orderId", "status");
CREATE UNIQUE INDEX "order_extensions_tenantId_id_key"
  ON "order_extensions"("tenantId", "id");

CREATE UNIQUE INDEX "extension_overrides_extensionId_key"
  ON "extension_overrides"("extensionId");
CREATE UNIQUE INDEX "extension_overrides_tenantId_id_key"
  ON "extension_overrides"("tenantId", "id");
CREATE UNIQUE INDEX "extension_overrides_tenantId_extensionId_key"
  ON "extension_overrides"("tenantId", "extensionId");
CREATE INDEX "extension_overrides_tenantId_orderId_idx"
  ON "extension_overrides"("tenantId", "orderId");

CREATE UNIQUE INDEX "extension_conflicts_tenantId_extensionId_conflictingAllocati_key"
  ON "extension_conflicts"("tenantId", "extensionId", "conflictingAllocationId");
CREATE INDEX "extension_conflicts_tenantId_status_idx"
  ON "extension_conflicts"("tenantId", "status");

CREATE INDEX "reservation_allocations_tenantId_extensionId_idx"
  ON "reservation_allocations"("tenantId", "extensionId");

-- AddForeignKey
ALTER TABLE "order_extensions"
  ADD CONSTRAINT "order_extensions_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_extensions"
  ADD CONSTRAINT "order_extensions_tenantId_orderId_fkey"
  FOREIGN KEY ("tenantId", "orderId") REFERENCES "rental_orders"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "extension_overrides"
  ADD CONSTRAINT "extension_overrides_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "extension_overrides"
  ADD CONSTRAINT "extension_overrides_tenantId_extensionId_fkey"
  FOREIGN KEY ("tenantId", "extensionId") REFERENCES "order_extensions"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "extension_overrides"
  ADD CONSTRAINT "extension_overrides_tenantId_orderId_fkey"
  FOREIGN KEY ("tenantId", "orderId") REFERENCES "rental_orders"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "extension_conflicts"
  ADD CONSTRAINT "extension_conflicts_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "extension_conflicts"
  ADD CONSTRAINT "extension_conflicts_tenantId_extensionId_fkey"
  FOREIGN KEY ("tenantId", "extensionId") REFERENCES "order_extensions"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reservation_allocations"
  ADD CONSTRAINT "reservation_allocations_tenantId_extensionId_fkey"
  FOREIGN KEY ("tenantId", "extensionId") REFERENCES "order_extensions"("tenantId", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reservation_allocations"
  ADD CONSTRAINT "reservation_allocations_tenantId_overrideId_fkey"
  FOREIGN KEY ("tenantId", "overrideId") REFERENCES "extension_overrides"("tenantId", "id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Override hanya bermakna bila alokasi juga milik extension.
ALTER TABLE "reservation_allocations"
  ADD CONSTRAINT "reservation_allocations_override_requires_extension"
  CHECK ("overrideId" IS NULL OR "extensionId" IS NOT NULL);

-- ============================================================
-- Enforcement overlap sadar-override
-- ============================================================

-- Alokasi non-override tetap dilindungi exclusion constraint (tameng terakhir
-- untuk dua booking normal). Alokasi override dikecualikan dari indeks ini
-- karena harus divalidasi trigger terhadap pasangan konflik yang tercatat.
ALTER TABLE "reservation_allocations"
  DROP CONSTRAINT "reservation_allocations_no_overlap_asset";
ALTER TABLE "reservation_allocations"
  ADD CONSTRAINT "reservation_allocations_no_overlap_asset"
  EXCLUDE USING gist (
    "assetId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  )
  WHERE (status = 'ACTIVE' AND "assetId" IS NOT NULL AND "overrideId" IS NULL);

-- Serialisasi per asset/product dengan advisory lock transaksi, lalu:
-- - INDIVIDUAL_UNITS: setiap alokasi ACTIVE yang overlap harus terdaftar
--   sebagai konflik extension yang memiliki override valid.
-- - QUANTITY: hitung pemakaian puncak sepanjang rentang; bila melebihi
--   kapasitas, aturan yang sama berlaku untuk seluruh alokasi terdampak.
-- Bila tidak ada override, semua overlap ditolak (kode 23P01 agar dipetakan
-- ke 409 AVAILABILITY_CONFLICT).
CREATE OR REPLACE FUNCTION reservation_allocation_override_guard()
RETURNS trigger AS $$
DECLARE
  v_stock_mode "ProductStockMode";
  v_capacity integer;
  v_conflict_id uuid;
  v_peak integer;
  v_has_override boolean := NEW."overrideId" IS NOT NULL;
BEGIN
  IF NEW.status <> 'ACTIVE'::"AllocationStatus" THEN
    RETURN NEW;
  END IF;

  IF NEW."overrideId" IS NOT NULL AND NEW."extensionId" IS NULL THEN
    RAISE EXCEPTION 'overrideId membutuhkan extensionId'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW."tenantId"::text || ':' ||
    COALESCE(NEW."assetId"::text, NEW."productId"::text), 0));

  IF v_has_override THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "extension_overrides" o
      JOIN "order_extensions" e
        ON e."tenantId" = o."tenantId" AND e."id" = o."extensionId"
      WHERE o."tenantId" = NEW."tenantId"
        AND o."id" = NEW."overrideId"
        AND o."extensionId" = NEW."extensionId"
        AND e."status" = 'APPROVED'
    ) THEN
      RAISE EXCEPTION 'Override konflik tidak valid untuk alokasi ini'
        USING ERRCODE = '23P01';
    END IF;
  END IF;

  SELECT p."stockMode", p."capacity"
    INTO v_stock_mode, v_capacity
  FROM "products" p
  WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."productId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produk alokasi tidak ditemukan'
      USING ERRCODE = '23503';
  END IF;

  -- Override tidak boleh bertumpuk dengan alokasi override lain. Pasangan
  -- konflik hanya boleh terdiri dari alokasi normal yang sudah ada, sehingga
  -- dua override paralel tidak dapat saling melegitimasi.
  IF EXISTS (
    SELECT 1
    FROM "reservation_allocations" a
    WHERE a."tenantId" = NEW."tenantId"
      AND a."status" = 'ACTIVE'
      AND a."id" <> NEW."id"
      AND a."overrideId" IS NOT NULL
      AND (
        (NEW."assetId" IS NOT NULL AND a."assetId" = NEW."assetId")
        OR (NEW."assetId" IS NULL AND a."productId" = NEW."productId")
      )
      AND tsrange(a."startAt", a."endAt", '[)')
          && tsrange(NEW."startAt", NEW."endAt", '[)')
  ) THEN
    RAISE EXCEPTION 'Override tidak boleh bertabrakan dengan alokasi override lain'
      USING ERRCODE = '23P01';
  END IF;

  IF v_stock_mode = 'INDIVIDUAL_UNITS' AND NEW."assetId" IS NOT NULL THEN
    FOR v_conflict_id IN
      SELECT a."id"
      FROM "reservation_allocations" a
      WHERE a."tenantId" = NEW."tenantId"
        AND a."assetId" = NEW."assetId"
        AND a."status" = 'ACTIVE'
        AND a."id" <> NEW."id"
        AND tsrange(a."startAt", a."endAt", '[)')
            && tsrange(NEW."startAt", NEW."endAt", '[)')
    LOOP
      IF NOT v_has_override OR NOT EXISTS (
        SELECT 1
        FROM "extension_conflicts" c
        WHERE c."tenantId" = NEW."tenantId"
          AND c."extensionId" = NEW."extensionId"
          AND c."conflictingAllocationId" = v_conflict_id
      ) THEN
        RAISE EXCEPTION
          'Alokasi bertabrakan tanpa override konflik yang sah (asset %)',
          NEW."assetId"
          USING ERRCODE = '23P01';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  -- QUANTITY: pemakaian puncak sepanjang rentang, termasuk alokasi baru.
  WITH candidates AS (
    SELECT a."quantity", a."startAt", a."endAt"
    FROM "reservation_allocations" a
    WHERE a."tenantId" = NEW."tenantId"
      AND a."productId" = NEW."productId"
      AND a."status" = 'ACTIVE'
      AND a."id" <> NEW."id"
      AND a."startAt" < NEW."endAt"
      AND a."endAt" > NEW."startAt"
    UNION ALL
    SELECT NEW."quantity", NEW."startAt", NEW."endAt"
  ),
  points AS (
    SELECT DISTINCT v.t AS point
    FROM candidates c,
         LATERAL (VALUES (c."startAt"), (c."endAt")) AS v(t)
    WHERE v.t >= NEW."startAt" AND v.t < NEW."endAt"
  ),
  usage AS (
    SELECT COALESCE(SUM(c."quantity"), 0) AS used
    FROM points p
    JOIN candidates c
      ON c."startAt" <= p.point AND c."endAt" > p.point
    GROUP BY p.point
  )
  SELECT COALESCE(MAX(used), 0) INTO v_peak FROM usage;

  IF v_peak <= v_capacity THEN
    RETURN NEW;
  END IF;

  IF NOT v_has_override THEN
    RAISE EXCEPTION 'Kapasitas produk terlampaui tanpa override konflik'
      USING ERRCODE = '23P01';
  END IF;

  FOR v_conflict_id IN
    SELECT a."id"
    FROM "reservation_allocations" a
    WHERE a."tenantId" = NEW."tenantId"
      AND a."productId" = NEW."productId"
      AND a."status" = 'ACTIVE'
      AND a."id" <> NEW."id"
      AND a."startAt" < NEW."endAt"
      AND a."endAt" > NEW."startAt"
      AND NOT EXISTS (
        SELECT 1
        FROM "extension_conflicts" c
        WHERE c."tenantId" = NEW."tenantId"
          AND c."extensionId" = NEW."extensionId"
          AND c."conflictingAllocationId" = a."id"
      )
  LOOP
    RAISE EXCEPTION
      'Kapasitas terlampaui dan alokasi % tidak tercatat sebagai konflik override',
      v_conflict_id
      USING ERRCODE = '23P01';
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reservation_allocations_override_guard
  BEFORE INSERT OR UPDATE ON "reservation_allocations"
  FOR EACH ROW EXECUTE FUNCTION reservation_allocation_override_guard();

-- ============================================================
-- RLS + grant untuk tabel baru
-- ============================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'order_extensions', 'extension_overrides', 'extension_conflicts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "order_extensions", "extension_overrides", "extension_conflicts"
  TO sewain_dev;
