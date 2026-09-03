/* Figma node 48:6460 "Chat" — the student's view of one lesson: the animation
 * for one problem, three suggested follow-up questions, an input, and
 * "N จาก M โจทย์" navigation between the lesson's problems.
 *
 * The problem set is studentVisibleFiles() (lib/chat.ts): the lesson's seeded
 * pageFiles plus any thread a teacher has *published* from the Chat screen
 * (35:675) — never a "draft" or still-"generating" one. That's the
 * confirmation gate from the teacher side actually taking effect here: this
 * screen has no way to reach an unpublished page, by construction, not by a
 * check this component happens to run.
 *
 * There is no real model behind the suggested questions or the input — they
 * are static demo copy (see the brief's instruction to be honest about that
 * rather than fabricate an answer), so both surface an explicit "demo mode"
 * notice instead of pretending to answer. */
import { useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { useSession } from "../../lib/session";
import { classroomOf, lessonsOf, useClassroomStore } from "../../lib/classroom";
import { useChatStore, studentVisibleFiles } from "../../lib/chat";
import { PAGES } from "../../manifest";
import angleSmallLeftUrl from "../../icons/angle-small-left.svg";
import angleSmallRightUrl from "../../icons/angle-small-right.svg";
import caretDownUrl from "../../icons/caret-down.svg";
import caretRightUrl from "../../icons/caret-right.svg";
import sendUrl from "../../icons/send.svg";

const PAGES_URL = import.meta.env.VITE_PAGES_URL ?? "http://localhost:8080";

const SUGGESTED_QUESTIONS = ["ทำไมต้องหาจุดตัดแกน X?", "จุดยอดหายังไง และทำไมสำคัญ?", "รู้ได้ยังไงว่าคว่ำหรือหงาย"];

export default function StudentLessonChat() {
  const { user } = useSession();
  const { classroomId = "", lessonId = "" } = useParams();
  const navigate = useNavigate();
  const classroomState = useClassroomStore();
  const chatState = useChatStore();
  const [index, setIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [replayNonce, setReplayNonce] = useState(0);
  const [text, setText] = useState("");
  const [demoNotice, setDemoNotice] = useState(false);

  if (!user) return <Navigate to="/login" replace />;
  const classroom = classroomOf(classroomState, classroomId);
  const lessons = lessonsOf(classroomState, classroomId);
  const lesson = lessons.find((l) => l.id === lessonId);
  if (!classroom || !lesson) return <Navigate to="/s" replace />;

  const files = useMemo(
    () => studentVisibleFiles(chatState, classroomId, lessonId, lesson.pageFiles),
    [chatState, classroomId, lessonId, lesson.pageFiles]
  );
  const clampedIndex = Math.min(index, Math.max(0, files.length - 1));
  const file = files[clampedIndex];

  // A published file might be a teacher-generated thread (its own asked
  // title) or one of the lesson's seeded fixtures (the manifest's title) —
  // prefer the thread's title when this file came from one.
  const title = useMemo(() => {
    if (!file) return "";
    const thread = [...chatState.threads]
      .filter((t) => t.classroomId === classroomId && t.lessonId === lessonId && t.file === file)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (thread) return thread.title;
    return PAGES.find((p) => p.file === file)?.title ?? file;
  }, [file, chatState.threads, classroomId, lessonId]);

  function askDemo(_q: string) {
    setDemoNotice(true);
    setText("");
    window.setTimeout(() => setDemoNotice(false), 4000);
  }

  return (
    <AppShell wide>
      <div className="chat-shell chat-shell-noside">
        <div className="chat-main">
          <div className="lesson-chat-topbar">
            <button type="button" className="chat-sidebar-back" onClick={() => navigate(`/s/c/${classroomId}`)}>
              <img src={angleSmallLeftUrl} alt="" width={20} height={20} />
              <span>กลับไปยัง {classroom.name}</span>
            </button>

            <div className="lesson-chat-lesson">
              <div>
                <p className="chat-lesson-eyebrow">บทที่</p>
                <p className="chat-lesson-name">{lesson.title}</p>
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

            {files.length > 0 && (
              <div className="lesson-chat-nav">
                <button
                  type="button"
                  className="lesson-chat-nav-btn"
                  disabled={clampedIndex === 0}
                  onClick={() => {
                    setIndex((i) => Math.max(0, i - 1));
                    setLoaded(false);
                  }}
                  aria-label="โจทย์ก่อนหน้า"
                >
                  <img src={angleSmallLeftUrl} alt="" width={20} height={20} />
                </button>
                <span className="lesson-chat-nav-title">{title}</span>
                <span className="lesson-chat-nav-count">
                  {clampedIndex + 1} จาก {files.length} โจทย์
                </span>
                <button
                  type="button"
                  className="lesson-chat-nav-btn"
                  disabled={clampedIndex >= files.length - 1}
                  onClick={() => {
                    setIndex((i) => Math.min(files.length - 1, i + 1));
                    setLoaded(false);
                  }}
                  aria-label="โจทย์ถัดไป"
                >
                  <img src={angleSmallRightUrl} alt="" width={20} height={20} />
                </button>
              </div>
            )}
          </div>

          <div className="chat-scroll">
            {!file ? (
              <p className="classroom-empty">บทเรียนนี้ยังไม่มีโจทย์ที่เผยแพร่แล้ว</p>
            ) : (
              <div className="chat-thread">
                <div className="gen-card">
                  <div className="gen-card-head">
                    <span className="gen-card-title">{title}</span>
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
                    <iframe
                      key={file + replayNonce}
                      className="gen-card-frame"
                      src={`${PAGES_URL}/pages/${file}`}
                      title={title}
                      sandbox="allow-scripts"
                      referrerPolicy="no-referrer"
                      onLoad={() => setLoaded(true)}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {file && (
            <div className="lesson-chat-suggested">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button key={q} type="button" className="lesson-chat-chip" onClick={() => askDemo(q)}>
                  {q}
                </button>
              ))}
            </div>
          )}

          {demoNotice && <div className="lesson-chat-demo-notice">โหมดสาธิต: ระบบถาม-ตอบยังไม่เชื่อมกับ AI จริงในสเตจนี้</div>}

          <div className="chat-input-bar">
            <input
              className="chat-input-field"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (text.trim()) askDemo(text.trim());
                }
              }}
              placeholder="พิมพ์โจทย์ที่นี่"
            />
            <button
              type="button"
              className="chat-input-send"
              onClick={() => text.trim() && askDemo(text.trim())}
              disabled={!text.trim()}
              aria-label="ส่ง"
            >
              <img src={sendUrl} alt="" width={20} height={20} />
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
