/* Figma node 48:6460 "Chat" — the student's view of one lesson: the animation
 * for one problem, three suggested follow-up questions, an input, and
 * "N จาก M โจทย์" navigation between the lesson's problems.
 *
 * When the backend is up, the problem set comes from
 * GET /lessons/{id}/problems?approved_only=true (see lib/api.ts) — a problem
 * whose page a teacher has not approved is not merely hidden here, it is
 * absent from the response (and, per main.py's list_problems, that endpoint
 * returns nothing at all unless the lesson itself is published). That is the
 * confirmation gate from the teacher side actually taking effect here: this
 * screen has no way to reach an unapproved page, by construction, not by a
 * check this component happens to run.
 *
 * Falls back to studentVisibleFiles() (lib/chat.ts) — the lesson's seeded
 * pageFiles plus any thread a teacher has locally published — when the
 * backend is down or this lesson id is unknown to it, the same isLive()
 * pattern used throughout lib/api.ts and lib/chat.ts.
 *
 * The composer and the three suggested chips ask POST /pages/{page_id}/ask
 * (see lib/api.ts's askPage) — context is assembled server-side from the
 * *approved* page only, never a fresh solve, and the answer cites step
 * numbers back. Those citations are the whole safety story of this feature:
 * the chat itself went through no review, but the page it points at did — so
 * every cite is rendered as something a student can act on (jumpToStep below
 * scrolls the animation into view and flags the step to go check), not just
 * printed as a number. Asking is only possible when the current item carries
 * a real backend pageId (see Item below); otherwise, and on any failure, this
 * says so in the conversation rather than fabricating an answer — never a
 * silent fallback to canned copy. */
import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { MathText } from "../../components/Math";
import { ArtifactCard, ArtifactViewer } from "../../components/Artifact";
import { useSession } from "../../lib/session";
import { classroomOf, lessonsOf, useClassroomStore } from "../../lib/classroom";
import { useChatStore, studentVisibleFiles } from "../../lib/chat";
import { api, isLive, pageSrc, ApiError, type ApiProblem } from "../../lib/api";
import { PAGES } from "../../manifest";
import angleSmallLeftUrl from "../../icons/angle-small-left.svg";
import angleSmallRightUrl from "../../icons/angle-small-right.svg";
import caretDownUrl from "../../icons/caret-down.svg";
import sendUrl from "../../icons/send.svg";

const PAGES_URL = import.meta.env.VITE_PAGES_URL ?? "http://localhost:8080";

const SUGGESTED_QUESTIONS = ["ทำไมต้องหาจุดตัดแกน X?", "จุดยอดหายังไง และทำไมสำคัญ?", "รู้ได้ยังไงว่าคว่ำหรือหงาย"];

interface Item {
  src: string;
  title: string;
  /** The real backend page id, when this item has one — only then can
   *  askPage() be called for it. Absent for a fixture stand-in (see
   *  studentVisibleFiles's fallback path), which has no row in the API to ask
   *  about at all. */
  pageId?: string;
}

interface AskMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Step numbers the answer cites, when it's a real answer. */
  cites?: number[];
  /** A demo-mode or failure notice rather than a real model answer — styled
   *  differently so it never reads as if the model actually answered. */
  notice?: boolean;
}

let askMsgCounter = 0;
function nextAskMsgId(prefix: string): string {
  askMsgCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${askMsgCounter}`;
}

type LiveProblemsState = "loading" | ApiProblem[] | null;

/** Polls GET /lessons/{id}/problems?approved_only=true.
 *
 * Three states, not two. This used to start at `null`, indistinguishable from
 * "checked, and the backend has never heard of this lesson" — a caller that
 * redirects away on that would fire on literally every first render, before
 * the fetch below gets a chance to run, sending a student straight back to
 * /s off a lesson that was about to load fine. "loading" means "don't decide
 * yet"; `null` means the check actually finished and came back empty —
 * backend down, or this lessonId is unknown to it — only then should the
 * caller fall back to the local seed. */
function useLiveProblems(lessonId: string): LiveProblemsState {
  const [rows, setRows] = useState<LiveProblemsState>("loading");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (await isLive()) {
        try {
          const live = await api.problems(lessonId, true);
          if (!cancelled) setRows(live);
          return;
        } catch {
          /* fall through to offline */
        }
      }
      if (!cancelled) setRows(null);
    }
    void load();
    const t = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [lessonId]);

  return rows;
}

/** The classroom name and lesson title for the header, from the same API —
 *  needed because a lesson reached via StudentClassroomLessons's live path
 *  may have no counterpart at all in this browser's local classroom.ts seed
 *  (different, server-issued ids — see that screen's comment). Null falls
 *  back to the local classroom/lesson objects the caller already has. */
function useLiveLessonMeta(classroomId: string, lessonId: string): { classroomName: string; lessonTitle: string } | null {
  const [meta, setMeta] = useState<{ classroomName: string; lessonTitle: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (await isLive()) {
        try {
          const [classrooms, lessons] = await Promise.all([api.classrooms(), api.lessons(classroomId, true)]);
          const c = classrooms.find((x) => x.id === classroomId);
          const l = lessons.find((x) => x.id === lessonId);
          if (!cancelled && c && l) {
            setMeta({ classroomName: c.name, lessonTitle: l.title });
            return;
          }
        } catch {
          /* fall through to offline */
        }
      }
      if (!cancelled) setMeta(null);
    }
    void load();
    const t = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [classroomId, lessonId]);

  return meta;
}

export default function StudentLessonChat() {
  const { user } = useSession();
  const { classroomId = "", lessonId = "" } = useParams();
  const navigate = useNavigate();
  const classroomState = useClassroomStore();
  const chatState = useChatStore();
  const liveProblems = useLiveProblems(lessonId);
  const liveMeta = useLiveLessonMeta(classroomId, lessonId);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [asking, setAsking] = useState(false);
  // Set briefly when a citation chip is clicked (see jumpToStep) so the stage
  // can flag which step to go check — the only "acting on a citation" this
  // screen can offer without reaching into the sandboxed page itself (see
  // module comment and docs/BUILD-PLAN.html: allow-scripts only, deliberately
  // no allow-same-origin).
  const [highlightStep, setHighlightStep] = useState<number | null>(null);

  // Hooks below run unconditionally, before either early-return guard, so this
  // component's hook count can't change from one render to the next.
  const classroom = classroomOf(classroomState, classroomId);
  const lessons = lessonsOf(classroomState, classroomId);
  const lesson = lessons.find((l) => l.id === lessonId);

  // "loading" is a truthy string, not data — pin down the actual array (or
  // null) once so the rest of the component can't mistake "haven't checked
  // yet" for "checked, and it's empty" (see useLiveProblems's comment).
  const liveData = liveProblems === "loading" ? null : liveProblems;

  const items: Item[] = useMemo(() => {
    if (liveData) {
      return liveData
        .filter((p) => p.page?.html_path)
        .map((p) => ({
          src: pageSrc(p.page!.html_path!, "generated"),
          title: p.text || `โจทย์ข้อที่ ${p.position + 1}`,
          pageId: p.page!.id,
        }));
    }
    if (!lesson) return [];
    const files = studentVisibleFiles(chatState, classroomId, lessonId, lesson.pageFiles);
    return files.map((file) => {
      const thread = [...chatState.threads]
        .filter((t) => t.classroomId === classroomId && t.lessonId === lessonId && t.file === file)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      const title = thread ? thread.title : PAGES.find((p) => p.file === file)?.title ?? file;
      const src = thread ? pageSrc(file, thread.kind ?? "fixture") : `${PAGES_URL}/pages/${file}`;
      // A locally-published thread can still carry a real pageId (see
      // lib/chat.ts's publishThread) even when this lesson didn't come from
      // the live-problems path — asking should work there too, not only when
      // liveData resolved.
      return { src, title, pageId: thread?.pageId };
    });
  }, [liveData, lesson, chatState, classroomId, lessonId]);

  // A new problem is a new context on the server (the ask endpoint assembles
  // it from that page alone) — carrying a conversation about problem 1 over
  // to problem 2's page would be actively misleading, so it resets whenever
  // the item actually backing the conversation changes.
  const currentKey = items.length ? items[Math.min(index, items.length - 1)].pageId ?? items[Math.min(index, items.length - 1)].src : undefined;
  useEffect(() => {
    setMessages([]);
    setHighlightStep(null);
  }, [currentKey]);

  if (!user) return <Navigate to="/login" replace />;
  // Only bail out once the live check has actually finished (or there was
  // never a backend to check) — while it's still in flight, wait rather than
  // guess this lesson doesn't exist anywhere.
  if (liveProblems === "loading" && (!classroom || !lesson)) {
    return (
      <AppShell wide>
        <p className="classroom-empty">กำลังโหลด…</p>
      </AppShell>
    );
  }
  // A live lesson (reached via StudentClassroomLessons's API path) may not
  // exist in this browser's local seed at all — only bail out to /s when
  // NEITHER source knows this lesson.
  if (!liveData && (!classroom || !lesson)) return <Navigate to="/s" replace />;

  const clampedIndex = Math.min(index, Math.max(0, items.length - 1));
  const item = items[clampedIndex];
  const title = item?.title ?? "";
  const classroomName = liveMeta?.classroomName ?? classroom?.name ?? "ห้องเรียน";
  const lessonTitle = liveMeta?.lessonTitle ?? lesson?.title ?? "บทเรียน";

  async function sendQuestion(raw: string) {
    const question = raw.trim();
    if (!question || asking) return;
    setText("");
    setMessages((m) => [...m, { id: nextAskMsgId("u"), role: "user", text: question }]);

    if (!item?.pageId) {
      // No real page behind this item — a fixture stand-in, or a thread that
      // never made it live (see attachLiveJob in lib/chat.ts). There is no
      // approved page to assemble an answer from, so say that plainly instead
      // of inventing one.
      setMessages((m) => [
        ...m,
        {
          id: nextAskMsgId("a"),
          role: "assistant",
          text: "โหมดสาธิต: โจทย์นี้ยังไม่เชื่อมกับระบบถาม-ตอบจริง (ต้องเป็นหน้าที่สร้างและอนุมัติจากเซิร์ฟเวอร์จริงเท่านั้น)",
          notice: true,
        },
      ]);
      return;
    }

    setAsking(true);
    try {
      const res = await api.askPage(item.pageId, question);
      setMessages((m) => [...m, { id: nextAskMsgId("a"), role: "assistant", text: res.answer, cites: res.cites }]);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      const text =
        status === 409
          ? "หน้านี้ยังไม่ผ่านการตรวจจากครู จึงยังถามไม่ได้ในตอนนี้"
          : "ระบบถาม-ตอบไม่พร้อมใช้งานตอนนี้ ลองใหม่อีกครั้งภายหลัง";
      setMessages((m) => [...m, { id: nextAskMsgId("a"), role: "assistant", text, notice: true }]);
    } finally {
      setAsking(false);
    }
  }

  /** The one thing a citation lets a student do without this screen reaching
   *  into the sandboxed page (forbidden — see the module comment): open the
   *  animation and name the step to go check by hand. It opens the artifact
   *  rather than scrolling to it, because a citation is only useful with the
   *  page in front of you. */
  function jumpToStep(step: number) {
    setOpen(true);
    setHighlightStep(step);
    window.setTimeout(() => setHighlightStep((s) => (s === step ? null : s)), 6000);
  }

  return (
    <AppShell wide>
      <div className="chat-shell chat-shell-noside">
        <div className="chat-main">
          <div className="lesson-chat-topbar">
            <button type="button" className="chat-sidebar-back" onClick={() => navigate(`/s/c/${classroomId}`)}>
              <img src={angleSmallLeftUrl} alt="" width={20} height={20} />
              <span>กลับไปยัง {classroomName}</span>
            </button>

            <div className="lesson-chat-lesson">
              <div>
                <p className="chat-lesson-eyebrow">บทที่</p>
                <p className="chat-lesson-name">{lessonTitle}</p>
              </div>
              <img src={caretDownUrl} alt="" width={20} height={20} />
              {lessons.length > 1 && (
                <select
                  className="chat-lesson-select"
                  aria-label="เลือกบทเรียน"
                  value={lessonId}
                  onChange={(e) => {
                    navigate(`/s/c/${classroomId}/lessons/${e.target.value}`);
                    setIndex(0);
                  }}
                >
                  {lessons.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.title}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {items.length > 0 && (
              <div className="lesson-chat-nav">
                <button
                  type="button"
                  className="lesson-chat-nav-btn"
                  disabled={clampedIndex === 0}
                  onClick={() => {
                    setIndex((i) => Math.max(0, i - 1));
                  }}
                  aria-label="โจทย์ก่อนหน้า"
                >
                  <img src={angleSmallLeftUrl} alt="" width={20} height={20} />
                </button>
                <span className="lesson-chat-nav-title">
                  <MathText text={title} inline />
                </span>
                <span className="lesson-chat-nav-count">
                  {clampedIndex + 1} จาก {items.length} โจทย์
                </span>
                <button
                  type="button"
                  className="lesson-chat-nav-btn"
                  disabled={clampedIndex >= items.length - 1}
                  onClick={() => {
                    setIndex((i) => Math.min(items.length - 1, i + 1));
                  }}
                  aria-label="โจทย์ถัดไป"
                >
                  <img src={angleSmallRightUrl} alt="" width={20} height={20} />
                </button>
              </div>
            )}
          </div>

          {!item ? (
            <div className="chat-scroll">
              <p className="classroom-empty">บทเรียนนี้ยังไม่มีโจทย์ที่เผยแพร่แล้ว</p>
            </div>
          ) : (
            /* The animation is an artifact in the conversation, not a panel
               competing with it. Stacked in one column every question pushed
               the page further up until it was a sliver; split into two columns
               it was permanently half a screen wide. As a card it stays put at
               the top of the thread, and one click gives it the whole
               viewport — which is the size this content actually wants. */
            <div className="chat-scroll">
              <div className="chat-thread">
                <div className="artifact-block artifact-block-pinned">
                  <ArtifactCard
                    title={title}
                    kicker="สื่อการสอนแบบเคลื่อนไหว"
                    status={<span className="artifact-card-hint">คลิกเพื่อดูภาพเคลื่อนไหวแบบเต็มจอ</span>}
                    onOpen={() => setOpen(true)}
                  />
                </div>

                {/* The conversation itself — a real answer from
                    POST /pages/{'{'}page_id{'}'}/ask when item.pageId exists,
                    a visible notice otherwise. Never a fabricated answer. */}
                {messages.length > 0 && (
                  <div className="lesson-chat-messages">
                    {messages.map((m) => (
                      <div
                        key={m.id}
                        className={
                          m.role === "user" ? "chat-msg-user" : `chat-msg-assistant${m.notice ? " chat-msg-notice" : ""}`
                        }
                      >
                        {/* The tutor answers in LaTeX, the same notation the page
                            uses. Rendering it as raw "$v_y^2 = u_y^2 - 2gH$" put
                            the notation a student is trying to learn on screen as
                            noise. A notice is plain prose and needs no renderer. */}
                        {m.notice ? m.text : <MathText text={m.text} />}
                        {!!m.cites?.length && (
                          <div className="chat-cite-row">
                            <span className="chat-cite-label">อ้างอิง:</span>
                            {m.cites.map((n) => (
                              <button key={n} type="button" className="chat-cite-chip" onClick={() => jumpToStep(n)}>
                                ขั้นตอนที่ {n}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                    {asking && (
                      <div className="chat-msg-assistant chat-msg-notice">
                        <span className="spinner" /> กำลังค้นคำตอบจากหน้านี้…
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {open && item ? (
            <ArtifactViewer
              title={title}
              subtitle={`${clampedIndex + 1} จาก ${items.length} โจทย์ · ${lessonTitle}`}
              src={item.src}
              onClose={() => setOpen(false)}
              /* Never reaches into the sandboxed frame (allow-scripts only, no
                 allow-same-origin — see the module comment) — it just names the
                 step of the animation to go check by hand, which is the whole
                 point of a citation. */
              flag={highlightStep !== null ? `ตรวจสอบคำตอบกับขั้นตอนที่ ${highlightStep} ในสื่อนี้` : undefined}
            />
          ) : null}

          <div className="student-chat-input-dock">
            {item && (
              <div className="lesson-chat-suggested">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button key={q} type="button" className="lesson-chat-chip" disabled={asking} onClick={() => sendQuestion(q)}>
                    {q}
                  </button>
                ))}
              </div>
            )}

            <div className="chat-input-bar">
              <div className="chat-input-row">
                <input
                  className="chat-input-field"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (text.trim()) void sendQuestion(text);
                    }
                  }}
                  placeholder="พิมพ์คำถามเกี่ยวกับโจทย์นี้"
                  disabled={asking}
                />
                <button
                  type="button"
                  className="chat-input-send"
                  onClick={() => text.trim() && sendQuestion(text)}
                  disabled={!text.trim() || asking}
                  aria-label="ส่ง"
                >
                  <img src={sendUrl} alt="" width={20} height={20} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
