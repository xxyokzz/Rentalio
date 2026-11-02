/**
 * @rentalio/database — ekspor Prisma Client hasil generate.
 *
 * Client di-generate ke src/generated/client (lihat schema.prisma) sehingga
 * ikut ter-compile oleh tsc package ini. Berkas masuk utama hasil generate
 * Prisma 7 adalah client.ts; berkas itu sendiri mengekspor namespace `Prisma`
 * (berisi TransactionClient, InputJsonValue, dsb), jadi harus di-re-export
 * langsung — bukan di-namespace-kan ulang.
 *
 * apps/api membuat PrismaClient dengan driver adapter pg (wajib di Prisma 7).
 */
export {
  PrismaClient,
  Prisma,
  MembershipRole,
  PaymentContext,
  PaymentMethod,
  WhatsAppTemplatePurpose,
  SubscriptionInvoiceStatus,
} from './generated/client/client.js';
