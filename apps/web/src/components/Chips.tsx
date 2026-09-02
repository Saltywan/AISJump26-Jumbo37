import type { Severity } from "../lib/severity";
import type { QueueStatus } from "../lib/store";

export function SeverityChip({
  label,
  count,
  severity,
  onClick,
}: {
  label: string;
  count: number;
  severity: Severity;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={`chip sev-${severity}`}
      onClick={onClick}
    >
      {label}
      {count > 0 ? ` · ${count}` : ""}
    </Tag>
  );
}

const STATUS_LABEL: Record<QueueStatus, string> = {
  generating: "กำลังสร้าง…",
  pending: "รอตรวจ",
  approved: "อนุมัติแล้ว",
  rejected: "ตีกลับ",
};

export function StatusBadge({ status }: { status: QueueStatus }) {
  return <span className={`status-badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}
