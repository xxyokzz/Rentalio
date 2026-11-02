import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/shared/ui/icons";

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

/**
 * Kerangka dua kolom untuk halaman autentikasi: panel merek yang menjelaskan
 * produk di kiri, formulir di kanan. Di layar kecil panel disembunyikan dan
 * formulir memakai lebar penuh.
 */
export function AuthSplit({
  eyebrow,
  title,
  lede,
  points,
  asideFoot,
  children,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  points: string[];
  asideFoot: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="auth-split">
      <aside className="auth-aside">
        <Link href="/" className="auth-aside-brand">
          <span className="brand-mark" aria-hidden="true">
            <BrandMark lineColor="#1c1915" />
          </span>
          <span className="brand-name">rentalio</span>
        </Link>

        <div>
          <p className="lp-eyebrow">{eyebrow}</p>
          <h2 className="auth-aside-title" style={{ marginTop: "var(--sw-space-4)" }}>
            {title}
          </h2>
          {lede ? <p className="auth-aside-lede">{lede}</p> : null}
          <ul className="auth-points">
            {points.map((point) => (
              <li key={point}>
                <IconCheck />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="auth-aside-foot">{asideFoot}</p>
      </aside>

      <div className="auth-main">
        <div className="auth-main-inner">
          {children}
          <Link className="auth-back" href="/">
            <span aria-hidden="true">←</span> Kembali ke beranda
          </Link>
        </div>
      </div>
    </div>
  );
}
