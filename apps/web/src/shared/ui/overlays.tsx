"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "./buttons";
import { TextArea } from "./form";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide,
  closeLabel = "Tutup",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  closeLabel?: string;
}) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null,
      );
      if (items.length === 0) return;
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={wide ? "dialog dialog-wide" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
      >
        <div className="dialog-head">
          <div>
            <h2 className="dialog-title" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="dialog-desc" id={descId}>
                {description}
              </p>
            ) : null}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={closeLabel}>
            ✕
          </Button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Konfirmasi tindakan berisiko. `consequence` wajib: dialog generik
 * "Apakah Anda yakin?" dilarang (Notion 09 §4).
 */
interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  title: string;
  consequence: string;
  confirmLabel: string;
  destructive?: boolean;
  requireReason?: boolean;
  reasonLabel?: string;
  busy?: boolean;
  children?: ReactNode;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  // Isi dialog di-mount hanya saat terbuka: alasan/error selalu bersih setiap
  // kali dialog dibuka tanpa perlu sinkronisasi state lewat effect.
  if (!props.open) return null;
  return <ConfirmDialogContent {...props} />;
}

function ConfirmDialogContent({
  onClose,
  onConfirm,
  title,
  consequence,
  confirmLabel,
  destructive,
  requireReason,
  reasonLabel = "Alasan",
  busy,
  children,
}: ConfirmDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (requireReason && reason.trim().length < 3) {
      setError("Alasan wajib diisi minimal 3 karakter agar dapat diaudit.");
      return;
    }
    onConfirm(reason.trim());
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={consequence}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={submit}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        {children}
        {requireReason ? (
          <TextArea
            label={reasonLabel}
            required
            rows={3}
            value={reason}
            error={error ?? undefined}
            onChange={(event) => setReason(event.target.value)}
            hint="Alasan disimpan pada audit trail tindakan ini."
          />
        ) : null}
      </div>
    </Dialog>
  );
}

type ToastTone = "default" | "success" | "error";

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

const ToastContext = createContext<{
  notify: (message: string, tone?: ToastTone) => void;
} | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const notify = useCallback((message: string, tone: ToastTone = "default") => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 6000);
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.tone === "default" ? "" : `toast-${item.tone}`}`}>
            <span>{item.message}</span>
            <span className="spacer" />
            <button
              type="button"
              onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
            >
              Tutup
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast harus dipakai di dalam ToastProvider");
  }
  return context;
}
