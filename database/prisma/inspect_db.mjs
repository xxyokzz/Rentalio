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
    const memberships = await tx.$queryRaw`SELECT * FROM tenant_memberships WHERE "tenantId" = ${tenantId}::uuid`;
    console.log('Memberships:', memberships);

    const subscriptions = await tx.$queryRaw`SELECT * FROM subscriptions WHERE "tenantId" = ${tenantId}::uuid`;
    console.log('Subscriptions:', subscriptions);

    const categories = await tx.$queryRaw`SELECT * FROM categories WHERE "tenantId" = ${tenantId}::uuid`;
    console.log('Categories:', categories);

    const products = await tx.$queryRaw`SELECT * FROM products WHERE "tenantId" = ${tenantId}::uuid`;
    console.log('Products:', products);
  });
}

main().finally(() => prisma.$disconnect());
