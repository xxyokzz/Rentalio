import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Supabase: runtime memakai transaction pooler (port 6543) di DATABASE_URL,
// sedangkan migrasi butuh session/direct connection (port 5432) karena DDL
// tidak aman lewat transaction pooler. Fallback ke DATABASE_URL menjaga
// kompatibilitas PostgreSQL lokal.
const migrationUrl = process.env.DIRECT_URL?.trim();
// Shadow database opsional: hanya dibutuhkan `prisma migrate dev`.
// `migrate deploy` (CI/production) tidak memerlukannya.
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node prisma/seed.mjs',
  },
  datasource: {
    url: migrationUrl || env('DATABASE_URL'),
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
