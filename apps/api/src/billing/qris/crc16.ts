/**
 * CRC16-CCITT untuk payload QRIS/EMVCo.
 *
 * Port dari `verssache/qris-dinamis` (`src/core/crc16.ts`, MIT).
 * https://github.com/verssache/qris-dinamis
 *
 * Polynomial 0x1021, init 0xFFFF. Empat digit heksadesimal huruf besar,
 * persis seperti yang diharapkan tag 63.
 */
export function calculateCRC16(input: string): string {
  let crc = 0xffff;

  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }

  return (crc & 0xffff).toString(16).toUpperCase().padStart(4, '0');
}
