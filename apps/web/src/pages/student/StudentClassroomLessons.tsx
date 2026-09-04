/* Figma node 48:6250 "In Classroom" — the lesson list for one classroom, from
 * the student's side. Structurally identical to what the teacher's
 * ClassroomLayout ("บทเรียน" tab) shows, minus the two things the brief
 * calls out as student-only differences: no tab strip (บทเรียน/นักเรียน/
 * การตั้งค่า — those are teacher management, not something a student needs),
 * and no "สร้างบทเรียน" button. The card action label
 * ("ดูและสร้างสื่อการสอน") is kept exactly as drawn in this frame in Figma —
 * see the brief's instruction to copy UI text from the design rather than
 * editorialise it.
 *
 * When the backend is up this reads GET /classrooms/{id}/lessons?published_only=true
 * (see lib/api.ts) — a lesson the teacher has not published is not merely
 * hidden here, it is absent from the response, which is the confirmation
 * gate actually taking effect server-side rather than a rule this component
 * happens to apply. Falls back to the local seed (lib/classroom.ts's
 * pageFiles plus anything lib/chat.ts's studentVisibleFiles() has locally
 * published) when the backend is down or this classroomId is unknown to it —
 * the single-machine, no-server demo path. */
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { Card } from "../../components/ui";
import { useSession } from "../../lib/session";
import { classroomOf, lessonsOf, useClassroomStore } from "../../lib/classroom";
import { useChatStore, studentVisibleFiles } from "../../lib/chat";
import { api, isLive } from "../../lib/api";
import angleSmallLeftUrl from "../../icons/angle-small-left.svg";
import angleSmallRightUrl from "../../icons/angle-small-right.svg";

interface LiveLesson {
  id: string;
  title: string;
  problem_count: number;
}

type LiveState = "loading" | { name: string; lessons: LiveLesson[] } | null;

/** Live classroom name (for the header) plus its published lessons. Both come
 *  from the API in one poll so the two never disagree about which classroom
 *  they describe.
 *
 * Three states, not two — this used to start at `null` and a caller that
 * treats "no live data (yet)" the same as "confirmed offline" redirects a
 * student away from a perfectly good, still-loading classroom on every first
 * render, before the fetch below has had a chance to finish: exactly the
 * two-device case this pass exists to fix, broken a different way. "loading"
 * means "don't decide yet"; `null` means the check actually completed and
 * came back empty — backend down, or this id is one the server has never
 * heard of (a local-only seed id on a browser that hasn't synced — see
 * lib/classroom.ts) — only then should the caller fall back to it. */
function useLiveClassroomLessons(classroomId: string): LiveState {
  const [data, setData] = useState<LiveState>("loading");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (await isLive()) {
        try {
          const [classrooms, lessons] = await Promise.all([api.classrooms(), api.lessons(classroomId, true)]);
          const match = classrooms.find((c) => c.id === classroomId);
          if (!cancelled && match) {
            setData({ name: match.name, lessons });
            return;
          }
        } catch {
          /* fall through to offline */
        }
      }
      if (!cancelled) setData(null);
    }
    void load();
    const t = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [classroomId]);

  return data;
}

export default function StudentClassroomLessons() {
  const { user } = useSession();
  const { classroomId = "" } = useParams();
  const navigate = useNavigate();
  const classroomState = useClassroomStore();
  const chatState = useChatStore();
  const live = useLiveClassroomLessons(classroomId);

  if (!user) return <Navigate to="/login" replace />;
  const localClassroom = classroomOf(classroomState, classroomId);
  const liveData = live === "loading" ? null : live;

  // Only bail out once the live check has actually finished (or there was
  // never a backend to check) — while it's still in flight, wait rather than
  // guess this classroom doesn't exist. See useLiveClassroomLessons's comment
  // for the redirect-on-every-first-render bug this replaced.
  if (live === "loading" && !localClassroom) {
    return (
      <AppShell>
        <p className="classroom-empty">กำลังโหลด…</p>
      </AppShell>
    );
  }
  if (!liveData && !localClassroom) return <Navigate to="/s" replace />;

  const name = liveData?.name ?? localClassroom!.name;
  const rows: { id: string; title: string; count: number }[] = liveData
    ? liveData.lessons.map((l) => ({ id: l.id, title: l.title, count: l.problem_count }))
    : lessonsOf(classroomState, classroomId).map((l) => ({
        id: l.id,
        title: l.title,
        count: studentVisibleFiles(chatState, classroomId, l.id, l.pageFiles).length,
      }));

  return (
    <AppShell>
      <div className="classroom-detail-head">
        <button type="button" className="classroom-back" onClick={() => navigate("/s")}>
          <img src={angleSmallLeftUrl} alt="" width={20} height={20} />
          <span>กลับไปยัง {name}</span>
        </button>
        <h1 className="classroom-title">{name}</h1>
        {localClassroom && <p className="ui-page-subtitle">{localClassroom.description}</p>}
      </div>

      <div className="ui-stack">
        {rows.length === 0 ? (
          <p className="classroom-empty">ยังไม่มีบทเรียนในห้องนี้</p>
        ) : (
          rows.map((l) => (
            <Card
              key={l.id}
              to={`/s/c/${classroomId}/lessons/${l.id}`}
              title={l.title}
              meta={`${l.count} โจทย์`}
              action={
                <span className="ui-btn ui-btn-quiet">
                  ดูและสร้างสื่อการสอน
                  <img src={angleSmallRightUrl} alt="" width={16} height={16} />
                </span>
              }
            />
          ))
        )}
      </div>
    </AppShell>
  );
}
