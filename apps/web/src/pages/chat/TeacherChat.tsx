/* Figma nodes 35:629 "New Chat" and 35:675 "Chat" — one component, because
 * the two frames are the same shell (navbar, 350px history sidebar, prompt
 * input pinned at the bottom) with only the main panel's content differing:
 * an empty state before a thread is picked, a populated one after. Routed as
 *   /t/c/:classroomId/lessons/:lessonId/chat            -> empty state
 *   /t/c/:classroomId/lessons/:lessonId/chat/:threadId  -> populated state
 *
 * The generated-lesson card is where the one non-negotiable product decision
 * lives: a page a teacher just generated is a "draft" — visible only here,
 * never to students — until they look at the animation AND the check report
 * below it and press "เผยแพร่ให้นักเรียน" (publish to students). See
 * lib/chat.ts's studentVisibleFiles() for where that gate is actually
 * enforced, and docs/BUILD-PLAN.html section 04 for why a report full of
 * green checks is not, by itself, grounds to skip looking at the page. */
import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { useSession } from "../../lib/session";
import { classroomOf, lessonsOf, useClassroomStore, type Lesson } from "../../lib/classroom";
import {
  useChatStore,
  threadsOf,
  threadOf,
  submitPrompt,
  attachLiveJob,
  tickThreads,
  publishThread,
  unpublishThread,
  deleteThread,
  addUserMessage,
  addAssistantMessage,
  type ChatThread,
} from "../../lib/chat";
import { CHECKS } from "../../checks";
import { checkIdOf } from "../../lib/format";
import { ReportSummary } from "./ReportSummary";
import angleSmallLeftUrl from "../../icons/angle-small-left.svg";
import caretDownUrl from "../../icons/caret-down.svg";
import caretRightUrl from "../../icons/caret-right.svg";
import plusSmallUrl from "../../icons/plus-small.svg";
import globeUrl from "../../icons/globe.svg";
import globeOnPrimaryUrl from "../../icons/globe-on-primary.svg";
import lockUrl from "../../icons/lock.svg";
import menuDotsVerticalUrl from "../../icons/menu-dots-vertical.svg";
import sendUrl from "../../icons/send.svg";

import { pageSrc } from "../../lib/api";

/* "บทที่ 1: การเคลื่อนที่แบบโปรเจกไทล์" -> ("บทที่ 1", "การเคลื่อนที่แบบโปรเจกไทล์"),
   matching the two-line eyebrow/title the sidebar and topbar both use. Falls
   back to showing the whole title on the second line if there's no colon. */
function splitLessonTitle(title: string): [string, string] {
  const i = title.indexOf(":");
  if (i < 0) return ["", title];
  return [title.slice(0, i).trim(), title.slice(i + 1).trim()];
}

function statusMeta(status: ChatThread["status"]) {
  if (status === "published") return { icon: globeUrl, label: "เผยแพร่แล้ว", cls: "chat-history-status-published" };
  if (status === "generating") return { icon: null, label: "กำลังสร้าง…", cls: "chat-history-status-generating" };
  return { icon: lockUrl, label: "ฉบับร่าง", cls: "chat-history-status-draft" };
}

function stageLabel(stage: string): string {
  const map: Record<string, string> = {
    queued: "เข้าคิวแล้ว",
    generating: "กำลังให้ AI เขียนหน้า",
    checking: "กำลังตรวจหน้าที่สร้าง",
    done: "เสร็จแล้ว",
    failed: "ไม่สำเร็จ",
    reconnecting: "กำลังเชื่อมต่อใหม่",
  };
  return map[stage] ?? stage;
}

export default function TeacherChat() {
  const { user } = useSession();
  const { classroomId = "", lessonId = "", threadId } = useParams();
  const navigate = useNavigate();
  const classroomState = useClassroomStore();
  const chatState = useChatStore();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [text, setText] = useState("");

  // Fake generation: poll for threads whose simulated delay has elapsed.
  useEffect(() => {
    const t = setInterval(tickThreads, 400);
    return () => clearInterval(t);
  }, []);

  const classroom = classroomOf(classroomState, classroomId);
  const lessons = useMemo(() => lessonsOf(classroomState, classroomId), [classroomState, classroomId]);
  const lesson = lessons.find((l: Lesson) => l.id === lessonId);
  const history = useMemo(() => threadsOf(chatState, classroomId, lessonId), [chatState, classroomId, lessonId]);
  const thread = threadId ? threadOf(chatState, threadId) : undefined;

  if (!user) return <Navigate to="/login" replace />;
  if (!classroom || !lesson) return <Navigate to={`/t/c/${classroomId}/lessons`} replace />;

  const [eyebrow, lessonTitle] = splitLessonTitle(lesson.title);

  function goNewChat() {
    setText("");
    navigate(`/t/c/${classroomId}/lessons/${lessonId}/chat`);
    setSidebarOpen(false);
  }

  function openThread(id: string) {
    navigate(`/t/c/${classroomId}/lessons/${lessonId}/chat/${id}`);
    setSidebarOpen(false);
  }

  function submit() {
    const t = text.trim();
    if (!t) return;
    if (thread) {
      // Following up inside an existing thread — no second generation, this
      // screen only ever generates one page per thread (see lib/chat.ts).
      addUserMessage(thread.id, t);
      setText("");
      window.setTimeout(
        () => addAssistantMessage(thread.id, "โหมดสาธิต: ระบบสนทนาต่อยังไม่เชื่อมกับ AI จริง — ลองกด “สร้างโจทย์ใหม่” เพื่อสร้างหน้าใหม่แทน"),
        500
      );
      return;
    }
    // Create the thread synchronously so the screen moves immediately, then let
    // the real job attach to it. Generation takes 30-90s; making the teacher
    // stare at a frozen input for that long is the thing the streamed stage
    // exists to avoid.
    const created = submitPrompt(classroomId, lessonId, t);
    setText("");
    navigate(`/t/c/${classroomId}/lessons/${lessonId}/chat/${created.id}`);
    void attachLiveJob(created.id, classroomId, lessonId, t);
  }

  return (
    <AppShell wide>
      <div className="chat-shell">
        {sidebarOpen && <div className="chat-sidebar-scrim" onClick={() => setSidebarOpen(false)} />}
        <aside className={`chat-sidebar${sidebarOpen ? " chat-sidebar-open" : ""}`}>
          <button type="button" className="chat-sidebar-back" onClick={() => navigate(`/t/c/${classroomId}/lessons`)}>
            <img src={angleSmallLeftUrl} alt="" width={20} height={20} />
            <span>กลับไปยัง {classroom.name}</span>
          </button>

          <div className="chat-lesson-picker">
            <div className="chat-lesson-select-row">
              <div>
                {eyebrow && <p className="chat-lesson-eyebrow">{eyebrow}</p>}
                <p className="chat-lesson-name">{lessonTitle}</p>
              </div>
              <img src={caretDownUrl} alt="" width={20} height={20} />
            </div>
            {lessons.length > 1 && (
              <select
                className="chat-lesson-select"
                aria-label="เลือกบทเรียน"
                value={lessonId}
                onChange={(e) => navigate(`/t/c/${classroomId}/lessons/${e.target.value}/chat`)}
              >
                {lessons.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </select>
            )}
          </div>

          <button type="button" className="ui-btn ui-btn-primary ui-btn-block" onClick={goNewChat}>
            <img src={plusSmallUrl} alt="" width={24} height={24} />
            <span>สร้างโจทย์ใหม่</span>
          </button>

          <div className="chat-history">
            <p className="chat-history-title">ประวัติการสนทนา</p>
            {history.length === 0 ? (
              <p className="chat-history-empty">ยังไม่มีการสนทนาในบทเรียนนี้</p>
            ) : (
              <div className="chat-history-list">
                {history.map((h) => {
                  const meta = statusMeta(h.status);
                  return (
                    <div
                      key={h.id}
                      className={`chat-history-item${h.id === threadId ? " chat-history-active" : ""}`}
                      onClick={() => openThread(h.id)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="chat-history-text">
                        <span className="chat-history-title-row">{h.title}</span>
                        <span className={`chat-history-status ${meta.cls}`}>
                          {meta.icon ? (
                            <img src={meta.icon} alt="" width={16} height={16} />
                          ) : (
                            <span className="spinner" />
                          )}
                          {meta.label}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="chat-history-menu"
                        aria-label="ตัวเลือกเพิ่มเติม"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`ลบ “${h.title}” ออกจากประวัติการสนทนา?`)) {
                            deleteThread(h.id);
                            if (h.id === threadId) goNewChat();
                          }
                        }}
                      >
                        <img src={menuDotsVerticalUrl} alt="" width={16} height={16} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        <div className="chat-main">
          <div className="chat-main-head">
            <button
              type="button"
              className="chat-mobile-toggle"
              onClick={() => setSidebarOpen(true)}
              aria-label="เปิดประวัติการสนทนา"
            >
              ☰
            </button>
            {thread && <PublishBar thread={thread} />}
          </div>

          <div className="chat-scroll">
            {!thread ? (
              <div className="chat-empty">
                <h2>วันนี้อยากสร้างสื่อการสอนเกี่ยวกับอะไร?</h2>
                <p>พิมพ์โจทย์คณิตศาสตร์หรือฟิสิกส์ แล้ว AI จะช่วยสร้าง Animation เพื่อให้นักเรียนเข้าใจได้ง่ายขึ้น</p>
              </div>
            ) : (
              <ThreadPanel thread={thread} />
            )}
          </div>

          <div className="chat-input-bar">
            <input
              className="chat-input-field"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="พิมพ์โจทย์ที่นี่"
            />
            <button type="button" className="chat-input-send" onClick={submit} disabled={!text.trim()} aria-label="ส่ง">
              <img src={sendUrl} alt="" width={20} height={20} />
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function PublishBar({ thread }: { thread: ChatThread }) {
  return (
    <div className="chat-topbar">
      <span className="chat-topbar-title">{thread.title}</span>
      {thread.status === "published" ? (
        <span className="chat-published-row">
          <span className="chat-published-note">
            <img src={globeUrl} alt="" width={16} height={16} /> เผยแพร่ให้นักเรียนแล้ว
          </span>
          <button type="button" className="chat-unpublish-btn" onClick={() => unpublishThread(thread.id)}>
            ยกเลิกการเผยแพร่
          </button>
        </span>
      ) : null}
    </div>
  );
}

function ThreadPanel({ thread }: { thread: ChatThread }) {
  const [loaded, setLoaded] = useState(false);
  const [replayNonce, setReplayNonce] = useState(0);
  // A worker-generated page is served from /generated/, a fixture from /pages/.
  // Only pageSrc knows that split.
  const src = thread.file ? pageSrc(thread.file, thread.kind ?? "fixture") : undefined;
  const check = thread.file ? CHECKS[checkIdOf(thread.file)] : undefined;

  return (
    <div className="chat-thread">
      {thread.messages.map((m) => (
        <div key={m.id} className={m.role === "user" ? "chat-msg-user" : "chat-msg-assistant"}>
          {m.text}
        </div>
      ))}

      {thread.status === "generating" || !src ? (
        <div className="gen-card">
          <div className="gen-card-generating">
            {/* Show the worker's stage, not a bare spinner. Generation takes
                30-90 seconds and the stages are the interesting part. */}
            <span className="spinner" /> กำลังสร้างสื่อการสอน…
            {thread.stage ? <span className="gen-card-stage-label">{stageLabel(thread.stage)}</span> : null}
          </div>
        </div>
      ) : (
        <div className="gen-card">
          {/* A fixture standing in for a real generation must say so. The
              field existed for exactly this and was never rendered, so every
              fallback looked identical to a real page. */}
          {thread.demoReason ? (
            <div className="gen-card-demo">โหมดสาธิต: {thread.demoReason}</div>
          ) : null}
          <div className="gen-card-head">
            <span className="gen-card-title">{thread.title}</span>
            <button type="button" className="gen-card-replay" onClick={() => setReplayNonce((n) => n + 1)}>
              <img src={caretRightUrl} alt="" width={20} height={20} />
              <span>เล่นอีกครั้ง</span>
            </button>
          </div>
          <div className="gen-card-stage">
            {!loaded && (
              <div className="gen-card-loading">
                <span className="spinner" /> กำลังโหลด…
              </div>
            )}
            {/* Real generated page, opaque origin: allow-scripts only, no
                allow-same-origin — see docs/BUILD-PLAN.html and Viewer.tsx. */}
            <iframe
              key={`${thread.file ?? thread.id}-${replayNonce}`}
              className="gen-card-frame"
              src={src}
              title={thread.title}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              onLoad={() => setLoaded(true)}
            />
          </div>

          {check && (
            <div className="gen-card-report">
              <ReportSummary check={check} />
            </div>
          )}

          <div className="gen-card-publish-row">
            {thread.status === "published" ? (
              <>
                <span className="chat-published-note">
                  <img src={globeUrl} alt="" width={16} height={16} /> เผยแพร่ให้นักเรียนแล้ว
                </span>
                <button type="button" className="chat-unpublish-btn" onClick={() => unpublishThread(thread.id)}>
                  ยกเลิกการเผยแพร่
                </button>
              </>
            ) : (
              <>
                <span className="chat-draft-note">
                  <img src={lockUrl} alt="" width={16} height={16} /> ฉบับร่าง — นักเรียนยังไม่เห็นหน้านี้
                </span>
                <button
                  type="button"
                  className="chat-publish-btn"
                  disabled={!loaded}
                  title={!loaded ? "รอโหลดหน้าให้เสร็จก่อน เพื่อให้ดูภาพจริงก่อนเผยแพร่" : undefined}
                  onClick={() => publishThread(thread.id)}
                >
                  <img src={globeOnPrimaryUrl} alt="" width={16} height={16} />
                  <span>เผยแพร่ให้นักเรียน</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
