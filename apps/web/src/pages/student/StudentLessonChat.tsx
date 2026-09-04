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
 * There is no real model behind the suggested questions or the input — they
 * are static demo copy (see the brief's instruction to be honest about that
 * rather than fabricate an answer), so both surface an explicit "demo mode"
 * notice instead of pretending to answer. */
import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { useSession } from "../../lib/session";
import { classroomOf, lessonsOf, useClassroomStore } from "../../lib/classroom";
import { useChatStore, studentVisibleFiles } from "../../lib/chat";
import { api, isLive, pageSrc, type ApiProblem } from "../../lib/api";
import { PAGES } from "../../manifest";
import angleSmallLeftUrl from "../../icons/angle-small-left.svg";
import angleSmallRightUrl from "../../icons/angle-small-right.svg";
import caretDownUrl from "../../icons/caret-down.svg";
import caretRightUrl from "../../icons/caret-right.svg";
import sendUrl from "../../icons/send.svg";

const PAGES_URL = import.meta.env.VITE_PAGES_URL ?? "http://localhost:8080";

const SUGGESTED_QUESTIONS = ["ทำไมต้องหาจุดตัดแกน X?", "จุดยอดหายังไง และทำไมสำคัญ?", "รู้ได้ยังไงว่าคว่ำหรือหงาย"];

interface Item {
  src: string;
  title: string;
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
  const [loaded, setLoaded] = useState(false);
  const [replayNonce, setReplayNonce] = useState(0);
  const [text, setText] = useState("");
  const [demoNotice, setDemoNotice] = useState(false);

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
      return { src, title };
    });
  }, [liveData, lesson, chatState, classroomId, lessonId]);

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
                    setLoaded(false);
                  }}
                  aria-label="โจทย์ก่อนหน้า"
                >
                  <img src={angleSmallLeftUrl} alt="" width={20} height={20} />
                </button>
                <span className="lesson-chat-nav-title">{title}</span>
                <span className="lesson-chat-nav-count">
                  {clampedIndex + 1} จาก {items.length} โจทย์
                </span>
                <button
                  type="button"
                  className="lesson-chat-nav-btn"
                  disabled={clampedIndex >= items.length - 1}
                  onClick={() => {
                    setIndex((i) => Math.min(items.length - 1, i + 1));
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
            {!item ? (
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
                      key={item.src + replayNonce}
                      className="gen-card-frame"
                      src={item.src}
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

          {item && (
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
