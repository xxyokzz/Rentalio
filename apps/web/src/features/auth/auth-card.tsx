import Link from "next/link";
import type { ReactNode } from "react";

export function AuthCard({
  title,
  subtitle,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "auth-card auth-wide" : "auth-card"}>
      <Link href="/" className="brand" style={{ padding: 0, border: 0 }}>
        <span className="brand-mark" aria-hidden="true">
          S
        </span>
        <span className="brand-name" style={{ color: "var(--sw-text)" }}>
          Rentalio
        </span>
      </Link>
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="auth-sub">{subtitle}</p> : null}
      </div>
      {children}
      {footer ? <div className="auth-foot">{footer}</div> : null}
    </div>
  );
}
