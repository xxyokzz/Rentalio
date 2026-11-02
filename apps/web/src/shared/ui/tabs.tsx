"use client";

import { useId, useRef, type ReactNode } from "react";
import { Button } from "./buttons";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export function Tabs({
  items,
  active,
  onChange,
  children,
}: {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
  children?: ReactNode;
}) {
  const baseId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = (index + direction + items.length) % items.length;
    const item = items[next];
    if (!item) return;
    onChange(item.id);
    refs.current[next]?.focus();
  };

  return (
    <div>
      <div className="tabs" role="tablist" aria-label="Bagian halaman">
        {items.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${item.id}`}
            aria-selected={active === item.id}
            aria-controls={`${baseId}-panel-${item.id}`}
            tabIndex={active === item.id ? 0 : -1}
            className="tab"
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {item.label}
            {typeof item.count === "number" ? (
              <span className="text-xs text-muted"> ({item.count})</span>
            ) : null}
          </button>
        ))}
      </div>
      <div
        className="tab-panel"
        role="tabpanel"
        id={`${baseId}-panel-${active}`}
        aria-labelledby={`${baseId}-tab-${active}`}
      >
        {children}
      </div>
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  return (
    <div className="row-between">
      <span className="text-sm text-muted">
        Halaman {page} dari {totalPages} · {total} data
      </span>
      <div className="cluster">
        <Button size="sm" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
          Sebelumnya
        </Button>
        <Button size="sm" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}>
          Berikutnya
        </Button>
      </div>
    </div>
  );
}
