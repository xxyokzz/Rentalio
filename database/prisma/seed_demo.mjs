import { PrismaClient } from '../dist/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import dotenv from 'dotenv';

dotenv.config({ path: 'c:/Users/LENOVO/Documents/Antigravity/rentalio/database/.env' });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const tenantId = '31e52765-1b3c-40aa-8844-d2ba346957e7';

async function main() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

    // 1. Category
    let category = await tx.category.findFirst({ where: { tenantId } });
    if (!category) {
      category = await tx.category.create({
        data: {
          tenantId,
          name: 'Kamera & Audio',
        },
      });
      console.log('Created category:', category.name);
    }

    // 2. Product 1 (Individual units)
    let p1 = await tx.product.findFirst({ where: { tenantId, name: 'Sony Alpha A7 IV Kit 28-70mm' } });
    if (!p1) {
      p1 = await tx.product.create({
        data: {
          tenantId,
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
          tenantId,
          productId: p1.id,
          perDayAmount: 350000n,
          perWeekAmount: 2100000n,
          perMonthAmount: 7000000n,
        },
      });

      for (let i = 1; i <= 3; i++) {
        await tx.asset.create({
          data: {
            tenantId,
            productId: p1.id,
            code: `A7IV-00${i}`,
            status: 'AVAILABLE',
            conditionNote: 'Kondisi prima, sensor bersih',
          },
        });
      }
      console.log('Created Product 1 with 3 assets and rates');
    }

    // 3. Product 2 (Quantity pooled)
    let p2 = await tx.product.findFirst({ where: { tenantId, name: 'Wireless Mic DJI Mic 2' } });
    if (!p2) {
      p2 = await tx.product.create({
        data: {
          tenantId,
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
          tenantId,
          productId: p2.id,
          perDayAmount: 120000n,
          perWeekAmount: 700000n,
        },
      });
      console.log('Created Product 2 with quantity pool 5 and rates');
    }

    // 4. Ensure payment method setting (QRIS & Bank Transfer & Cash)
    const settings = await tx.tenantPaymentMethodSetting.findMany({ where: { tenantId } });
    if (settings.length === 0) {
      await tx.tenantPaymentMethodSetting.createMany({
        data: [
          { tenantId, context: 'NEW_BOOKING', method: 'BANK_TRANSFER', enabled: true },
          { tenantId, context: 'NEW_BOOKING', method: 'QRIS', enabled: true },
          { tenantId, context: 'NEW_BOOKING', method: 'CASH', enabled: true },
          { tenantId, context: 'EXTENSION', method: 'BANK_TRANSFER', enabled: true },
          { tenantId, context: 'EXTENSION', method: 'QRIS', enabled: true },
        ],
      });
      console.log('Created payment method settings');
    }
  });

  console.log('Successfully populated tenant inventory!');
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
