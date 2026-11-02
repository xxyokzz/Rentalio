import Link from "next/link";
import type { CSSProperties } from "react";
import { Reveal } from "@/shared/ui/reveal";

function IconCheck() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  );
}

function IconCalendar() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18M8 15h3" />
    </svg>
  );
}

function IconBolt() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" />
    </svg>
  );
}

function IconClipboard() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V2.8h6V4M9 11h6M9 15h4" />
    </svg>
  );
}

function IconKey() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="4.2" />
      <path d="m11 11 9 9M17 17l2-2M20 20l1.5-1.5" />
    </svg>
  );
}

const PRINCIPLES = [
  {
    accent: "lp-accent-info",
    title: "Persetujuan booking",
    body: "Mode otomatis mengonfirmasi setelah alokasi berhasil; mode manual menunggu persetujuan admin. Pembayaran bukan prasyarat konfirmasi.",
  },
  {
    accent: "lp-accent-success",
    title: "Lifecycle & alokasi",
    body: "Disiapkan, serah-terima, aktif, kembali, selesai. Setiap transisi butuh izin dan tercatat pada audit trail.",
  },
  {
    accent: "lp-accent-warning",
    title: "Status pembayaran",
    body: "Cash dicatat setelah uang diterima; transfer dan QRIS setelah diverifikasi petugas. WhatsApp tidak pernah mengubah status.",
  },
];

const FEATURES = [
  {
    icon: <IconCalendar />,
    title: "Alokasi atomik di server",
    body: "Ketersediaan diperiksa dan dialokasikan dalam satu transaksi. Bentrok periode tampil sebagai konflik yang bisa ditindaklanjuti, bukan galat samar.",
  },
  {
    icon: <IconBolt />,
    title: "Kasir tanpa hambatan",
    body: "Cari barang, susun keranjang, tentukan periode, lihat deposit dan estimasi biaya, lalu konfirmasi dalam satu layar.",
  },
  {
    icon: <IconClipboard />,
    title: "Serah-terima & inspeksi",
    body: "Kondisi awal dan akhir, bukti, denda, serta deposit dicatat terpisah sehingga selisih kondisi mudah ditinjau.",
  },
  {
    icon: <IconKey />,
    title: "Akses sesuai peran",
    body: "Owner, manager, staf, dan kasir melihat tugasnya masing-masing. Backend tetap memutuskan setiap izin.",
  },
];

const STEPS = [
  {
    title: "Permintaan masuk",
    body: "Penyewa memilih periode; server memeriksa ketersediaan unit.",
  },
  {
    title: "Setujui & alokasikan",
    body: "Otomatis atau manual — alokasi tetap terjadi atomik di server.",
  },
  {
    title: "Serah-terima",
    body: "Checklist kondisi, petugas, dan waktu tercatat pada pesanan.",
  },
  {
    title: "Kembali & selesai",
    body: "Inspeksi, denda, deposit, dan pembayaran ditutup terpisah.",
  },
];

const METHODS = [
  {
    name: "CASH",
    title: "Diterima tunai",
    body: "Petugas mencatat setelah uang benar-benar diterima. Memilih tunai tidak membuat tagihan lunas.",
  },
  {
    name: "BANK_TRANSFER",
    title: "Instruksi rekening",
    body: "WhatsApp click-to-chat meminta detail transfer; pembayaran dicatat setelah dana masuk.",
  },
  {
    name: "QRIS",
    title: "Konfirmasi penyewa",
    body: "QRIS tenant dan nominal tagihan tampil. Tombol “Sudah bayar” hanya menyiapkan pesan konfirmasi.",
  },
];

const WORKBENCH = [
  {
    title: "Desktop untuk kepadatan, mobile untuk kecepatan",
    body: "Shell, navigasi, dan komposisi halaman dipisah — bukan dashboard desktop yang diperkecil.",
  },
  {
    title: "Keyboard, fokus, dan label yang jelas",
    body: "Dialog mengelola fokus, pesan error terhubung ke input, dan status tidak hanya disampaikan lewat warna.",
  },
  {
    title: "Offline yang tidak mengarang",
    body: "PWA hanya meng-cache aset statis. Aksi finansial tidak pernah diklaim berhasil tanpa konfirmasi server.",
  },
  {
    title: "Audit untuk tindakan berisiko",
    body: "Pembatalan, void, refund, dan override konflik meminta alasan serta izin yang sesuai.",
  },
];

const SERVER_TRUTH = [
  "Harga, deposit, dan denda",
  "Ketersediaan & alokasi unit",
  "Izin pengguna dan status langganan",
  "Status pembayaran dan deposit",
];

const barStyle = (left: string, width: string, delay: string) =>
  ({
    "--lp-bar-left": left,
    "--lp-bar-width": width,
    "--lp-bar-delay": delay,
  }) as CSSProperties;

export function LandingPage() {
  return (
    <div className="landing">
      <section className="lp-hero">
        <div className="lp-hero-inner">
          <div className="lp-hero-copy">
            <p className="lp-eyebrow">Manajemen penyewaan · satu alur kerja</p>
            <h1>Operasional penyewaan yang rapi, dari booking sampai deposit kembali.</h1>
            <p className="lp-lede">
              Rentalio menyatukan kalender ketersediaan, kasir, serah-terima, inspeksi, dan pembayaran
              manual. Status booking, lifecycle, dan pembayaran selalu terpisah agar tim tidak
              menebak-nebak.
            </p>
            <div className="lp-cta">
              <Link className="btn btn-primary btn-lg" href="/register">
                Mulai trial 72 jam
              </Link>
              <Link className="btn btn-secondary btn-lg" href="/login">
                Masuk ke aplikasi
              </Link>
            </div>
            <ul className="lp-trust">
              <li>
                <IconCheck /> Trial 72 jam sejak aktivasi tenant
              </li>
              <li>
                <IconCheck /> Berjalan di browser, tanpa instalasi
              </li>
              <li>
                <IconCheck /> Data tenant terisolasi
              </li>
            </ul>
          </div>

          <div className="lp-stage">
            <div className="lp-stage-head">
              <span className="lp-stage-title">Papan ketersediaan</span>
              <span className="lp-chip">Ilustrasi</span>
            </div>
            <div className="lp-axis" aria-hidden="true">
              <span>Hari ini</span>
              <span>+3 hari</span>
              <span>+7 hari</span>
            </div>
            <div className="lp-rows" aria-hidden="true">
              <div className="lp-row">
                <span className="lp-row-name">UNIT 01</span>
                <span className="lp-track">
                  <span className="lp-bar lp-bar-info" style={barStyle("6%", "34%", "180ms")} />
                </span>
                <span className="badge badge-info">Aktif</span>
              </div>
              <div className="lp-row">
                <span className="lp-row-name">UNIT 02</span>
                <span className="lp-track">
                  <span className="lp-bar lp-bar-success" style={barStyle("44%", "28%", "300ms")} />
                </span>
                <span className="badge badge-success">Tersewa</span>
              </div>
              <div className="lp-row">
                <span className="lp-row-name">UNIT 03</span>
                <span className="lp-track">
                  <span className="lp-bar lp-bar-warning" style={barStyle("62%", "22%", "420ms")} />
                </span>
                <span className="badge badge-warning">Perawatan</span>
              </div>
            </div>
            <div className="lp-stage-foot">
              <span className="lp-status-chip">
                <b>Booking</b> menunggu persetujuan
              </span>
              <span className="lp-status-chip">
                <b>Lifecycle</b> aktif
              </span>
              <span className="lp-status-chip">
                <b>Pembayaran</b> belum lunas
              </span>
            </div>
            <p className="lp-stage-caption">Ilustrasi tampilan, bukan data nyata.</p>
          </div>
        </div>
      </section>

      <Reveal className="lp-section">
        <span className="lp-kicker">Prinsip produk</span>
        <h2 className="lp-h2">Tiga status yang tidak boleh tercampur.</h2>
        <p className="lp-lead">
          Sebagian besar kekacauan operasional rental datang dari satu kebiasaan: menganggap
          “sudah dibayar” sama dengan “sudah dikonfirmasi”. Rentalio memisahkan ketiganya secara
          eksplisit di setiap layar.
        </p>
        <div className="lp-status-grid">
          {PRINCIPLES.map((item) => (
            <article key={item.title} className="lp-card">
              <span className={`lp-card-accent ${item.accent}`} aria-hidden="true" />
              <h3 className="lp-card-title">{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </Reveal>

      <Reveal className="lp-section">
        <span className="lp-kicker">Yang dikerjakan setiap hari</span>
        <h2 className="lp-h2">Dibangun untuk meja kerja, bukan untuk demo.</h2>
        <p className="lp-lead">
          Alur yang paling sering dipakai tim rental dibuat pendek: cek ketersediaan, serah-terima,
          tagih, kembali, inspeksi. Sisanya dijaga oleh validasi server.
        </p>
        <div className="lp-feature-grid">
          {FEATURES.map((item) => (
            <article key={item.title} className="lp-card">
              <span className="lp-icon" aria-hidden="true">
                {item.icon}
              </span>
              <h3 className="lp-card-title">{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </Reveal>

      <Reveal className="lp-section">
        <span className="lp-kicker">Alur kerja</span>
        <h2 className="lp-h2">Empat langkah yang bisa dipertanggungjawabkan.</h2>
        <ol className="lp-flow">
          {STEPS.map((step) => (
            <li key={step.title}>
              <strong>{step.title}</strong>
              {step.body}
            </li>
          ))}
        </ol>
      </Reveal>

      <Reveal className="lp-section">
        <span className="lp-kicker">Pembayaran manual</span>
        <h2 className="lp-h2">Tunai, transfer, dan QRIS dicatat apa adanya.</h2>
        <p className="lp-lead">
          Metode aktif diatur owner per jenis transaksi: booking baru, tambah unit, dan
          perpanjangan. Setiap konteks wajib menyisakan minimal satu metode.
        </p>
        <div className="lp-pay-grid">
          {METHODS.map((method) => (
            <article key={method.name} className="lp-card lp-method">
              <div className="lp-method-head">
                <span className="lp-method-name">{method.name}</span>
                <span className="badge">{method.title}</span>
              </div>
              <p>{method.body}</p>
            </article>
          ))}
        </div>
        <p className="lp-note">
          Tidak ada payment gateway untuk pembayaran sewa. WhatsApp hanya menyiapkan pesan dan
          pengguna tetap menekan Kirim; status lunas hanya berubah setelah petugas mencatatnya.
        </p>
      </Reveal>

      <Reveal className="lp-section">
        <span className="lp-kicker">Detail yang jarang diurus</span>
        <h2 className="lp-h2">Rapi di layar kecil, jujur saat koneksi putus.</h2>
        <div className="lp-split">
          <ul className="lp-list">
            {WORKBENCH.map((item) => (
              <li key={item.title}>
                <IconCheck />
                <span>
                  <strong>{item.title}.</strong> {item.body}
                </span>
              </li>
            ))}
          </ul>
          <div className="lp-card">
            <h3 className="lp-card-title">Angka dan izin selalu dari server</h3>
            <p>UI hanya menampilkan; keputusan tetap di backend.</p>
            <ul className="lp-list" style={{ marginTop: "var(--sw-space-4)" }}>
              {SERVER_TRUTH.map((item) => (
                <li key={item}>
                  <IconCheck />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Reveal>

      <Reveal className="lp-section">
        <div className="lp-band">
          <h2>Mulai dari trial 72 jam.</h2>
          <p>
            Aktifkan tenant, verifikasi email lewat OTP, lalu jalankan booking pertama. Setelah trial
            berakhir, transaksi baru dibatasi sampai langganan aktif — data tetap bisa dibaca dan
            pesanan berjalan tetap diselesaikan.
          </p>
          <div className="lp-cta">
            <Link className="btn btn-primary btn-lg" href="/register">
              Daftar sebagai owner
            </Link>
            <Link className="btn btn-secondary btn-lg" href="/login">
              Sudah punya akun
            </Link>
          </div>
        </div>
      </Reveal>
    </div>
  );
}
