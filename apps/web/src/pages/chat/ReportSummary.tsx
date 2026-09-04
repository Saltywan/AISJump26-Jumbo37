/* The compact form of the review report (see src/pages/Review.tsx) — the
 * same data (checks.ts -> severity.ts), the same visual language (the
 * flag-section/chip classes in styles.css, written for Review.tsx and reused
 * verbatim here), just fewer pixels: worst-first chips collapsed into one
 * row, and the per-flag detail hidden behind a single <details> instead of
 * one open/close per flag.
 *
 * This exists because of the product decision docs/BUILD-PLAN.html section 04
 * argues for: every automated check here can be green on a page that is
 * visibly wrong, so the report is not the gate — a teacher looking at the
 * rendered page is. The report is *evidence for that look*, surfaced right
 * next to the animation in the generated-lesson card, not a checklist a
 * teacher can clear without ever seeing the diagram. */
import { useMemo, useState } from "react";
import type { CheckRow } from "../../checks";
import { severityOf, type Flag } from "../../lib/severity";
import { SeverityChip } from "../../components/Chips";

export function ReportSummary({ check }: { check: CheckRow }) {
  const flags = useMemo(() => severityOf(check), [check]);
  const risky = flags.filter((f) => f.severity !== "clean");
  // This now sits in a side panel next to the page (see TeacherChat.tsx),
  // not squeezed into a couple of lines underneath it, so there's room to
  // default the detail open — a reviewer who has to click to even see
  // whether there's anything behind the chips is exactly the "clear report,
  // wrong page" gap this screen exists to close.
  const [open, setOpen] = useState(true);

  return (
    <div className="report-summary">
      <p className="report-caveat report-caveat-compact">
        ตัวเลขด้านล่างเป็น<b>ข้อมูลประกอบ</b> ไม่ใช่เกณฑ์ตัดสิน — <b>ต้องดูภาพเคลื่อนไหวจริงด้านบนก่อนเผยแพร่เสมอ</b>
      </p>

      <div className="report-summary-chips">
        {risky.length === 0 ? (
          <span className="chip sev-clean">ไม่พบปัญหาที่ตรวจจับได้จากเครื่องตรวจ</span>
        ) : (
          risky.slice(0, 4).map((f) => <SeverityChip key={f.key} label={f.label} count={f.count} severity={f.severity} />)
        )}
      </div>

      <button type="button" className="raw-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "ซ่อน" : "ดู"}รายละเอียดการตรวจทั้งหมด ({flags.length})
      </button>

      {open && (
        <div className="report-summary-detail">
          {flags.map((f) => (
            <CompactFlag key={f.key} flag={f} />
          ))}
        </div>
      )}
    </div>
  );
}

function CompactFlag({ flag }: { flag: Flag }) {
  const [open, setOpen] = useState(flag.severity === "critical" || flag.severity === "warning");
  return (
    <div className={`flag-section sev-${flag.severity}`}>
      <button type="button" className="flag-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`flag-dot sev-${flag.severity}`} />
        <span className="flag-label">{flag.label}</span>
        <span className="flag-count">{flag.count}</span>
        <span className="flag-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="flag-body">
          <p className="flag-why">{flag.why}</p>
          {flag.items.length === 0 ? (
            <p className="flag-clean">ไม่พบปัญหาประเภทนี้</p>
          ) : (
            <ul className="flag-items">
              {flag.items.slice(0, 6).map((it, i) => (
                <li key={i}>
                  <span>{it.text}</span>
                </li>
              ))}
              {flag.items.length > 6 && <li>…และอีก {flag.items.length - 6} รายการ</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
