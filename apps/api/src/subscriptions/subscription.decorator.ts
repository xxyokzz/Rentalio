import { SetMetadata } from '@nestjs/common';

/**
 * Tandai handler yang membuat komitmen sewa baru atau mengubah katalog, harga,
 * dan inventaris. Handler tanpa penanda tetap boleh diakses dalam restricted
 * mode (baca/laporan serta penyelesaian order aktif).
 */
export const BLOCK_IN_RESTRICTED_MODE = 'blockInRestrictedMode';

export const BlockInRestrictedMode = (): MethodDecorator =>
  SetMetadata(BLOCK_IN_RESTRICTED_MODE, true);
