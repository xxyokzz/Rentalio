"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/**
 * Animasi reveal saat elemen masuk viewport. Hanya aktif setelah JS menandai
 * dokumen (`data-reveal="ready"`), sehingga konten tetap terbaca tanpa JS.
 * Preferensi reduced motion dimatikan lewat CSS.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    document.documentElement.dataset.reveal = "ready";

    if (typeof IntersectionObserver === "undefined") {
      node.classList.add("is-revealed");
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          node.classList.add("is-revealed");
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className ? `reveal ${className}` : "reveal"}
      style={{ "--reveal-delay": `${delay}ms` } as CSSProperties}
    >
      {children}
    </div>
  );
}
