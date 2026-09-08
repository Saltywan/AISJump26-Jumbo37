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
import { useNavigate } from "react-router-dom";
import { ArtifactCard, ArtifactViewer } from "./Artifact";
import { MathText } from "./Math";
import { EffortSelect } from "./ui";
import { SimilarProblemModal } from "./SimilarProblemModal";
import { ReportSummary } from "../pages/chat/ReportSummary";
import { api, pageKindOf, pageSrc, watchJob, type ApiProblem, type Effort, ApiError } from "../lib/api";
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
  revising: "กำลังแก้ไขหน้า",
  done: "เสร็จแล้ว",
  failed: "ไม่สำเร็จ",
};

// Ask defaults to low — a question answered strictly from stored page text
// is not reasoning-heavy by design (see worker.py's TUTOR_SYSTEM_PROMPT).
// Revise refuses low, same floor as fresh generation (see main.py's
// _validate_effort) — a revision is a real generation-class model call.
const ASK_EFFORT_OPTIONS = ["low", "high"] as const;
const REVISE_EFFORT_OPTIONS = ["medium", "high"] as const;

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
  const navigate = useNavigate();
  const page = problem.page!;
  const src = page.html_path ? pageSrc(page.html_path, pageKindOf(page)) : undefined;
  const canReview = isAdmin && problem.scope === "global" && page.status === "ready";
  // Personal content only, for now — global content is admin-managed and a
  // revision of an approved page needs to go back through review before
  // replacing what's published, which needs its own pass (see docs/BACKLOG.md).
  const canRevise = isMine && problem.scope === "personal" && page.status === "ready";
  // Same gate as the tutor chat — deliberately: a variant is a NEW problem
  // this creates in the CALLER's own library, never a write to the source,
  // so a global page is a valid source for anyone who can read it (unlike
  // revision, which mutates the source and stays personal-only). An admin
  // mid-review of a `ready` global page gets canAsk===false here too, on
  // purpose — spawning a personal variant is not a reviewing action.
  const canGenerateSimilar = canAsk;
  const [reviewing, setReviewing] = useState(false);
  const [showSimilarModal, setShowSimilarModal] = useState(false);
  const [similarNotice, setSimilarNotice] = useState(false);

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

  // No SSE stream for this one, unlike a revision — a variant lands on a
  // DIFFERENT page somewhere else in the library, so there is nothing on
  // THIS screen to wait for. Library.tsx/SectionView.tsx already poll every
  // 4s and already render the "กำลังสร้างสื่อการสอน…" card for any problem
  // with no page yet, so the destination animates itself with no new code —
  // this banner is just a pointer to go look, not a progress display.
  const similarBanner = similarNotice ? (
    <div className="gen-card-extracted">
      <div className="gen-card-extracted-body">
        <p className="gen-card-extracted-label">กำลังสร้างโจทย์ใหม่ — ใช้เวลาประมาณ 1 นาที</p>
        <button
          type="button"
          className="raw-toggle"
          onClick={() => {
            onClose();
            navigate("/");
          }}
        >
          ดูได้ที่ห้องสมุด
        </button>
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
    <>
      <ArtifactViewer
        title={problem.text || "โจทย์"}
        subtitle={
          (problem.scope === "global" ? "คลังข้อสอบกลาง" : "ของฉัน") +
          (problem.generated_from ? " · สร้างจากโจทย์ต้นทาง" : "")
        }
        src={src}
        onClose={onClose}
        banner={
          extracted || similarBanner ? (
            <>
              {extracted}
              {similarBanner}
            </>
          ) : undefined
        }
        aside={
          isAdmin && problem.scope === "global" ? (
            page.checks ? <ReportSummary check={page.checks as CheckRow} /> : <p className="report-caveat">ยังไม่มีรายงานผลตรวจ</p>
          ) : canAsk ? (
            <AskPanel pageId={page.id} sourceEffort={page.effort} canRevise={canRevise} onRevised={onChanged} />
          ) : undefined
        }
        asideLabel={isAdmin && problem.scope === "global" ? "รายงานการตรวจ" : "ถามคำถาม"}
        actions={({ loaded }) => (
          <>
            {canGenerateSimilar ? (
              // Same class as ลบ/ปฏิเสธ below, not ui-btn — mixing a
              // different button primitive into this row made the three
              // visually mismatched (different height and padding, which
              // also let this one get covered by a neighbour at some
              // widths — real mouse clicks missed it even though it looked
              // present). No icon either: plus-small.svg is hardcoded
              // fill="white" for use on a filled/primary background (see
              // Library.tsx's use of it on Button variant="primary"); on
              // this light chat-unpublish-btn background it was invisible.
              // ปฏิเสธ is already icon-less in this exact row, so a
              // text-only button here is consistent, not a compromise.
              <button type="button" className="chat-unpublish-btn" onClick={() => setShowSimilarModal(true)}>
                ขอโจทย์คล้ายกัน
              </button>
            ) : null}
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
      {showSimilarModal ? (
        <SimilarProblemModal
          problem={problem}
          onClose={() => setShowSimilarModal(false)}
          onCreated={() => {
            setShowSimilarModal(false);
            setSimilarNotice(true);
          }}
        />
      ) : null}
    </>
  );
}

/** Not keyed on pageId by the caller (see Expanded above) — a revision
 *  changes pageId under this same mounted instance, on purpose, so the
 *  conversation survives the page it was about being replaced. That's the
 *  entire point of "fix it in the same thread": remounting on pageId change
 *  would wipe the thread at exactly the moment the feature fires. */
function AskPanel({
  pageId,
  sourceEffort,
  canRevise,
  onRevised,
}: {
  pageId: string;
  sourceEffort: string | null;
  /** Personal content at `ready` only — see Expanded's canRevise. When false
   *  this renders byte-identical to the question-only panel from before
   *  revision existed. */
  canRevise: boolean;
  /** Called once a personal revision lands, so the caller re-fetches and
   *  this component's own `pageId` prop starts pointing at the new page. */
  onRevised?: () => void;
}) {
  const [mode, setMode] = useState<"ask" | "revise">("ask");
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [askEffort, setAskEffort] = useState<Effort>("low");
  const [reviseEffort, setReviseEffort] = useState<Effort>(
    sourceEffort === "medium" || sourceEffort === "high" ? sourceEffort : "high"
  );

  function pushNotice(text: string) {
    askCounter += 1;
    setMessages((m) => [...m, { id: `n${askCounter}`, role: "assistant", notice: true, text }]);
  }

  async function ask(question: string) {
    askCounter += 1;
    setMessages((m) => [...m, { id: `u${askCounter}`, role: "user", text: question }]);
    setBusy(true);
    try {
      const res = await api.askPage(pageId, question, askEffort);
      askCounter += 1;
      setMessages((m) => [...m, { id: `a${askCounter}`, role: "assistant", text: res.answer, cites: res.cites }]);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      pushNotice(status === 409 ? "หน้านี้ยังถามไม่ได้ในตอนนี้" : "ระบบถาม-ตอบไม่พร้อมใช้งาน ลองใหม่อีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  async function revise(instruction: string) {
    askCounter += 1;
    setMessages((m) => [...m, { id: `u${askCounter}`, role: "user", text: `ขอให้แก้ไข: ${instruction}` }]);
    setBusy(true);
    try {
      const { job_id } = await api.revisePage(pageId, instruction, reviseEffort);
      askCounter += 1;
      const statusId = `s${askCounter}`;
      setMessages((m) => [...m, { id: statusId, role: "assistant", notice: true, text: "กำลังส่งให้ AI แก้ไข…" }]);
      watchJob(
        job_id,
        (e) => {
          const label = e.stage ? STAGE_LABEL[e.stage] ?? e.stage : null;
          if (label) setMessages((m) => m.map((msg) => (msg.id === statusId ? { ...msg, text: label } : msg)));
        },
        (e) => {
          setBusy(false);
          if (e.state === "failed") {
            setMessages((m) => m.map((msg) => (msg.id === statusId ? { ...msg, text: e.error || "แก้ไขไม่สำเร็จ ลองใหม่อีกครั้ง" } : msg)));
            return;
          }
          setMessages((m) => m.map((msg) => (msg.id === statusId ? { ...msg, text: "อัปเดตหน้าแล้ว" } : msg)));
          onRevised?.();
        }
      );
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      pushNotice(status === 409 ? "หน้านี้ยังแก้ไขไม่ได้ในตอนนี้" : "ส่งคำขอแก้ไขไม่สำเร็จ ลองใหม่อีกครั้ง");
      setBusy(false);
    }
  }

  function send() {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    void (mode === "revise" ? revise(value) : ask(value));
  }

  return (
    <div className="ask-panel">
      {canRevise ? (
        <div className="ask-panel-mode" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "ask"}
            className={`ask-panel-mode-btn${mode === "ask" ? " ask-panel-mode-active" : ""}`}
            onClick={() => setMode("ask")}
          >
            ถามคำถาม
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "revise"}
            className={`ask-panel-mode-btn${mode === "revise" ? " ask-panel-mode-active" : ""}`}
            onClick={() => setMode("revise")}
          >
            ขอให้แก้ไขหน้านี้
          </button>
        </div>
      ) : null}
      <div className="lesson-chat-messages">
        {messages.length === 0 ? (
          <p className="report-caveat">
            {mode === "revise" ? "บอกสิ่งที่อยากให้แก้ เช่น \"แก้ป้ายกำกับที่ทับกันในขั้นที่ 3\"" : "ถามอะไรก็ได้เกี่ยวกับข้อนี้"}
          </p>
        ) : null}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "chat-msg-user" : `chat-msg-assistant${m.notice ? " chat-msg-notice" : ""}`}>
            {m.notice ? (
              <>
                {busy && messages[messages.length - 1]?.id === m.id ? <span className="spinner" /> : null} {m.text}
              </>
            ) : (
              <MathText text={m.text} />
            )}
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
      </div>
      <div className="ask-panel-input">
        <input
          className="chat-input-field"
          value={text}
          placeholder={mode === "revise" ? "อยากให้แก้อะไร…" : "พิมพ์คำถาม…"}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <EffortSelect
          value={mode === "revise" ? reviseEffort : askEffort}
          onChange={mode === "revise" ? setReviseEffort : setAskEffort}
          options={mode === "revise" ? REVISE_EFFORT_OPTIONS : ASK_EFFORT_OPTIONS}
          disabled={busy}
        />
        <button type="button" className="chat-input-send" disabled={!text.trim() || busy} onClick={send} aria-label="ส่ง">
          <img src={sendUrl} alt="" width={18} height={18} />
        </button>
      </div>
    </div>
  );
}
