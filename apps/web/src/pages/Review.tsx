import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CHECKS } from "../checks";
import { checkIdOf, formatSeconds } from "../lib/format";
import { severityOf, type Flag } from "../lib/severity";
import { useStore, statusOf, historyOf, recordReview, type ReviewAction } from "../lib/store";
import { StatusBadge } from "../components/Chips";

// Same origin, same sandbox contract as the student viewer (see Viewer.tsx):
// allow-scripts only, no allow-same-origin. The page is opaque from here —
// that is exactly why checks.json exists, and exactly why this screen cannot
// drive the page's own step controls (no postMessage channel, no shared
// document). What it CAN do: tell the reviewer which step to look at and let
// them jump there themselves — every step card inside the page is already a
// click target (packages/kit/lib/shell.js, Shell.go(n) on click), so "go to
// step 3" is one real click once you're looking at the page, not a series of
// "next" presses.
const PAGES_URL = import.meta.env.VITE_PAGES_URL ?? "http://localhost:8080";

export default function Review() {
  const { id } = useParams<{ id: string }>();
  const { queue, reviews } = useStore();
  const navigate = useNavigate();

  const item = useMemo(() => queue.find((q) => q.id === id), [queue, id]);
  const check = item ? CHECKS[checkIdOf(item.file)] : undefined;
  const flags = useMemo(() => (check ? severityOf(check) : []), [check]);
  const history = useMemo(() => (id ? historyOf(reviews, id) : []), [reviews, id]);
  const status = item ? statusOf(item, reviews) : "pending";

  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState("");
  const [targetStep, setTargetStep] = useState<number | null>(null);
  const [rejectHint, setRejectHint] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [showRaw, setShowRaw] = useState(false);
  const mountedAt = useRef(Date.now());
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // Reset all per-item UI state when navigating from one review to the next
  // (the route element stays mounted across param changes in react-router).
  useEffect(() => {
    mountedAt.current = Date.now();
    setLoaded(false);
    setNote("");
    setTargetStep(null);
    setRejectHint(false);
    setElapsed(0);
  }, [id]);

  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.round((Date.now() - mountedAt.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [id]);

  // Ordered "what's next" queue — same worst-first ordering as the Teacher
  // list — so approving/rejecting can drop straight into the next item
  // instead of bouncing back to the queue every time.
  const nextPendingId = useMemo(() => {
    const SEV_WEIGHT = { critical: 3, warning: 2, info: 1, clean: 0 } as const;
    const pending = queue
      .filter((q) => q.id !== id && q.job === "ready" && statusOf(q, reviews) === "pending")
      .map((q) => {
        const c = CHECKS[checkIdOf(q.file)];
        const worst = c ? severityOf(c)[0] : undefined;
        return { q, weight: worst ? SEV_WEIGHT[worst.severity] : 0, count: worst?.count ?? 0 };
      })
      .sort((a, b) => b.weight - a.weight || b.count - a.count || a.q.createdAt - b.q.createdAt);
    return pending[0]?.q.id;
  }, [queue, reviews, id]);

  function submit(action: ReviewAction) {
    if (!item) return;
    if (action === "rejected" && !note.trim()) {
      setRejectHint(true);
      noteRef.current?.focus();
      return;
    }
    const seconds = (Date.now() - mountedAt.current) / 1000;
    recordReview(item.id, action, note.trim(), seconds);
    if (nextPendingId) navigate(`/legacy/teacher/review/${encodeURIComponent(nextPendingId)}`);
    else navigate("/teacher");
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      const typing = tag === "textarea" || tag === "input";
      if (e.key === "Escape") {
        if (typing) (document.activeElement as HTMLElement).blur();
        else navigate("/teacher");
        return;
      }
      if (typing) return;
      if (e.key === "a" || e.key === "A") submit("approved");
      else if (e.key === "r" || e.key === "R") submit("rejected");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, note, nextPendingId]);

  if (!item || !check) {
    return (
      <div className="not-found">
        <p>ไม่พบรายการนี้ในคิว</p>
        <Link to="/teacher">กลับไปที่คิว</Link>
      </div>
    );
  }

  const pathChosen = check.jsx ? "กระดาน (JSXGraph)" : "SVG";
  const src = `${PAGES_URL}/pages/${item.file}`;

  return (
    <div className="review">
      <div className="review-bar">
        <button type="button" className="back-btn" aria-label="กลับ" onClick={() => navigate("/teacher")}>
          ‹
        </button>
        <div className="review-title-wrap">
          <span className="review-title">{item.title}</span>
          <span className="review-meta-chips">
            {item.level && <span className="viewer-level">{item.level}</span>}
            <span className="viewer-level">{pathChosen}</span>
            <span className="viewer-level">{check.N} ขั้น</span>
            <StatusBadge status={status} />
          </span>
        </div>
        <span className="review-timer" title="seconds_on_page ที่กำลังนับ">
          ⏱ {formatSeconds(elapsed)}
        </span>
      </div>

      {item.source === "submitted" && (
        <div className="submitted-banner">
          โจทย์ที่ส่งเข้ามา: “{item.submittedText}” — หน้าที่แสดงเป็นหน้าโจทย์จริงที่สุ่มยืมมาสาธิต ไม่ได้สร้างจากข้อความนี้จริง
        </div>
      )}

      <div className="review-body">
        <div className="review-stage">
          {targetStep !== null && (
            <div className="target-banner">
              <span>
                🎯 ไปที่ <b>ขั้นที่ {targetStep}</b> — ในหน้าโจทย์ คลิกที่การ์ดขั้นที่ {targetStep} ในรายการขั้นตอน
                เพื่อกระโดดไปดูทันที (การ์ดคลิกได้ทุกขั้น ไม่ต้องกด "ถัดไป" ทีละขั้น)
              </span>
              <button type="button" className="target-dismiss" onClick={() => setTargetStep(null)} aria-label="ปิด">
                ×
              </button>
            </div>
          )}
          {!loaded && (
            <div className="viewer-loading">
              <span className="spinner" />
              กำลังโหลดโจทย์…
            </div>
          )}
          <iframe
            key={item.file + item.id}
            className="viewer-frame"
            src={src}
            title={item.title}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
          />
        </div>

        <div className="review-report">
          <p className="report-caveat">
            ตัวเลขด้านล่างเป็น<b>ข้อมูลประกอบ</b> ไม่ใช่เกณฑ์ตัดสิน — เคยมีหน้าที่ผ่านทุกการตรวจอัตโนมัติ
            (ป้ายไม่ชน, LaTeX ไม่หลุด, กระดานสร้างสำเร็จ) แต่ภาพจริงมีเส้นโค้งที่ตัดกลางอันและมีเซกเตอร์แปลกปลอมอยู่
            เห็นได้จากการดูภาพเท่านั้น — <b>ต้องดูหน้าโจทย์จริงก่อนตัดสินใจเสมอ</b>
          </p>

          {flags.map((f) => (
            <FlagSection key={f.key} flag={f} onGoToStep={setTargetStep} />
          ))}

          <details className="explain-meta">
            <summary>รายละเอียดคำอธิบายขั้นตอน</summary>
            <ul>
              <li>มีเกริ่นโจทย์ตั้งต้น (setup): {check.explain.hasSetup ? "มี" : "ไม่มี"}</li>
              <li>มีการตรวจคำตอบ (sanity check): {check.explain.hasSanity ? "มี" : "ไม่มี"}</li>
              <li>
                ขั้นที่มีเหตุผล (why): {check.explain.withWhy} / {check.explain.steps}
              </li>
              <li>
                ขั้นที่อ้างอิงค่าก่อนหน้า (uses): {check.explain.withUses} / {check.explain.steps}
              </li>
            </ul>
          </details>

          {history.length > 0 && (
            <details className="explain-meta" open>
              <summary>ประวัติการตรวจก่อนหน้า ({history.length})</summary>
              <ul>
                {history.map((h) => (
                  <li key={h.id}>
                    {new Date(h.createdAt).toLocaleString("th-TH")} — {h.reviewer}:{" "}
                    <b>{h.action === "approved" ? "อนุมัติ" : "ตีกลับ"}</b> ({formatSeconds(h.secondsOnPage)})
                    {h.note && <> — “{h.note}”</>}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <button type="button" className="raw-toggle" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "ซ่อน" : "ดู"} JSON ดิบจากเครื่องตรวจ
          </button>
          {showRaw && <pre className="raw-json">{JSON.stringify(check, null, 2)}</pre>}
        </div>
      </div>

      <div className="review-actions">
        <textarea
          ref={noteRef}
          className={`note-input${rejectHint ? " note-input-hint" : ""}`}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            if (rejectHint) setRejectHint(false);
          }}
          placeholder={rejectHint ? "ต้องระบุเหตุผลก่อนตีกลับ" : "หมายเหตุ (ไม่บังคับสำหรับอนุมัติ)"}
          rows={1}
        />
        <div className="review-buttons">
          <button type="button" className="reject-btn" onClick={() => submit("rejected")}>
            ตีกลับ <kbd>R</kbd>
          </button>
          <button type="button" className="approve-btn" onClick={() => submit("approved")}>
            อนุมัติ <kbd>A</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

function FlagSection({ flag, onGoToStep }: { flag: Flag; onGoToStep: (n: number) => void }) {
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
              {flag.items.map((it, i) => (
                <li key={i}>
                  <span>{it.text}</span>
                  {it.step !== undefined && (
                    <button type="button" className="goto-chip" onClick={() => onGoToStep(it.step!)}>
                      ไปขั้นที่ {it.step}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
