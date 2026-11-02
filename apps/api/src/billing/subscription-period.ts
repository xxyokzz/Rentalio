/**
 * Aritmetika periode langganan platform.
 *
 * Dipisah sebagai fungsi murni supaya aturan "pembayaran lebih awal tidak
 * menghanguskan sisa periode" dapat diuji tanpa database maupun provider.
 */

const DAY_MS = 24 * 3600 * 1000;

export interface SubscriptionPeriod {
  start: Date;
  end: Date;
}

/**
 * Periode berikutnya: mulai dari akhir periode berjalan bila masih di masa
 * depan, selain itu dari `now`. Dengan begitu perpanjangan sebelum jatuh tempo
 * menambah masa, bukan memotongnya.
 */
export function nextSubscriptionPeriod(
  now: Date,
  currentPeriodEnd: Date | null | undefined,
  periodDays: number,
): SubscriptionPeriod {
  const start =
    currentPeriodEnd && currentPeriodEnd.getTime() > now.getTime() ? currentPeriodEnd : now;
  return { start, end: new Date(start.getTime() + periodDays * DAY_MS) };
}
