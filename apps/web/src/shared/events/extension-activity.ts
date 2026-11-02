/**
 * Sinyal "aktivitas perpanjangan berubah" — dipakai setelah keputusan
 * (setujui/tolak), override konflik, atau penyelesaian konflik berhasil.
 *
 * Badge navigasi tetap membaca data server lewat hook masing-masing; modul ini
 * hanya memberi tahu bahwa data berubah, sehingga badge memuat ulang tanpa
 * menunggu pindah halaman. Tidak ada state domain yang disimpan di sini.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/** Panggil hanya setelah mutasi sukses; kegagalan tidak mengubah antrean. */
export function notifyExtensionActivity(): void {
  for (const listener of [...listeners]) listener();
}

/** Berlangganan; mengembalikan fungsi untuk berhenti berlangganan. */
export function subscribeExtensionActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
