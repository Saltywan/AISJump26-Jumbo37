/* Figma node 60:6926 "Classroom" — student home. Same shell and the same
 * Card/PageHeader/SectionTitle primitives as the teacher's classroom list
 * (src/pages/teacher/ClassroomList.tsx), reading the same classrooms
 * (lib/classroom.ts) — the demo has no enrollment model, so a student sees
 * every seeded classroom. The two differences from the teacher screen are
 * exactly what the brief calls out: no "สร้างห้องเรียน" button, and the card
 * action reads "ดูบทเรียน" instead of "ดูและสร้างสื่อการสอน". */
import { Navigate } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { Card, PageHeader, SectionTitle } from "../../components/ui";
import { useSession } from "../../lib/session";
import { lessonsOf, useClassroomStore } from "../../lib/classroom";
import angleSmallRightUrl from "../../icons/angle-small-right.svg";

export default function StudentClassrooms() {
  const { user } = useSession();
  const state = useClassroomStore();

  if (!user) return <Navigate to="/login" replace />;

  return (
    <AppShell>
      <PageHeader title={`สวัสดี, ${user.name}`} subtitle="เลือกห้องเรียนเพื่อเริ่มเรียนรู้และทบทวนบทเรียน" />

      <div className="ui-stack">
        <SectionTitle>ห้องเรียนของฉัน</SectionTitle>
        {state.classrooms.length === 0 ? (
          <p className="classroom-empty">ยังไม่มีห้องเรียน</p>
        ) : (
          state.classrooms.map((c) => (
            <Card
              key={c.id}
              to={`/s/c/${c.id}`}
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
