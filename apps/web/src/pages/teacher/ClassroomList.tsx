import { useEffect, useState } from "react";
/* Figma: Classroom (node 12:37) — teacher home. Greeting, a primary
   "สร้างห้องเรียน" button, and the list of the signed-in teacher's classrooms.
   There is no "new classroom" screen in the five designed here, so this opens
   the modal form in components/CreationModals.tsx — see that file for why a
   modal and not a routed page. It replaces two window.prompt() calls that
   used to sit in handleCreate() directly. */
import { Navigate, useNavigate } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { Button, Card, PageHeader, SectionTitle } from "../../components/ui";
import { CreateClassroomModal } from "../../components/CreationModals";
import { useSession } from "../../lib/session";
import { syncSeedToServer, lessonsOf, useClassroomStore } from "../../lib/classroom";
import { useChatStore } from "../../lib/chat";
import plusSmallUrl from "../../icons/plus-small.svg";
import angleSmallRightUrl from "../../icons/angle-small-right.svg";

import { api, isLive, type ApiClassroom } from "../../lib/api";

function useLiveTeacherClassrooms(): ApiClassroom[] | null {
  const [rows, setRows] = useState<ApiClassroom[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (await isLive()) {
        try {
          const classrooms = await api.classrooms();
          if (!cancelled) setRows(classrooms);
          return;
        } catch {
          /* fall through to offline */
        }
      }
      if (!cancelled) setRows(null);
    }
    void load();
    const t = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return rows;
}

export default function ClassroomList() {
  const { user } = useSession();
  const navigate = useNavigate();
  const state = useClassroomStore();
  const live = useLiveTeacherClassrooms();
  const [showCreate, setShowCreate] = useState(false);

  if (!user) return <Navigate to="/login" replace />;

  const threadCount = useChatStore().threads.length;

  useEffect(() => {
    void syncSeedToServer(threadCount > 0);
  }, [threadCount]);

  const classrooms: ApiClassroom[] = live ?? state.classrooms.map((c) => ({
    id: c.id,
    name: c.name,
    subject: c.description || null,
    level: c.level || null,
    lesson_count: lessonsOf(state, c.id).length,
  }));

  return (
    <AppShell>
      <PageHeader
        title={`สวัสดี, ${user.name}`}
        subtitle="จัดการห้องเรียนและสร้างสื่อการสอนด้วย AI"
        action={
          <Button icon={<img src={plusSmallUrl} alt="" width={24} height={24} />} onClick={() => setShowCreate(true)}>
            สร้างห้องเรียน
          </Button>
        }
      />

      <div className="ui-stack">
        <SectionTitle>ห้องเรียนของฉัน</SectionTitle>
        {classrooms.length === 0 ? (
          <p className="classroom-empty">ยังไม่มีห้องเรียน กด “สร้างห้องเรียน” เพื่อเริ่มต้น</p>
        ) : (
          classrooms.map((c) => (
            <Card
              key={c.id}
              to={`/t/c/${c.id}/lessons`}
              title={c.name}
              meta={`${c.lesson_count} บทเรียน`}
              action={
                <span className="ui-btn ui-btn-quiet">
                  ดูบทเรียน
                  <img src={angleSmallRightUrl} alt="" width={16} height={16} />
                </span>
              }
            />
          ))
        )}
      </div>

      {showCreate ? (
        <CreateClassroomModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            navigate(`/t/c/${id}/lessons`);
          }}
        />
      ) : null}
    </AppShell>
  );
}
