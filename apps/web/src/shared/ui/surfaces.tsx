import type { ReactNode } from "react";
import type { StatusDescriptor, Tone } from "@/shared/format/status";

export function Panel({
  children,
  className,
  flush,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return <section className={`panel ${flush ? "panel-flush" : ""} ${className ?? ""}`}>{children}</section>;
}

export function PanelHead({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="panel-head">
      <div>
        <h2 className="panel-title">{title}</h2>
        {description ? <p className="text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="cluster">{actions}</div> : null}
    </header>
  );
}

export function PanelBody({ children, tight }: { children: ReactNode; tight?: boolean }) {
  return <div className={tight ? "panel-body-tight" : "panel-body"}>{children}</div>;
}

export function PanelFoot({ children }: { children: ReactNode }) {
  return <div className="panel-foot">{children}</div>;
}

export function Badge({
  children,
  tone = "neutral",
  plain,
}: {
  children: ReactNode;
  tone?: Tone;
  plain?: boolean;
}) {
  return <span className={`badge badge-${tone} ${plain ? "badge-plain" : ""}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: StatusDescriptor }) {
  return <Badge tone={status.tone}>{status.label}</Badge>;
}

export function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note ? <span className="stat-note">{note}</span> : null}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {breadcrumb ? <div className="breadcrumb">{breadcrumb}</div> : null}
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="cluster">{actions}</div> : null}
    </header>
  );
}

export function DefinitionList({ items }: { items: Array<{ term: string; value: ReactNode }> }) {
  return (
    <dl className="definition-list">
      {items.map((item) => (
        <div key={item.term} style={{ display: "contents" }}>
          <dt>{item.term}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}
