import { PrismaClient } from '../dist/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomBytes, scryptSync } from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config({ path: 'c:/Users/LENOVO/Documents/Antigravity/rentalio/.env' });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

const DEMO_EMAIL = 'demo@rentalio.test';
const DEMO_PASSWORD = 'DemoRentalio2026!';
const TENANT_ID = '31e52765-1b3c-40aa-8844-d2ba346957e7';
const TENANT_SLUG = 'demo-rental';

async function main() {
  console.log('Setting up demo user and tenant...');
  const passwordHash = hashPassword(DEMO_PASSWORD);

  // 1. Upsert User
  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {
      passwordHash,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      ownerName: 'Demo Owner',
      tenantName: 'Rentalio Demo Rental',
      tenantSlug: TENANT_SLUG,
    },
    create: {
      email: DEMO_EMAIL,
      passwordHash,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      ownerName: 'Demo Owner',
      tenantName: 'Rentalio Demo Rental',
      tenantSlug: TENANT_SLUG,
    },
  });
  console.log('User setup complete:', user.id, user.email);

  // 2. Upsert Tenant & Membership with RLS context
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${TENANT_ID}, true)`;

    // Check if tenant exists
    const existingTenant = await tx.tenant.findUnique({ where: { id: TENANT_ID } });
    if (!existingTenant) {
      await tx.tenant.create({
        data: {
          id: TENANT_ID,
          name: 'Rentalio Demo Rental',
          slug: TENANT_SLUG,
          status: 'ACTIVE',
          bookingMode: 'MANUAL',
          catalogPolicy: 'CHECK_AVAILABILITY',
          activatedAt: new Date(),
          trialEndsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
          whatsappNumber: '6281234567890',
        },
      });
      console.log('Tenant created:', TENANT_ID, TENANT_SLUG);
    } else {
      console.log('Tenant already exists:', TENANT_ID);
    }

    // Upsert membership
    const existingMembership = await tx.tenantMembership.findUnique({
      where: {
        tenantId_userId: {
          tenantId: TENANT_ID,
          userId: user.id,
        },
      },
    });

    if (!existingMembership) {
      await tx.tenantMembership.create({
        data: {
          tenantId: TENANT_ID,
          userId: user.id,
          role: 'OWNER',
          status: 'ACTIVE',
          activatedAt: new Date(),
        },
      });
      console.log('Membership created: OWNER');
    } else {
      console.log('Membership already exists');
    }

    // 4. Seed products and assets within tenant context
    let category = await tx.category.findFirst({ where: { tenantId: TENANT_ID } });
    if (!category) {
      category = await tx.category.create({
        data: {
          tenantId: TENANT_ID,
          name: 'Kamera & Audio',
        },
      });
      console.log('Created category:', category.name);
    }

    let p1 = await tx.product.findFirst({ where: { tenantId: TENANT_ID, name: 'Sony Alpha A7 IV Kit 28-70mm' } });
    if (!p1) {
      p1 = await tx.product.create({
        data: {
          tenantId: TENANT_ID,
          categoryId: category.id,
          name: 'Sony Alpha A7 IV Kit 28-70mm',
          description: 'Kamera full-frame hybrid 33MP untuk foto dan video profesional.',
          stockMode: 'INDIVIDUAL_UNITS',
          capacity: 3,
          isActive: true,
        },
      });

      await tx.rate.create({
        data: {
          tenantId: TENANT_ID,
          productId: p1.id,
          perDayAmount: 350000n,
          perWeekAmount: 2100000n,
          perMonthAmount: 7000000n,
        },
      });

      for (let i = 1; i <= 3; i++) {
        await tx.asset.create({
          data: {
            tenantId: TENANT_ID,
            productId: p1.id,
            code: `A7IV-00${i}`,
            status: 'AVAILABLE',
            conditionNote: 'Kondisi prima, sensor bersih',
          },
        });
      }
      console.log('Created Product 1 (Sony A7 IV) with 3 assets and rates');
    }

    let p2 = await tx.product.findFirst({ where: { tenantId: TENANT_ID, name: 'Wireless Mic DJI Mic 2' } });
    if (!p2) {
      p2 = await tx.product.create({
        data: {
          tenantId: TENANT_ID,
          categoryId: category.id,
          name: 'Wireless Mic DJI Mic 2',
          description: 'Mikrofon nirkabel dual-transmitter dengan peredam kebisingan cerdas.',
          stockMode: 'QUANTITY',
          capacity: 5,
          isActive: true,
        },
      });

      await tx.rate.create({
        data: {
          tenantId: TENANT_ID,
          productId: p2.id,
          perDayAmount: 120000n,
          perWeekAmount: 700000n,
        },
      });
      console.log('Created Product 2 (DJI Mic 2) with quantity pool 5 and rates');
    }

    // Payment method settings
    const settings = await tx.tenantPaymentMethodSetting.findMany({ where: { tenantId: TENANT_ID } });
    if (settings.length === 0) {
      await tx.tenantPaymentMethodSetting.createMany({
        data: [
          { tenantId: TENANT_ID, context: 'NEW_BOOKING', method: 'BANK_TRANSFER', enabled: true },
          { tenantId: TENANT_ID, context: 'NEW_BOOKING', method: 'QRIS', enabled: true },
          { tenantId: TENANT_ID, context: 'NEW_BOOKING', method: 'CASH', enabled: true },
          { tenantId: TENANT_ID, context: 'EXTENSION', method: 'BANK_TRANSFER', enabled: true },
          { tenantId: TENANT_ID, context: 'EXTENSION', method: 'QRIS', enabled: true },
        ],
      });
      console.log('Created payment method settings');
    }
  });

  console.log('Setup finished successfully!');
}

main()
  .catch((e) => {
    console.error('Setup failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
