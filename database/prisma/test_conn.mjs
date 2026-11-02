import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/index.js';
import dotenv from 'dotenv';

dotenv.config({ path: 'c:/Users/LENOVO/Documents/Antigravity/rentalio/.env' });

console.log('DATABASE_URL:', process.env.DATABASE_URL);

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

console.log('Prisma client created, connecting...');

const timeout = setTimeout(() => {
  console.log('TIMEOUT after 10s — hanging at $connect()');
  process.exit(1);
}, 10000);

try {
  await prisma.$connect();
  await prisma.$executeRaw`DELETE FROM rate_limit_counters`;
  console.log('Rate limit counters cleared!');
  const users = await prisma.user.findMany();
  console.log('Users:', users.map(u => ({ id: u.id, email: u.email, fullName: u.fullName, status: u.status })));
  const tenants = await prisma.tenant.findMany();
  console.log('Tenants:', tenants.map(t => ({ id: t.id, name: t.name, slug: t.slug, status: t.status })));
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', '31e52765-1b3c-40aa-8844-d2ba346957e7', true)`;
    const products = await tx.product.findMany();
    console.log('Products:', products.map(p => ({ id: p.id, name: p.name, stockMode: p.stockMode })));
  });
} catch (e) {
  clearTimeout(timeout);
  console.log('Error:', e.message);
} finally {
  await prisma.$disconnect();
}
