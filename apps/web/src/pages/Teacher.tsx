import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CHECKS } from "../checks";
import { checkIdOf, relativeTime, formatSeconds } from "../lib/format";
import { severityOf, worstFlag } from "../lib/severity";
import {
  useStore,
  statusOf,
  latestReview,
  submitProblem,
  tickJobs,
  setReviewerName,
  resetDemoData,
  type QueueStatus,
} from "../lib/store";
import { SeverityChip, StatusBadge } from "../components/Chips";

type Tab = "pending" | "approved" | "rejected" | "all";

const TABS: { key: Tab; label: string }[] = [
  { key: "pending", label: "รอตรวจ" },
  { key: "approved", label: "อนุมัติแล้ว" },
  { key: "rejected", label: "ตีกลับ" },
  { key: "all", label: "ทั้งหมด" },
];

const SEV_WEIGHT = { critical: 3, warning: 2, info: 1, clean: 0 } as const;

export default function Teacher() {
  const { queue, reviews, reviewerName } = useStore();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("pending");
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Fake generation: poll for items whose simulated delay has elapsed. Cheap
  // no-op when nothing is generating (see tickJobs in lib/store.ts).
  useEffect(() => {
    const t = setInterval(tickJobs, 400);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => {
    return queue.map((item) => {
      const status = statusOf(item, reviews);
      const check = CHECKS[checkIdOf(item.file)];
      const worst = check ? worstFlag(check) : undefined;
      const review = latestReview(reviews, item.id);
      return { item, status, check, worst, review };
    });
  }, [queue, reviews]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = rows.filter((r) => {
      if (tab !== "all") {
        const matches = tab === "pending" ? r.status === "pending" || r.status === "generating" : r.status === tab;
        if (!matches) return false;
      }
      if (!q) return true;
      const hay = `${r.item.title} ${r.item.id} ${r.item.submittedText ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
    if (tab === "pending") {
      list = list.slice().sort((a, b) => {
        if (a.status !== b.status) return a.status === "generating" ? -1 : 1;
        const wa = a.worst ? SEV_WEIGHT[a.worst.severity] : 0;
        const wb = b.worst ? SEV_WEIGHT[b.worst.severity] : 0;
        if (wa !== wb) return wb - wa;
        const ca = a.worst?.count ?? 0;
        const cb = b.worst?.count ?? 0;
        if (ca !== cb) return cb - ca;
        return a.item.createdAt - b.item.createdAt;
      });
    } else if (tab === "approved" || tab === "rejected") {
      list = list.slice().sort((a, b) => (b.review?.createdAt ?? 0) - (a.review?.createdAt ?? 0));
    } else {
      list = list.slice().sort((a, b) => b.item.createdAt - a.item.createdAt);
    }
    return list;
  }, [rows, tab, query]);

  const counts = useMemo(() => {
    const c: Record<QueueStatus, number> = { generating: 0, pending: 0, approved: 0, rejected: 0 };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  const stampStats = useMemo(() => {
    if (reviews.length === 0) return null;
    const avg = reviews.reduce((a, r) => a + r.secondsOnPage, 0) / reviews.length;
    const fast = reviews.filter((r) => {
      const item = queue.find((q) => q.id === r.pageId);
      const check = item && CHECKS[checkIdOf(item.file)];
      if (!check) return false;
      const risky = severityOf(check).some((f) => f.severity === "critical" || f.severity === "warning");
      return risky && r.secondsOnPage < 8;
    });
    return { n: reviews.length, avg, fast: fast.length };
  }, [reviews, queue]);

  const idx = Math.min(focusIdx, Math.max(0, filtered.length - 1));

  function openRow(id: string) {
    navigate(`/legacy/teacher/review/${encodeURIComponent(id)}`);
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      openRow(filtered[idx].item.id);
    }
  }

  return (
    <div className="teacher">
      <div className="teacher-head">
        <div className="teacher-head-row">
          <p className="brand">
            <span className="brand-mark">
              Jump<span className="accent">AIS</span>
            </span>
            <span className="teacher-tag">ห้องครู</span>
          </p>
          <div className="teacher-head-actions">
            <input
              className="reviewer-input"
              value={reviewerName}
              onChange={(e) => setReviewerName(e.target.value)}
              placeholder="ชื่อผู้ตรวจ"
              aria-label="ชื่อผู้ตรวจ"
            />
            <Link to="/legacy" className="ghost-btn">
              มุมมองนักเรียน
            </Link>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                if (confirm("ล้างข้อมูลตัวอย่างทั้งหมดและเริ่มใหม่?")) resetDemoData();
              }}
            >
              รีเซ็ตข้อมูลตัวอย่าง
            </button>
          </div>
        </div>

        <form
          className="submit-box"
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            submitProblem(t);
            setText("");
          }}
        >
          <textarea
            className="submit-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="พิมพ์โจทย์ที่นี่ เช่น จงหาพื้นที่ของสามเหลี่ยม ABC เมื่อ..."
            rows={2}
          />
          <button type="submit" className="submit-btn" disabled={!text.trim()}>
            ส่งเข้าคิว
          </button>
        </form>
        <p className="submit-note">
          สเตจนี้ยังไม่มีโมเดลจริง: การส่งโจทย์จะสุ่มยืมหน้าและรายงานจาก 68
          หน้าโจทย์จริงมาให้ตรวจ เพื่อสาธิตขั้นตอนทั้งหมดโดยไม่ต้องเรียกโมเดล
        </p>
      </div>

      {stampStats && (
        <div className={`stamp-banner${stampStats.fast > 0 ? " stamp-warn" : ""}`}>
          <span>
            ตรวจไปแล้ว {stampStats.n} หน้า · เฉลี่ย {formatSeconds(stampStats.avg)}/หน้า
          </span>
          {stampStats.fast > 0 && (
            <span className="stamp-flag">
              เร็วผิดปกติ {stampStats.fast} หน้า (ตรวจไม่ถึง 8 วิ ทั้งที่มีปัญหาให้ดู) —
              อาจเป็นการ rubber-stamp
            </span>
          )}
        </div>
      )}

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tab-btn${tab === t.key ? " tab-active" : ""}`}
            onClick={() => {
              setTab(t.key);
              setFocusIdx(0);
            }}
          >
            {t.label}
            <span className="tab-count">
              {t.key === "all" ? rows.length : t.key === "pending" ? counts.pending + counts.generating : counts[t.key]}
            </span>
          </button>
        ))}
        <input
          className="queue-search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setFocusIdx(0);
          }}
          placeholder="ค้นหาชื่อโจทย์…"
          aria-label="ค้นหาในคิว"
        />
      </div>

      <div
        className="queue-list"
        ref={listRef}
        tabIndex={0}
        role="listbox"
        aria-label="คิวรอตรวจ"
        onKeyDown={onListKeyDown}
      >
        {filtered.length === 0 && <p className="queue-empty">ไม่มีรายการในหมวดนี้</p>}
        {filtered.map((r, i) => {
          const topFlags = r.check
            ? severityOf(r.check)
                .filter((f) => f.severity !== "clean")
                .slice(0, 3)
            : [];
          return (
            <div
              key={r.item.id}
              role="option"
              aria-selected={i === idx}
              className={`queue-row${i === idx ? " queue-row-focus" : ""}${
                r.item.job === "generating" ? " queue-row-generating" : ""
              }`}
              onClick={() => openRow(r.item.id)}
              onMouseEnter={() => setFocusIdx(i)}
            >
              <StatusBadge status={r.status} />
              <div className="queue-main">
                <div className="queue-title-row">
                  <span className="queue-title">{r.item.title}</span>
                  {r.item.source === "submitted" && <span className="source-tag">ส่งเอง</span>}
                </div>
                {r.item.job === "generating" ? (
                  <span className="queue-generating">
                    <span className="spinner" /> กำลังจำลองการสร้างหน้า…
                  </span>
                ) : (
                  <div className="queue-flags">
                    {topFlags.length === 0 ? (
                      <span className="chip sev-clean">ไม่พบปัญหาที่ตรวจจับได้</span>
                    ) : (
                      topFlags.map((f) => <SeverityChip key={f.key} label={f.label} count={f.count} severity={f.severity} />)
                    )}
                  </div>
                )}
              </div>
              <div className="queue-meta">
                <span className="queue-time">{relativeTime(r.item.createdAt)}</span>
                {r.review && (
                  <span className="queue-seconds" title="seconds_on_page">
                    ใช้เวลา {formatSeconds(r.review.secondsOnPage)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
