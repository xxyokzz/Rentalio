/**
 * Parser TLV QRIS/EMVCo.
 *
 * Port dari `verssache/qris-dinamis` (`src/core/parser.ts`, MIT).
 * https://github.com/verssache/qris-dinamis
 */
import type { MerchantAccountInfo, QRISData, TLV } from './types.js';

/** Nama tag EMVCo/QRIS yang dikenal. */
const TAG_NAMES: Record<string, string> = {
  '00': 'Payload Format Indicator',
  '01': 'Point of Initiation Method',
  '26': 'Merchant Account Information',
  '27': 'Merchant Account Information',
  '28': 'Merchant Account Information',
  '29': 'Merchant Account Information',
  '30': 'Merchant Account Information',
  '31': 'Merchant Account Information',
  '32': 'Merchant Account Information',
  '33': 'Merchant Account Information',
  '34': 'Merchant Account Information',
  '35': 'Merchant Account Information',
  '36': 'Merchant Account Information',
  '37': 'Merchant Account Information',
  '38': 'Merchant Account Information',
  '39': 'Merchant Account Information',
  '40': 'Merchant Account Information',
  '41': 'Merchant Account Information',
  '42': 'Merchant Account Information',
  '43': 'Merchant Account Information',
  '44': 'Merchant Account Information',
  '45': 'Merchant Account Information',
  '46': 'Merchant Account Information',
  '47': 'Merchant Account Information',
  '48': 'Merchant Account Information',
  '49': 'Merchant Account Information',
  '50': 'Merchant Account Information',
  '51': 'Merchant Account Information',
  '52': 'Merchant Category Code',
  '53': 'Transaction Currency',
  '54': 'Transaction Amount',
  '55': 'Tip or Convenience Indicator',
  '56': 'Value of Convenience Fee (Fixed)',
  '57': 'Value of Convenience Fee (%)',
  '58': 'Country Code',
  '59': 'Merchant Name',
  '60': 'Merchant City',
  '61': 'Postal Code',
  '62': 'Additional Data Field',
  '63': 'CRC',
};

/** Tag yang nilainya berisi TLV bertingkat. */
const NESTED_TAGS = new Set<string>([
  ...Array.from({ length: 26 }, (_, i) => String(i + 26).padStart(2, '0')),
  '62',
]);

/** Urai string TLV menjadi array elemen. Berhenti aman pada data terpotong. */
export function parseTLV(data: string): TLV[] {
  const elements: TLV[] = [];
  let pos = 0;

  while (pos < data.length) {
    if (pos + 4 > data.length) break;

    const tag = data.substring(pos, pos + 2);
    const length = Number.parseInt(data.substring(pos + 2, pos + 4), 10);

    if (Number.isNaN(length) || pos + 4 + length > data.length) break;

    const value = data.substring(pos + 4, pos + 4 + length);
    const element: TLV = {
      tag,
      name: TAG_NAMES[tag] ?? `Unknown (${tag})`,
      length,
      value,
    };
    if (NESTED_TAGS.has(tag)) element.children = parseTLV(value);

    elements.push(element);
    pos += 4 + length;
  }

  return elements;
}

/** Urai string QRIS menjadi struktur `QRISData`. */
export function parseQRIS(qrisString: string): QRISData {
  const raw = parseTLV(qrisString);
  const findTag = (tag: string) => raw.find((t) => t.tag === tag);

  const tipIndicatorValue = findTag('55')?.value;
  let tipIndicator: QRISData['tipIndicator'];
  if (tipIndicatorValue === '01') tipIndicator = 'prompt';
  else if (tipIndicatorValue === '02') tipIndicator = 'fixed';
  else if (tipIndicatorValue === '03') tipIndicator = 'percentage';

  const merchantAccountInfo: MerchantAccountInfo[] = raw
    .filter((t) => {
      const tagNumber = Number.parseInt(t.tag, 10);
      return tagNumber >= 26 && tagNumber <= 51 && t.children;
    })
    .map((element) => {
      const children = element.children ?? [];
      const findChild = (childTag: string) => children.find((c) => c.tag === childTag);
      return {
        tag: element.tag,
        globallyUniqueId: findChild('00')?.value ?? '',
        merchantId: findChild('01')?.value ?? findChild('02')?.value,
        merchantCriteria: findChild('03')?.value,
        fields: children,
      };
    });

  return {
    version: findTag('00')?.value ?? '01',
    method: findTag('01')?.value === '12' ? 'dynamic' : 'static',
    merchantAccountInfo,
    merchantCategoryCode: findTag('52')?.value ?? '',
    currency: findTag('53')?.value ?? '360',
    amount: findTag('54')?.value,
    tipIndicator,
    tipFixed: findTag('56')?.value,
    tipPercentage: findTag('57')?.value,
    countryCode: findTag('58')?.value ?? 'ID',
    merchantName: findTag('59')?.value ?? '',
    merchantCity: findTag('60')?.value ?? '',
    postalCode: findTag('61')?.value ?? '',
    additionalData: findTag('62')?.children,
    crc: findTag('63')?.value ?? '',
    raw,
  };
}
