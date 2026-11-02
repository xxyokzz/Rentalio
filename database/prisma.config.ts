import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

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
    url: env('DATABASE_URL'),
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
