/* The header + tab strip shared by all three classroom sub-screens (Figma
   nodes 12:61, 48:4941, 48:5042/60:7009): a back link to the classroom list,
   the classroom name/description with a "สร้างบทเรียน" button, and the
   บทเรียน / นักเรียน / การตั้งค่า tabs. Lives once here rather than being
   copied into each of the three pages.
 *
 * "สร้างบทเรียน" opens components/CreationModals.tsx's CreateLessonModal —
 * see that file for why a modal, not a route — in place of the
 * window.prompt() this used to call directly. */
import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { Button, Tabs } from "../../components/ui";
import { CreateLessonModal } from "../../components/CreationModals";
import { useSession } from "../../lib/session";
import { classroomOf, useClassroomStore, type Classroom } from "../../lib/classroom";
import angleSmallLeftUrl from "../../icons/angle-small-left.svg";
import plusSmallUrl from "../../icons/plus-small.svg";
import { api, isLive } from "../../lib/api";

export type ClassroomTab = "lessons" | "students" | "settings";

const TAB_ITEMS: { key: ClassroomTab; label: string }[] = [
  { key: "lessons", label: "บทเรียน" },
  { key: "students", label: "นักเรียน" },
  { key: "settings", label: "การตั้งค่า" },
];

function useLiveClassroom(classroomId: string): { state: "loading" | "ready" | "error"; data: Classroom | null } {
  const [data, setData] = useState<{ state: "loading" | "ready" | "error"; data: Classroom | null }>({
    state: "loading",
    data: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (await isLive()) {
        try {
          const c = await api.classroom(classroomId);
          if (!cancelled) {
            setData({
              state: "ready",
              data: {
                id: c.id,
                name: c.name,
                description: c.subject || "",
                level: c.level || undefined,
                createdAt: Date.now(),
              },
            });
            return;
          }
        } catch {
          /* fall through to error / local fallback */
        }
      }
      if (!cancelled) setData({ state: "error", data: null });
    }
    void load();
  }, [classroomId]);

  return data;
}

export default function ClassroomLayout() {
  const { user } = useSession();
  const { classroomId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const state = useClassroomStore();
  const localClassroom = classroomOf(state, classroomId);
  const live = useLiveClassroom(classroomId);
  const classroom = live.data ?? localClassroom;

  const [showCreateLesson, setShowCreateLesson] = useState(false);
  const active: ClassroomTab = location.pathname.endsWith("/students")
    ? "students"
    : location.pathname.endsWith("/settings")
      ? "settings"
      : "lessons";

  if (!user) return <Navigate to="/login" replace />;
  if (live.state === "loading" && !localClassroom) {
    return (
      <AppShell>
        <p className="classroom-empty">กำลังโหลด…</p>
      </AppShell>
    );
  }
  if (!classroom) return <Navigate to="/t" replace />;

  return (
    <AppShell>
      <div className="classroom-detail-head">
        <button type="button" className="classroom-back" onClick={() => navigate("/t")}>
          <img src={angleSmallLeftUrl} alt="" width={20} height={20} />
          <span>กลับไปยัง {classroom.name}</span>
        </button>
        <div className="ui-page-header">
          <div className="ui-page-header-text">
            <h1 className="classroom-title">{classroom.name}</h1>
            <p className="ui-page-subtitle">{classroom.description}</p>
          </div>
          <Button icon={<img src={plusSmallUrl} alt="" width={24} height={24} />} onClick={() => setShowCreateLesson(true)}>
            สร้างบทเรียน
          </Button>
        </div>
      </div>

      <Tabs
        items={TAB_ITEMS.map((t) => ({
          key: t.key,
          label: t.label,
          to: `/t/c/${classroomId}/${t.key}`,
          active: t.key === active,
        }))}
      />

      <Outlet context={{ classroom }} />

      {showCreateLesson ? (
        <CreateLessonModal classroomId={classroom.id} onClose={() => setShowCreateLesson(false)} onCreated={() => setShowCreateLesson(false)} />
      ) : null}
    </AppShell>
  );
}
