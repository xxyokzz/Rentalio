import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

function classes(variant: Variant, size: Size, block?: boolean, extra?: string): string {
  return [
    "btn",
    `btn-${variant}`,
    size === "sm" ? "btn-sm" : size === "lg" ? "btn-lg" : "",
    block ? "btn-block" : "",
    extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  block,
  loading,
  children,
  className,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={classes(variant, size, block, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="text-xs">Memproses…</span> : children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  block,
  children,
  className,
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  block?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link href={href} className={classes(variant, size, block, className)}>
      {children}
    </Link>
  );
}
