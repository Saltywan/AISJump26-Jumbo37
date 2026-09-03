/* Figma: Classroom (node 12:37) — teacher home. Greeting, a primary
   "สร้างห้องเรียน" button, and the list of the signed-in teacher's classrooms.
   There is no "new classroom" screen in the five designed here, so creating
   one is a prompt — the same shortcut the old teacher console uses for
   submitting a problem without a dedicated compose screen. */
import { Navigate, useNavigate } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { Button, Card, PageHeader, SectionTitle } from "../../components/ui";
import { useSession } from "../../lib/session";
import { createClassroom, lessonsOf, useClassroomStore } from "../../lib/classroom";
import plusSmallUrl from "../../icons/plus-small.svg";
import angleSmallRightUrl from "../../icons/angle-small-right.svg";

export default function ClassroomList() {
  const { user } = useSession();
  const navigate = useNavigate();
  const state = useClassroomStore();

  if (!user) return <Navigate to="/login" replace />;

  function handleCreate() {
    const name = window.prompt("ชื่อห้องเรียนใหม่");
    if (!name || !name.trim()) return;
    const description = window.prompt("รายละเอียดห้องเรียน (ไม่บังคับ)") ?? "";
    const classroom = createClassroom(name.trim(), description.trim());
    navigate(`/t/c/${classroom.id}/lessons`);
  }

  return (
    <AppShell>
      <PageHeader
        title={`สวัสดี, ${user.name}`}
        subtitle="จัดการห้องเรียนและสร้างสื่อการสอนด้วย AI"
        action={
          <Button icon={<img src={plusSmallUrl} alt="" width={24} height={24} />} onClick={handleCreate}>
            สร้างห้องเรียน
          </Button>
        }
      />

      <div className="ui-stack">
        <SectionTitle>ห้องเรียนของฉัน</SectionTitle>
        {state.classrooms.length === 0 ? (
          <p className="classroom-empty">ยังไม่มีห้องเรียน กด “สร้างห้องเรียน” เพื่อเริ่มต้น</p>
        ) : (
          state.classrooms.map((c) => (
            <Card
              key={c.id}
              to={`/t/c/${c.id}/lessons`}
              title={c.name}
              meta={`${lessonsOf(state, c.id).length} บทเรียน`}
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
    </AppShell>
  );
}
