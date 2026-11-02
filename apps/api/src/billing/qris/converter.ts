/**
 * Konversi QRIS statis → dinamis.
 *
 * Port dari `verssache/qris-dinamis` (`src/core/converter.ts`, MIT).
 * https://github.com/verssache/qris-dinamis
 *
 * Langkah: ganti tag 01 (11 → 12), sisipkan tag 54 (nominal) sebelum tag 58,
 * hitung ulang CRC16 tag 63.
 */
import { calculateCRC16 } from './crc16.js';
import { parseTLV } from './parser.js';
import type { ConvertOptions, TLV } from './types.js';

/** Rangkai ulang elemen TLV (tanpa CRC). */
function buildTLVString(elements: TLV[]): string {
  return elements
    .map((element) => {
      const value = element.children ? buildTLVString(element.children) : element.value;
      const length = value.length.toString().padStart(2, '0');
      return `${element.tag}${length}${value}`;
    })
    .join('');
}

function makeTLV(tag: string, value: string, name = ''): TLV {
  return { tag, name, length: value.length, value };
}

/**
 * Ubah QRIS statis menjadi dinamis dengan menyuntikkan nominal.
 *
 * `amount` wajib bilangan bulat rupiah positif; pemanggil bertanggung jawab
 * memvalidasi domain uang sebelum memanggil fungsi ini.
 */
export function convertQRIS(qrisString: string, options: ConvertOptions): string {
  const elements = parseTLV(qrisString);

  const result: TLV[] = [];
  let amountInserted = false;
  let methodRewritten = false;
  // Tag yang dikelola sendiri: dibuang lalu disisipkan ulang.
  const managedTags = new Set(['54', '55', '56', '57', '63']);

  for (const element of elements) {
    if (managedTags.has(element.tag)) continue;

    if (element.tag === '01') {
      result.push(makeTLV('01', '12', 'Point of Initiation Method'));
      methodRewritten = true;
      continue;
    }

    // Nominal (dan biaya opsional) disisipkan tepat sebelum Country Code.
    if (element.tag === '58' && !amountInserted) {
      result.push(makeTLV('54', options.amount.toString(), 'Transaction Amount'));

      if (options.fee) {
        if (options.fee.type === 'fixed') {
          result.push(makeTLV('55', '02', 'Tip or Convenience Indicator'));
          result.push(makeTLV('56', options.fee.value.toString(), 'Value of Convenience Fee (Fixed)'));
        } else {
          result.push(makeTLV('55', '03', 'Tip or Convenience Indicator'));
          result.push(
            makeTLV('57', options.fee.value.toString(), 'Value of Convenience Fee (%)'),
          );
        }
      }

      amountInserted = true;
    }

    result.push(element);
  }

  if (!methodRewritten) {
    throw new Error('QRIS statis tidak memiliki Point of Initiation Method (tag 01).');
  }
  if (!amountInserted) {
    throw new Error('QRIS statis tidak memiliki Country Code (tag 58).');
  }

  const withoutCRC = buildTLVString(result);
  const crcInput = `${withoutCRC}6304`;
  return crcInput + calculateCRC16(crcInput);
}
