/**
 * Validasi struktur QRIS.
 *
 * Port dari `verssache/qris-dinamis` (`src/core/validator.ts`, MIT).
 * https://github.com/verssache/qris-dinamis
 */
import { calculateCRC16 } from './crc16.js';
import { parseTLV } from './parser.js';
import type { ValidationResult } from './types.js';

const REQUIRED_TAGS = [
  { tag: '00', name: 'Payload Format Indicator' },
  { tag: '01', name: 'Point of Initiation Method' },
  { tag: '52', name: 'Merchant Category Code' },
  { tag: '53', name: 'Transaction Currency' },
  { tag: '58', name: 'Country Code' },
  { tag: '59', name: 'Merchant Name' },
  { tag: '60', name: 'Merchant City' },
  { tag: '63', name: 'CRC' },
] as const;

/** Periksa header, CRC16, tag wajib, dan keberadaan merchant account. */
export function validateQRIS(qrisString: string): ValidationResult {
  const errors: string[] = [];

  if (!qrisString || qrisString.trim().length === 0) {
    return { valid: false, errors: ['QRIS string kosong.'] };
  }

  const value = qrisString.trim();

  if (!value.startsWith('000201')) {
    errors.push('QRIS harus dimulai dengan Payload Format Indicator "000201".');
  }

  if (value.length < 20) {
    errors.push('QRIS terlalu pendek.');
    return { valid: false, errors };
  }

  const dataWithoutCRC = value.substring(0, value.length - 4);
  const declaredCRC = value.substring(value.length - 4);
  const calculatedCRC = calculateCRC16(dataWithoutCRC);
  if (declaredCRC.toUpperCase() !== calculatedCRC) {
    errors.push(`CRC tidak cocok: seharusnya ${calculatedCRC}, terbaca ${declaredCRC.toUpperCase()}.`);
  }

  const elements = parseTLV(value);
  if (elements.length === 0) {
    errors.push('Tidak ada elemen TLV yang dapat diurai.');
    return { valid: false, errors };
  }

  const tags = new Set(elements.map((element) => element.tag));
  for (const required of REQUIRED_TAGS) {
    if (!tags.has(required.tag)) {
      errors.push(`Tag wajib ${required.tag} (${required.name}) tidak ada.`);
    }
  }

  const method = elements.find((element) => element.tag === '01');
  if (method && method.value !== '11' && method.value !== '12') {
    errors.push(`Point of Initiation Method tidak valid: "${method.value}".`);
  }

  const hasMerchant = elements.some((element) => {
    const tagNumber = Number.parseInt(element.tag, 10);
    return tagNumber >= 26 && tagNumber <= 51;
  });
  if (!hasMerchant) {
    errors.push('Tidak ada Merchant Account Information (tag 26-51).');
  }

  return { valid: errors.length === 0, errors };
}
