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
 * The lesson count shown uses studentVisibleFiles() (lib/chat.ts), not the
 * lesson's raw pageFiles.length, so a page a teacher has since published from
 * the Chat screen (35:675) is reflected here too. */
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { Card } from "../../components/ui";
import { useSession } from "../../lib/session";
import { classroomOf, lessonsOf, useClassroomStore } from "../../lib/classroom";
import { useChatStore, studentVisibleFiles } from "../../lib/chat";
import angleSmallLeftUrl from "../../icons/angle-small-left.svg";
import angleSmallRightUrl from "../../icons/angle-small-right.svg";

export default function StudentClassroomLessons() {
  const { user } = useSession();
  const { classroomId = "" } = useParams();
  const navigate = useNavigate();
  const classroomState = useClassroomStore();
  const chatState = useChatStore();

  if (!user) return <Navigate to="/login" replace />;
  const classroom = classroomOf(classroomState, classroomId);
  if (!classroom) return <Navigate to="/s" replace />;

  const lessons = lessonsOf(classroomState, classroomId);

  return (
    <AppShell>
      <div className="classroom-detail-head">
        <button type="button" className="classroom-back" onClick={() => navigate("/s")}>
          <img src={angleSmallLeftUrl} alt="" width={20} height={20} />
          <span>กลับไปยัง {classroom.name}</span>
        </button>
        <h1 className="classroom-title">{classroom.name}</h1>
        <p className="ui-page-subtitle">{classroom.description}</p>
      </div>

      <div className="ui-stack">
        {lessons.length === 0 ? (
          <p className="classroom-empty">ยังไม่มีบทเรียนในห้องนี้</p>
        ) : (
          lessons.map((l) => {
            const files = studentVisibleFiles(chatState, classroomId, l.id, l.pageFiles);
            return (
              <Card
                key={l.id}
                to={`/s/c/${classroomId}/lessons/${l.id}`}
                title={l.title}
                meta={`${files.length} โจทย์`}
                action={
                  <span className="ui-btn ui-btn-quiet">
                    ดูและสร้างสื่อการสอน
                    <img src={angleSmallRightUrl} alt="" width={16} height={16} />
                  </span>
                }
              />
            );
          })
        )}
      </div>
    </AppShell>
  );
}
