/* Figma: In Classroom (node 12:61), บทเรียน tab — the classroom's lesson cards.
 *
 * "ดูและสร้างสื่อการสอน" opens the lesson's chat (Figma 35:629 / 35:675), which
 * is where a teacher both creates new material and confirms it before students
 * see it. It used to open the first generated page in the standalone viewer,
 * which left the entire generate-and-confirm flow unreachable from the UI —
 * you could only get to it by typing a URL.
 *
 * The card also says how many drafts are waiting. A generated page that has not
 * been confirmed is invisible to students, so a lesson sitting on unconfirmed
 * drafts looks finished and is not. That belongs in the list, not only inside
 * the chat. */
import { useOutletContext } from "react-router-dom";
import { Card } from "../../components/ui";
import type { Classroom } from "../../lib/classroom";
import { lessonsOf, useClassroomStore } from "../../lib/classroom";
import { threadsOf, useChatStore } from "../../lib/chat";
import angleSmallRightUrl from "../../icons/angle-small-right.svg";

export default function ClassroomLessons() {
  const { classroom } = useOutletContext<{ classroom: Classroom }>();
  const state = useClassroomStore();
  const chat = useChatStore();
  const lessons = lessonsOf(state, classroom.id);

  if (lessons.length === 0) {
    return <p className="classroom-empty">ยังไม่มีบทเรียน กด “สร้างบทเรียน” เพื่อเริ่มต้น</p>;
  }

  return (
    <div className="ui-stack">
      {lessons.map((lesson) => {
        const threads = threadsOf(chat, classroom.id, lesson.id);
        const waiting = threads.filter((t) => t.status === "draft").length;
        const published = threads.filter((t) => t.status === "published").length;
        return (
          <Card
            key={lesson.id}
            to={`/t/c/${classroom.id}/lessons/${lesson.id}/chat`}
            title={lesson.title}
            meta={
              <>
                {lesson.pageFiles.length + published} โจทย์
                {waiting > 0 ? <span className="lesson-waiting">รอยืนยัน {waiting}</span> : null}
              </>
            }
            action={
              <span className="ui-btn ui-btn-quiet">
                ดูและสร้างสื่อการสอน
                <img src={angleSmallRightUrl} alt="" width={16} height={16} />
              </span>
            }
          />
        );
      })}
    </div>
  );
}
