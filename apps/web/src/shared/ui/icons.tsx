/**
 * Set ikon garis Rentalio. Satu sumber agar ketebalan, ukuran, dan sudut
 * konsisten di sidebar, tab mobile, dan dashboard.
 */
export type IconName =
  | "grid"
  | "calendar"
  | "receipt"
  | "register"
  | "rotate"
  | "alert"
  | "box"
  | "tag"
  | "chart"
  | "sliders"
  | "card"
  | "message"
  | "users"
  | "store"
  | "external"
  | "chevron-down"
  | "logout"
  | "arrow-right"
  | "arrow-up-right"
  | "check"
  | "plus"
  | "clock"
  | "wallet"
  | "menu"
  | "close"
  | "layout"
  | "eye"
  | "grip"
  | "trash"
  | "pencil"
  | "image"
  | "chevron-up"
  | "arrow-left"
  | "monitor"
  | "smartphone"
  | "tablet";

const PATHS: Record<IconName, string> = {
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  calendar:
    "M7 3v3M17 3v3M3.5 9.5h17M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v12A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V7A1.5 1.5 0 0 1 5 5.5Z",
  receipt: "M6 3.5h12v17l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3",
  register:
    "M4 8.5h16V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19zM4 8.5 5.5 4h13L20 8.5M9 13h6",
  rotate: "M4.5 10a7.5 7.5 0 1 1 2.2 5.8M4 4.5V10h5.5",
  alert: "M12 4 2.8 20h18.4zM12 10v4.5M12 17.4v.1",
  box: "m12 3 8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",
  tag: "M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7a1 1 0 0 1 .7.3l7.3 7.3a1 1 0 0 1 0 1.4l-7.7 7.7a1 1 0 0 1-1.4 0L3.8 12.9a1 1 0 0 1-.3-.7ZM8 8h.1",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M15 4v6M7 14v6",
  card: "M3 6.5h18v11H3zM3 10.5h18M6.5 14.5h3",
  message:
    "M4 5.5h16v11H9l-5 4v-15Z",
  users:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.4 3.4 0 0 1 0 6.6M17.5 14.2A6 6 0 0 1 21.5 20",
  store: "M4 10v9.5h16V10M2.5 6 4 3.5h16L21.5 6a3 3 0 0 1-5 2 3 3 0 0 1-5 0 3 3 0 0 1-5 0 3 3 0 0 1-4-2ZM9.5 19.5V14h5v5.5",
  external: "M14 4h6v6M20 4l-8 8M18 14v5.5H4.5V6H10",
  "chevron-down": "m7 10 5 5 5-5",
  logout: "M15 4h4.5v16H15M11 8l-4 4 4 4M3 12h12",
  "arrow-right": "M4 12h15M13 6l6 6-6 6",
  "arrow-up-right": "M7 17 17 7M8 7h9v9",
  check: "m4 12.5 5 5L20 6",
  plus: "M12 4v16M4 12h16",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5.5l3.5 2",
  wallet: "M3 7.5h15.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5H5A2 2 0 0 1 3 18zM3 7.5V6a2 2 0 0 1 2-2h12M16.5 13.5h.1",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6 6 18",
  layout: "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  grip: "M9 4h.01M9 9h.01M9 14h.01M9 19h.01M15 4h.01M15 9h.01M15 14h.01M15 19h.01",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  pencil: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z",
  image: "M21 15l-5-5L5 20M3 3h18v18H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  "chevron-up": "m7 15 5-5 5 5",
  "arrow-left": "M19 12H5M12 19l-7-7 7-7",
  monitor: "M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM8 20h8M12 16v4",
  smartphone: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM11.5 18h1",
  tablet: "M5 2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM11.5 18h1",
};

export function Icon({
  name,
  size = 20,
  strokeWidth = 1.6,
  className,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Wordmark kecil: dua kartu bertumpuk — barang yang disewa, bukan inisial generik. */
export function BrandMark({ lineColor = "#fffdf9" }: { lineColor?: string }) {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <rect x="2" y="6.5" width="17" height="15" rx="4" fill="currentColor" opacity="0.22" />
      <rect
        x="8.5"
        y="2.5"
        width="17"
        height="15"
        rx="4"
        fill="currentColor"
        opacity="0.95"
      />
      <circle cx="17" cy="10" r="2.4" fill={lineColor} />
    </svg>
  );
}
