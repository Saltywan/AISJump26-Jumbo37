/* One problem, rendered as an artifact — the card-in-a-list plus the
 * full-viewport ArtifactViewer it opens into (see components/Artifact.tsx for
 * why a generated page is a card and not an embed). Every screen that lists
 * problems — the library, a section, the admin review queue — renders this
 * same component rather than three slightly different versions of it, which
 * is how a screen quietly stops matching the others.
 *
 * What the viewer's side panel shows depends on who's looking, not on where
 * the card lives: an admin reviewing global content sees the check report
 * (ReportSummary) and, while it's undecided, approve/reject; anyone looking
 * at a page that's actually theirs to ask about — an approved global page,
 * or their own personal one at `ready` (no review gate applies to personal
 * content at all) — gets the tutor chat instead. Never both: the report is a
 * reviewing tool, not something a student or a personal user needs to see.
 */
import { useState } from "react";
import { ArtifactCard, ArtifactViewer } from "./Artifact";
import { MathText } from "./Math";
import { ReportSummary } from "../pages/chat/ReportSummary";
import { api, pageKindOf, pageSrc, type ApiProblem, ApiError } from "../lib/api";
import type { CheckRow } from "../checks";
import globeUrl from "../icons/globe.svg";
import globeOnPrimaryUrl from "../icons/globe-on-primary.svg";
import lockUrl from "../icons/lock.svg";
import exclamationUrl from "../icons/exclamation.svg";
import sendUrl from "../icons/send.svg";
import trashUrl from "../icons/trash.svg";

const STAGE_LABEL: Record<string, string> = {
  queued: "เข้าคิวแล้ว",
  generating: "กำลังให้ AI เขียนหน้า",
  checking: "กำลังตรวจหน้าที่สร้าง",
  done: "เสร็จแล้ว",
  failed: "ไม่สำเร็จ",
};

interface AskMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  cites?: number[];
  notice?: boolean;
}
let askCounter = 0;

export function ProblemArtifact({
  problem,
  isAdmin,
  isMine,
  onChanged,
}: {
  problem: ApiProblem;
  /** Can approve/reject global content and see its check report. */
  isAdmin: boolean;
  /** This is the viewer's own personal problem — offers delete and, once the
   *  page is ready, the tutor chat. */
  isMine: boolean;
  /** Called after a review decision or a delete, so the caller can refetch
   *  rather than this component guessing how its parent's list is shaped. */
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const page = problem.page;

  if (!page) {
    return (
      <div className="gen-card">
        <div className="gen-card-generating">
          <span className="spinner" /> กำลังสร้างสื่อการสอน…
          {problem.job?.stage ? (
            <span className="gen-card-stage-label">{STAGE_LABEL[problem.job.stage] ?? problem.job.stage}</span>
          ) : null}
        </div>
      </div>
    );
  }

  const canAsk = page.status === "approved" || (isMine && problem.scope === "personal" && page.status === "ready");
  const statusNote =
    problem.scope === "global" ? (
      page.status === "approved" ? (
        <span className="chat-published-note">
          <img src={globeUrl} alt="" width={16} height={16} /> เผยแพร่แล้ว
        </span>
      ) : page.status === "rejected" ? (
        <span className="chat-draft-note">ถูกปฏิเสธ</span>
      ) : (
        <span className="chat-draft-note">
          <img src={lockUrl} alt="" width={16} height={16} /> รอตรวจ
        </span>
      )
    ) : null;

  return (
    <div className="artifact-block">
      <ArtifactCard
        title={problem.text || "โจทย์"}
        kicker="สื่อการสอนแบบเคลื่อนไหว"
        status={statusNote}
        onOpen={() => page.html_path && setOpen(true)}
      />
      {open ? (
        <Expanded problem={problem} isAdmin={isAdmin} isMine={isMine} canAsk={canAsk} onChanged={onChanged} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}

function Expanded({
  problem,
  isAdmin,
  isMine,
  canAsk,
  onChanged,
  onClose,
}: {
  problem: ApiProblem;
  isAdmin: boolean;
  isMine: boolean;
  canAsk: boolean;
  onChanged?: () => void;
  onClose: () => void;
}) {
  const page = problem.page!;
  const src = page.html_path ? pageSrc(page.html_path, pageKindOf(page)) : undefined;
  const canReview = isAdmin && problem.scope === "global" && page.status === "ready";
  const [reviewing, setReviewing] = useState(false);

  async function decide(action: "approved" | "rejected", openedAt: number) {
    setReviewing(true);
    try {
      const secondsOnPage = Math.max(0, Math.round((Date.now() - openedAt) / 1000));
      await api.review(page.id, { action, seconds_on_page: secondsOnPage });
      onChanged?.();
      onClose();
    } finally {
      setReviewing(false);
    }
  }

  async function remove() {
    if (!confirm(`ลบ "${problem.text ?? "โจทย์นี้"}" ใช่ไหม?`)) return;
    await api.deleteProblem(problem.id);
    onChanged?.();
    onClose();
  }

  const extracted =
    problem.source === "image" && problem.extracted_text ? (
      <div className="gen-card-extracted">
        <div className="gen-card-extracted-body">
          <p className="gen-card-extracted-label">
            <img src={exclamationUrl} alt="" width={14} height={14} />
            โจทย์ที่ระบบอ่านได้จากรูป — ตรวจให้ตรงกับภาพก่อนเชื่อคำตอบ
          </p>
          <p className="gen-card-extracted-text">{problem.extracted_text}</p>
        </div>
      </div>
    ) : null;

  // The card's onOpen only fires with html_path present (ProblemArtifact
  // above), so this component is never actually mounted without one — but
  // the type is still Optional, and `src` must be a string before we're past
  // this point either way.
  if (!src) return null;
  const openedAt = Date.now();

  return (
    <ArtifactViewer
      title={problem.text || "โจทย์"}
      subtitle={problem.scope === "global" ? "คลังข้อสอบกลาง" : "ของฉัน"}
      src={src}
      onClose={onClose}
      banner={extracted}
      aside={
        isAdmin && problem.scope === "global" ? (
          page.checks ? <ReportSummary check={page.checks as CheckRow} /> : <p className="report-caveat">ยังไม่มีรายงานผลตรวจ</p>
        ) : canAsk ? (
          <AskPanel pageId={page.id} />
        ) : undefined
      }
      asideLabel={isAdmin && problem.scope === "global" ? "รายงานการตรวจ" : "ถามคำถาม"}
      actions={({ loaded }) => (
        <>
          {isMine ? (
            <button type="button" className="chat-unpublish-btn" onClick={() => void remove()}>
              <img src={trashUrl} alt="" width={16} height={16} />
              <span>ลบ</span>
            </button>
          ) : null}
          {canReview ? (
            <>
              <button
                type="button"
                className="chat-unpublish-btn"
                disabled={!loaded || reviewing}
                onClick={() => void decide("rejected", openedAt)}
              >
                ปฏิเสธ
              </button>
              <button
                type="button"
                className="chat-publish-btn"
                disabled={!loaded || reviewing}
                title={!loaded ? "รอโหลดหน้าให้เสร็จก่อน" : undefined}
                onClick={() => void decide("approved", openedAt)}
              >
                <img src={globeOnPrimaryUrl} alt="" width={16} height={16} />
                <span>อนุมัติ</span>
              </button>
            </>
          ) : null}
        </>
      )}
    />
  );
}

function AskPanel({ pageId }: { pageId: string }) {
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [asking, setAsking] = useState(false);

  async function send(raw: string) {
    const question = raw.trim();
    if (!question || asking) return;
    setText("");
    askCounter += 1;
    const uId = `u${askCounter}`;
    setMessages((m) => [...m, { id: uId, role: "user", text: question }]);
    setAsking(true);
    try {
      const res = await api.askPage(pageId, question);
      askCounter += 1;
      setMessages((m) => [...m, { id: `a${askCounter}`, role: "assistant", text: res.answer, cites: res.cites }]);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      askCounter += 1;
      setMessages((m) => [
        ...m,
        {
          id: `a${askCounter}`,
          role: "assistant",
          notice: true,
          text: status === 409 ? "หน้านี้ยังถามไม่ได้ในตอนนี้" : "ระบบถาม-ตอบไม่พร้อมใช้งาน ลองใหม่อีกครั้ง",
        },
      ]);
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="ask-panel">
      <div className="lesson-chat-messages">
        {messages.length === 0 ? <p className="report-caveat">ถามอะไรก็ได้เกี่ยวกับข้อนี้</p> : null}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "chat-msg-user" : `chat-msg-assistant${m.notice ? " chat-msg-notice" : ""}`}>
            {m.notice ? m.text : <MathText text={m.text} />}
            {!!m.cites?.length && (
              <div className="chat-cite-row">
                <span className="chat-cite-label">อ้างอิง:</span>
                {m.cites.map((n) => (
                  <span key={n} className="chat-cite-chip">
                    ขั้นตอนที่ {n}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {asking ? (
          <div className="chat-msg-assistant chat-msg-notice">
            <span className="spinner" /> กำลังค้นคำตอบ…
          </div>
        ) : null}
      </div>
      <div className="ask-panel-input">
        <input
          className="chat-input-field"
          value={text}
          placeholder="พิมพ์คำถาม…"
          disabled={asking}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <button type="button" className="chat-input-send" disabled={!text.trim() || asking} onClick={() => void send(text)} aria-label="ส่ง">
          <img src={sendUrl} alt="" width={18} height={18} />
        </button>
      </div>
    </div>
  );
}
