/* Figma: Student -- Classroom (node 48:4941), นักเรียน tab — a sortable
   student list with a remove action per row. The design's row action is a
   three-dot glyph, but per spec it behaves as a remove button: click it,
   confirm, and the student is gone (same confirm() pattern the existing
   teacher console uses for its own destructive action). */
import { useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { Classroom } from "../../lib/classroom";
import { removeStudent, studentsOf, useClassroomStore } from "../../lib/classroom";
import avatarUrl from "../../icons/avatar.svg";
import angleSmallUpUrl from "../../icons/angle-small-up.svg";
import angleSmallDownUrl from "../../icons/angle-small-down.svg";
import menuDotsUrl from "../../icons/menu-dots-vertical.svg";

export default function ClassroomStudents() {
  const { classroom } = useOutletContext<{ classroom: Classroom }>();
  const state = useClassroomStore();
  const [sortAsc, setSortAsc] = useState(true);

  const students = useMemo(() => {
    const list = studentsOf(state, classroom.id);
    return list.slice().sort((a, b) => (sortAsc ? a.name.localeCompare(b.name, "th") : b.name.localeCompare(a.name, "th")));
  }, [state, classroom.id, sortAsc]);

  function handleRemove(id: string, name: string) {
    if (window.confirm(`นำ "${name}" ออกจากห้องเรียนนี้?`)) removeStudent(id);
  }

  return (
    <div className="student-table">
      <button
        type="button"
        className="student-table-head"
        onClick={() => setSortAsc((v) => !v)}
        aria-label={`เรียงตามชื่อ - นามสกุล (${sortAsc ? "ก-ฮ" : "ฮ-ก"})`}
      >
        <span>ชื่อ - นามสกุล</span>
        <span className="student-sort-icons">
          <img src={angleSmallUpUrl} alt="" width={16} height={16} className={sortAsc ? "student-sort-active" : ""} />
          <img src={angleSmallDownUrl} alt="" width={16} height={16} className={!sortAsc ? "student-sort-active" : ""} />
        </span>
      </button>

      {students.length === 0 ? (
        <p className="classroom-empty">ยังไม่มีนักเรียนในห้องเรียนนี้</p>
      ) : (
        students.map((s) => (
          <div className="student-row" key={s.id}>
            <div className="student-row-name">
              <img src={avatarUrl} alt="" width={25} height={25} />
              <span>{s.name}</span>
            </div>
            <button
              type="button"
              className="student-remove"
              onClick={() => handleRemove(s.id, s.name)}
              aria-label={`นำ ${s.name} ออกจากห้องเรียน`}
              title="นำออกจากห้องเรียน"
            >
              <img src={menuDotsUrl} alt="" width={16} height={16} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}
