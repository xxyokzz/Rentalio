import type { ReactNode } from "react";

export function ErrorPanel({ title, message }: { title: string; message: string }) {
  return (
    <div className="panel">
      <div className="panel__head">
        <h2 className="panel__title">{title}</h2>
      </div>
      <div className="panel__body">
        <p className="alert alert--error" role="alert">
          {message}
        </p>
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="table__primary">{title}</p>
      {children}
    </div>
  );
}
