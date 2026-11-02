"use client";

/**
 * Badge angka untuk item navigasi (sidebar desktop, tab bar/drawer mobile).
 *
 * `count` null/0 → tidak merender apa pun, sehingga angka 0 tidak pernah
 * tampil seolah-olah ada tugas. Teks alternatif ikut disertakan supaya pembaca
 * layar menyebut artinya, bukan hanya angkanya.
 */
export function NavCountBadge({
  count,
  label,
  tone = "accent",
  inline,
}: {
  count: number | null;
  label: string;
  tone?: "accent" | "danger";
  inline?: boolean;
}) {
  if (!count) return null;
  const classes = ["nav-badge", tone === "danger" ? "nav-badge-danger" : "", inline ? "nav-badge-inline" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <span className={classes} aria-hidden="true">
        {count}
      </span>
      <span className="sr-only">
        {count} {label}
      </span>
    </>
  );
}
